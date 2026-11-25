import type { BuildOptions } from 'vite';

export const rejectUnsupportedBrowserBuiltins: NonNullable<BuildOptions['rollupOptions']> = {
    onwarn(warning, warn) {
        // Vite warns for real builtin misses. An explicit browser:false package
        // mapping silently resolves to the empty __vite-browser-external module.
        if (warning.plugin === 'vite:resolve' && warning.message.includes('has been externalized for browser compatibility')) {
            throw new Error(warning.message);
        }
        warn(warning);
    },
    external: id => id.startsWith('node:'),
};

export function isUnsupportedBrowserBuiltin(id: string): boolean {
    return id.startsWith('node:') || id.includes('__vite-browser-external:');
}
