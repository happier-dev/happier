import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { expect, it } from 'vitest';

import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';

const appRequire = createRequire(import.meta.url);

it('parses a native SVG preview after the public SVG components have registered', async () => {
    // Vitest normally selects the CommonJS SVG entry. Metro selects its react-native
    // entry, so evaluate the installed native graph and preserve its module identities.
    // Only native SDK adapters are replaced; the parser, elements and RN registry are real.
    const svgRoot = dirname(appRequire.resolve('react-native-svg/package.json'));
    const nativeRoot = dirname(appRequire.resolve('react-native/package.json'));
    const svgPackage = JSON.parse(readFileSync(join(svgRoot, 'package.json'), 'utf8')) as { 'react-native': string };
    const modules = new Map<string, { exports: unknown }>();
    const native = await createReactNativeNativeMock({ platformOS: 'ios' });
    const registryPath = join(nativeRoot, 'Libraries/Renderer/shims/ReactNativeViewConfigRegistry.js');
    const codegenPath = join(nativeRoot, 'Libraries/Utilities/codegenNativeComponent.js');
    const requireNativeComponentPath = join(nativeRoot, 'Libraries/ReactNative/requireNativeComponent.js');
    const uiManagerPath = join(nativeRoot, 'Libraries/ReactNative/UIManager.js');

    function resolveLocal(request: string, parent: string): string {
        const path = resolve(dirname(parent), request);
        const candidates = [path, ...['.ios.tsx', '.ios.ts', '.native.tsx', '.native.ts', '.tsx', '.ts', '.js'].map(ext => path + ext),
            ...['index.ts', 'index.tsx', 'index.js'].map(file => join(path, file))];
        const found = candidates.find(candidate => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
        if (!found) throw new Error(`Cannot resolve ${request} from ${parent}`);
        return found;
    }

    function load(filename: string): unknown {
        if (filename === uiManagerPath) return { hasViewManagerConfig: () => true };
        if (filename === requireNativeComponentPath) {
            return { __esModule: true, default: (name: string) => {
                const registry = load(registryPath) as { register: (name: string, callback: () => object) => string };
                return registry.register(name, () => ({ uiViewClassName: name }));
            } };
        }
        const cached = modules.get(filename);
        if (cached) return cached.exports;
        const module = { exports: {} as unknown };
        modules.set(filename, module);
        const isTypeScript = /\.tsx?$/.test(filename);
        const transformed = transformSync(readFileSync(filename, 'utf8'), {
            filename, babelrc: false, configFile: false,
            plugins: [
                isTypeScript
                    ? [appRequire.resolve('@babel/plugin-transform-typescript'), { isTSX: true, allExtensions: true }]
                    : appRequire.resolve('@babel/plugin-transform-flow-strip-types'),
                appRequire.resolve('@babel/plugin-transform-react-jsx'),
                appRequire.resolve('@babel/plugin-transform-modules-commonjs'),
            ],
        });
        if (!transformed?.code) throw new Error(`Cannot compile ${filename}`);
        const localRequire = (request: string): unknown => {
            if (request === 'react-native') return native;
            if (request === 'react-native/Libraries/Utilities/codegenNativeComponent') return load(codegenPath);
            if (request === 'react-native/Libraries/Utilities/codegenNativeCommands') return { __esModule: true, default: () => ({}) };
            if (request === 'react-native-svg') return load(join(svgRoot, svgPackage['react-native']));
            if (request.startsWith('react-native-svg/')) return load(appRequire.resolve(request));
            if (request.startsWith('.')) return load(resolveLocal(request, filename));
            return appRequire(request);
        };
        // This is an untyped CommonJS evaluation boundary; exported values are narrowed at callers.
        const evaluate = new Function('require', 'module', 'exports', '__DEV__', 'global', transformed.code);
        evaluate(localRequire, module, module.exports, false, globalThis);
        return module.exports;
    }

    const svg = load(join(svgRoot, svgPackage['react-native'])) as { Circle: unknown };
    expect(svg.Circle).toBeDefined();
    const owner = load(fileURLToPath(new URL('./SafeNativeSvgXml.tsx', import.meta.url))) as typeof import('./SafeNativeSvgXml');
    expect(owner.parseSafeNativeSvgXml('<svg><circle cx="8" cy="8" r="4"/></svg>')).not.toBeNull();
});
