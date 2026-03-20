import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Change 'orghub' to your actual GitHub repo name
  base: process.env.VITE_BASE_PATH || '/',
})
