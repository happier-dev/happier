import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { transformFromAstSync, transformSync } from '@babel/core';
import { expect, it, vi } from 'vitest';

import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';
import * as logging from '@/log';
import * as text from '@/text';
import * as uuid from '@/platform/randomUUID';

// Use Expo's actual Metro transform/runtime: Vitest's react-native-web alias does
// not reproduce Metro importAll eagerly evaluating React Native's lazy exports.
const appRequire = createRequire(import.meta.url);
const metroRequire = createRequire(appRequire.resolve('expo/metro-config'));
const { importExportPlugin, addParamsToDefineCall } = metroRequire('metro-transform-plugins');
const collectDependencies = metroRequire('metro/private/ModuleGraph/worker/collectDependencies').default;
const { wrapModule } = metroRequire('metro/private/ModuleGraph/worker/JsFileWrapping');

it('hands an iOS cache file to the share sheet without loading unrelated native modules', async () => {
    const context = createContext({ console, TextEncoder, __DEV__: false, __METRO_GLOBAL_PREFIX__: '' });
    context.global = context;
    runInContext(readFileSync(metroRequire.resolve('metro-runtime/polyfills/require'), 'utf8'), context);

    const ids = new Map<string, number>();
    const moduleId = (name: string) => {
        if (!ids.has(name)) ids.set(name, ids.size);
        return ids.get(name)!;
    };
    const define = runInContext('__d', context) as (
        factory: (global: unknown, require: unknown, importDefault: unknown, importAll: unknown, module: { exports: unknown }) => void,
        id: number,
        dependencies: number[],
    ) => void;
    const boundary = (name: string, exports: object) => {
        define((_global, _require, _importDefault, _importAll, module) => { module.exports = exports; }, moduleId(name), []);
    };
    const compile = (name: string, source: string, filename: string) => {
        const transformed = transformSync(source, {
            filename, babelrc: false, configFile: false, ast: true, code: false,
            plugins: [appRequire.resolve('@babel/plugin-transform-typescript'), [importExportPlugin, {
                importDefault: '_importDefault', importAll: '_importAll',
            }]],
        });
        if (!transformed?.ast) throw new Error('Expected transformed module');
        const collected = collectDependencies(transformed.ast, {
            asyncRequireModulePath: 'metro-runtime/modules/asyncRequire',
            dynamicRequires: 'reject', inlineableCalls: ['_importDefault', '_importAll'],
            keepRequireNames: false,
        }) as { ast: NonNullable<typeof transformed.ast>; dependencyMapName: string; dependencies: { name: string }[] };
        const wrapped = wrapModule(collected.ast, '_importDefault', '_importAll', collected.dependencyMapName, '');
        const code = transformFromAstSync(wrapped.ast, undefined, { babelrc: false, configFile: false })?.code;
        if (!code) throw new Error('Expected wrapped module');
        runInContext(addParamsToDefineCall(code, moduleId(name), collected.dependencies.map(dep => moduleId(dep.name))), context);
    };

    const { Platform } = await createReactNativeNativeMock({ platformOS: 'ios' });
    // A CommonJS lazy getter matches RN 0.81.5 index.js. On affected iOS builds,
    // PushNotificationIOS constructs NativeEventEmitter with an absent module.
    const unrelatedModule = vi.fn(() => { throw new Error('`new NativeEventEmitter()` requires a non-null argument.'); });
    boundary('react-native', { Platform, get PushNotificationIOS() { return unrelatedModule(); } });
    const shareAsync = vi.fn(async () => {});
    boundary('expo-sharing', { __esModule: true, isAvailableAsync: async () => true, shareAsync });
    boundary('@/log', logging);
    boundary('@/text', text);
    boundary('@/platform/randomUUID', uuid);
    const asyncRequirePath = metroRequire.resolve('metro-runtime/modules/asyncRequire');
    compile('metro-runtime/modules/asyncRequire', readFileSync(asyncRequirePath, 'utf8'), asyncRequirePath);
    const ownerPath = new URL('./nativeCacheFileSink.ts', import.meta.url);
    compile('fileSink', readFileSync(ownerPath, 'utf8'), fileURLToPath(ownerPath));
    const owner = runInContext(`__r(${moduleId('fileSink')})`, context) as typeof import('./nativeCacheFileSink');

    await expect(owner.shareNativeCacheFile({ fileUri: 'file:///cache/report.json', name: 'report.json' }))
        .resolves.toEqual({ status: 'shared', retainCacheFile: false });
    expect(shareAsync).toHaveBeenCalledWith('file:///cache/report.json', {});
    expect(unrelatedModule).not.toHaveBeenCalled();
});
