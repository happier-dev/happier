import type { Config } from 'tailwindcss';

// Tokens mirrored from apps/ui/sources/theme.ts.
// Keep this file in sync manually when theme.ts changes.
const config: Config = {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: [
                    'Inter',
                    'ui-sans-serif',
                    'system-ui',
                    '-apple-system',
                    'BlinkMacSystemFont',
                    'Segoe UI',
                    'Roboto',
                    'sans-serif',
                ],
                display: [
                    'Bricolage Grotesque',
                    'Inter',
                    'ui-sans-serif',
                    'system-ui',
                    'sans-serif',
                ],
                mono: [
                    'IBM Plex Mono',
                    'ui-monospace',
                    'SFMono-Regular',
                    'Menlo',
                    'Monaco',
                    'Consolas',
                    'monospace',
                ],
            },
            colors: {
                // From theme.ts — accent palette
                accent: {
                    blue: '#007AFF',
                    green: '#34C759',
                    orange: '#FF9500',
                    yellow: '#FFCC00',
                    red: '#FF3B30',
                    indigo: '#5856D6',
                    purple: '#AF52DE',
                },
                // Permission palette
                permission: {
                    allow: '#34C759',
                    deny: '#FF3B30',
                    allowAll: '#007AFF',
                    readOnly: '#8B8B8D',
                    safeYolo: '#FF6B35',
                    yolo: '#DC143C',
                    plan: '#34C759',
                    bypass: '#FF9500',
                },
                // Status
                status: {
                    connected: '#34C759',
                    connecting: '#007AFF',
                    actionRequired: '#FF9500',
                    disconnected: '#999999',
                    error: '#FF3B30',
                },
                // Diff palette (GitHub-style, from theme.ts)
                diff: {
                    added: '#E6FFED',
                    addedBorder: '#34D058',
                    removed: '#FFEEF0',
                    removedBorder: '#D73A49',
                    hunkHeader: '#F1F8FF',
                    hunkHeaderText: '#005CC5',
                    inlineAdded: '#ACFFA6',
                    inlineRemoved: '#FFCECB',
                    lineNumber: '#959DA5',
                },
                // User message background (Anthropic-style warm off-white from theme.ts)
                userMessage: '#f0eee6',
            },
            borderRadius: {
                // From theme.ts sharedSpacing.borderRadius
                'token-sm': '4px',
                'token-md': '8px',
                'token-lg': '10px',
                'token-xl': '12px',
                'token-modal': '14px',
                'token-xxl': '16px',
            },
            spacing: {
                // From theme.ts sharedSpacing.margins
                'token-xs': '4px',
                'token-sm': '8px',
                'token-md': '12px',
                'token-lg': '16px',
                'token-xl': '20px',
                'token-xxl': '24px',
            },
            boxShadow: {
                // Shadow levels mirrored from shadowElevation.ts
                'level-1': '0 2px 8px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.06)',
                'level-2': '0 2px 10px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.08)',
                'level-3': '0 8px 24px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.1)',
                'level-4': '0 16px 40px rgba(0, 0, 0, 0.12), 0 8px 20px rgba(0, 0, 0, 0.14)',
                'level-5': '0 32px 64px rgba(0, 0, 0, 0.16), 0 16px 32px rgba(0, 0, 0, 0.18)',
                // Custom device-frame shadows
                'device-active':
                    '0 32px 64px -16px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
                'device-inactive':
                    '0 16px 32px -12px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.2)',
            },
            keyframes: {
                'pulse-sync': {
                    '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
                    '50%': { opacity: '1', transform: 'scale(1.25)' },
                },
                grain: {
                    '0%, 100%': { transform: 'translate(0, 0)' },
                    '10%': { transform: 'translate(-2%, -2%)' },
                    '30%': { transform: 'translate(3%, 1%)' },
                    '50%': { transform: 'translate(-1%, 2%)' },
                    '70%': { transform: 'translate(2%, -3%)' },
                    '90%': { transform: 'translate(-3%, 1%)' },
                },
            },
            animation: {
                'pulse-sync': 'pulse-sync 2.5s ease-in-out infinite',
                grain: 'grain 8s steps(10) infinite',
            },
        },
    },
    plugins: [],
};

export default config;
