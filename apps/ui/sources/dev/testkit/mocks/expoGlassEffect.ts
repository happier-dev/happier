import { createRequire } from 'node:module';
import * as React from 'react';

/** Native SDK boundary loaded through CommonJS, like the existing expo-blur stub. */
export function installExpoGlassEffectRequireStub(options: Readonly<{ isAvailable: () => boolean }>): () => void {
    const nodeRequire = createRequire(import.meta.url);
    const resolved = nodeRequire.resolve('expo-glass-effect');
    const previous = nodeRequire.cache[resolved];
    const GlassView = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('GlassView', props, children);
    nodeRequire.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: {
            GlassView,
            isLiquidGlassAvailable: options.isAvailable,
            isGlassEffectAPIAvailable: options.isAvailable,
        },
    } as NodeJS.Module;
    return () => {
        if (previous) nodeRequire.cache[resolved] = previous;
        else delete nodeRequire.cache[resolved];
    };
}
