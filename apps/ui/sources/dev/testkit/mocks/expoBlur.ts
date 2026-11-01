import { createRequire } from 'node:module';
import * as React from 'react';

/**
 * Native SDK boundary stub for `expo-blur`.
 *
 * App code loads `expo-blur` lazily through CommonJS `require` (see
 * `components/ui/glass/blurMaterial.ts`), which `vi.mock` does not intercept, and the real package
 * cannot load under Node. Without this stub every native blur path silently resolves to "module
 * unavailable", so a test could never observe whether a `BlurView` would mount. Seeding Node's
 * require cache makes the lazy `require('expo-blur')` return a host `BlurView` that tests can find
 * by type. Install before the code under test first loads the module; the returned function
 * restores the previous cache entry.
 */
export function installExpoBlurRequireStub(): () => void {
    const nodeRequire = createRequire(import.meta.url);
    const resolved = nodeRequire.resolve('expo-blur');
    const previous = nodeRequire.cache[resolved];
    const BlurView = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children);

    nodeRequire.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { BlurView },
    } as NodeJS.Module;

    return () => {
        if (previous) {
            nodeRequire.cache[resolved] = previous;
        } else {
            delete nodeRequire.cache[resolved];
        }
    };
}
