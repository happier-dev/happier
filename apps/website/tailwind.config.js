/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                display: ['"Inter Tight"', 'Inter', 'system-ui', 'sans-serif'],
                sans: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
            },
            colors: {
                ink: {
                    DEFAULT: '#0A0A0B',
                    50: '#F8F8FA',
                    100: '#EFEFF2',
                    200: '#D9D9E0',
                    300: '#B3B3BD',
                    400: '#7F7F8A',
                    500: '#4B4B55',
                    600: '#2A2A30',
                    700: '#1A1A1F',
                    800: '#111114',
                    900: '#0A0A0B',
                },
                accent: {
                    sun: '#F5B547',
                    coral: '#E76F4A',
                    blue: '#5187FF',
                    indigo: '#4458C9',
                },
            },
            letterSpacing: {
                tightest: '-0.04em',
                tighterer: '-0.025em',
            },
            backgroundImage: {
                'hero-dark': "url('/images/background5_black_jpg60.jpg')",
                'hero-light': "url('/images/background5_white_jpg60.jpg')",
            },
        },
    },
    plugins: [],
};
