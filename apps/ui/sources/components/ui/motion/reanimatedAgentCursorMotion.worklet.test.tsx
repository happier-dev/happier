import * as React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createReanimatedModuleMock } from '@/dev/testkit/mocks/reanimated';
import * as motion from './reanimatedMotionTokens';

type CursorDriver = typeof import('./reanimatedAgentCursorMotion').reanimatedAgentCursorMotion;
const appRequire = createRequire(import.meta.url);

it('reports only a finished cursor fade after its callback crosses to the UI runtime', async () => {
    const filename = fileURLToPath(new URL('./reanimatedAgentCursorMotion.tsx', import.meta.url));
    const appRoot = resolve(dirname(filename), '../../../..');
    const compiled = transformSync(readFileSync(filename, 'utf8'), {
        filename, cwd: appRoot, babelrc: false, configFile: join(appRoot, 'babel.config.js'),
        caller: { name: 'metro', platform: 'ios', engine: 'hermes', isDev: true, supportsStaticESM: false },
        plugins: [appRequire.resolve('@babel/plugin-transform-modules-commonjs')],
    });
    if (!compiled?.code) throw new Error('Could not compile the agent cursor motion');
    const callbacks: Array<(finished?: boolean) => void> = [];
    const platform = createReanimatedModuleMock();
    const animationBoundary = {
        ...platform,
        withTiming: <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void): T => {
            if (callback) callbacks.push(callback);
            return value;
        },
    };
    const module = { exports: {} as { reanimatedAgentCursorMotion: CursorDriver } };
    // Render the real compiled hook; React and the native animation SDK are system boundaries.
    new Function('require', 'module', 'exports', compiled.code)((request: string): unknown => {
        if (request === 'react') return React;
        if (request === 'react-native-reanimated') return animationBoundary;
        if (request === './reanimatedMotionTokens') return motion;
        if (request.startsWith('@babel/runtime/') || request === 'react/jsx-dev-runtime' || request === 'react/jsx-runtime') {
            return appRequire(request);
        }
        throw new Error(`Unexpected agent cursor dependency: ${request}`);
    }, module, module.exports);
    const hook = await renderHook(() => module.exports.reanimatedAgentCursorMotion.useMotion());
    const done = vi.fn();
    // The no-target Browser cursor fades from zero to zero, so native valueSetter may complete it immediately.
    hook.getCurrent().fade('pointer', 0, 'exit', done);
    expect(callbacks).toHaveLength(1);

    const unpackerFile = join(dirname(appRequire.resolve('react-native-worklets/package.json')), 'src/memory/valueUnpacker.native.ts');
    const unpacker = transformSync(readFileSync(unpackerFile, 'utf8'), {
        filename: unpackerFile, babelrc: false, configFile: false,
        plugins: [
            appRequire.resolve('@babel/plugin-transform-typescript'),
            appRequire.resolve('@babel/plugin-transform-modules-commonjs'),
        ],
    });
    if (!unpacker?.code) throw new Error('Could not compile the installed UI unpacker');
    // The installed SDK reconstructs a worklet, or rejects a plain JS callback as native does.
    const unpack = runInNewContext(
        `${unpacker.code}\n__installUnpacker(); globalThis.__valueUnpacker;`,
        { exports: {} },
    ) as (value: unknown, category: string) => (finished: boolean) => void;
    const completeOnUI = unpack(callbacks[0], 'RemoteFunction');
    completeOnUI(false);
    expect(done).not.toHaveBeenCalled();
    completeOnUI(true);
    expect(done).toHaveBeenCalledOnce();
});
