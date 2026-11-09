import * as React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createReanimatedModuleMock } from '@/dev/testkit/mocks/reanimated';
import * as motion from '@/components/ui/motion/motionTokens';

type Flash = ReturnType<typeof import('../../ui/useTreeDropFlashHighlight').useTreeDropFlashHighlight>;
const appRequire = createRequire(import.meta.url);

it('starts an outline flash when its trigger crosses to the UI runtime', async () => {
    const filename = fileURLToPath(new URL('../../ui/useTreeDropFlashHighlight.ts', import.meta.url));
    const compiled = transformSync(readFileSync(filename, 'utf8'), {
        filename, babelrc: false, configFile: false,
        plugins: [
            appRequire.resolve('@babel/plugin-transform-typescript'),
            appRequire.resolve('@babel/plugin-transform-modules-commonjs'),
            [appRequire.resolve('react-native-worklets/plugin'), { bundleMode: false }],
        ],
    });
    if (!compiled?.code) throw new Error('Could not compile the flash hook');
    const platform = createReanimatedModuleMock();
    const module = { exports: {} as { useTreeDropFlashHighlight: () => Flash } };
    const requireBoundary = (request: string): unknown => {
        if (request === 'react') return React;
        if (request === 'react-native-reanimated') return platform;
        if (request === '@/components/ui/motion/motionTokens') return motion;
        throw new Error(`Unexpected flash hook dependency: ${request}`);
    };
    // Evaluate the production Babel output with only the native animation SDK replaced.
    new Function('require', 'module', 'exports', compiled.code)(requireBoundary, module, module.exports);
    let flash: Flash | undefined;
    function CaptureFlash() {
        flash = module.exports.useTreeDropFlashHighlight();
        return null;
    }
    await renderScreen(<CaptureFlash />);
    if (!flash) throw new Error('Flash hook did not render');

    // Use the installed SDK's real UI-side unpacker. Its native bridge supplies the
    // RemoteFunction category for ordinary JS callbacks; worklet metadata takes precedence.
    const workletsRoot = dirname(appRequire.resolve('react-native-worklets/package.json'));
    const unpackerFile = join(workletsRoot, 'src/memory/valueUnpacker.native.ts');
    const unpacker = transformSync(readFileSync(unpackerFile, 'utf8'), {
        filename: unpackerFile, babelrc: false, configFile: false,
        plugins: [
            appRequire.resolve('@babel/plugin-transform-typescript'),
            appRequire.resolve('@babel/plugin-transform-modules-commonjs'),
        ],
    });
    if (!unpacker?.code) throw new Error('Could not compile the installed UI unpacker');
    // This VM is the external UI runtime boundary; the SDK performs reconstruction itself.
    const unpack = runInNewContext(
        `${unpacker.code}\n__installUnpacker(); globalThis.__valueUnpacker;`,
        { exports: {} },
    ) as (value: unknown, category: string) => () => void;
    const uiTrigger = unpack(flash.trigger, 'RemoteFunction');
    uiTrigger();
    expect(flash.progress.value).toBe(1);
});
