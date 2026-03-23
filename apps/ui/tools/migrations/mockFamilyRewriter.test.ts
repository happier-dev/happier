import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { rewriteInlineMockFamilies } from './mockFamilyRewriter';

describe('rewriteInlineMockFamilies', () => {
    it('rewrites safe text translators to the canonical text testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/text', () => ({",
            '    t: (key: string, vars?: Record<string, unknown>) => {',
            "        if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;",
            '        return key;',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'text.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'text',
                target: '@/text',
            },
        ]);
        expect(result.text).toContain("const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');");
        expect(result.text).toContain('return createTextModuleMock({');
        expect(result.text).toContain('translate: (key: string, vars?: Record<string, unknown>) => {');
        expect(result.text).toContain("if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;");
    });

    it('does not rewrite text translators that capture undeclared identifiers', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/text', () => ({",
            '    t: (key: string) => `${translationPrefix}:${key}`,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'customText.test.ts' });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites text translators that only use well-known globals like JSON', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/text', () => ({",
            '    t: (key: string, params?: Record<string, unknown>) => (',
            '        params ? `${key}:${JSON.stringify(params)}` : key',
            '    ),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'jsonText.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'text',
                target: '@/text',
            },
        ]);
        expect(result.text).toContain('JSON.stringify(params)');
        expect(result.text).toContain('return createTextModuleMock({');
        expect(result.text).toContain('translate: (key: string, params?: Record<string, unknown>) => (');
    });

    it('rewrites text mocks with tLoose and getPreferredLanguage helpers', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/text', () => ({",
            '    t: (key: string) => key,',
            '    tLoose: (key: string) => `loose:${key}`,',
            "    getPreferredLanguage: () => 'de',",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'textLoose.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'text',
                target: '@/text',
            },
        ]);
        expect(result.text).toContain('translate: (key: string) => key,');
        expect(result.text).toContain('translateLoose: (key: string) => `loose:${key}`,');
        expect(result.text).toContain("getPreferredLanguage: () => 'de',");
    });

    it('rewrites alert-only modal mocks to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/modal', () => ({",
            '    Modal: {',
            '        alert: vi.fn(),',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modal.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('return createModalModuleMock().module;');
    });

    it('rewrites modal mocks with custom alert and prompt spies to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const modalAlertSpy = vi.fn();',
            'const promptSpy = vi.fn();',
            "vi.mock('@/modal', () => ({",
            '    Modal: {',
            '        alert: (...args: any[]) => modalAlertSpy(...args),',
            '        prompt: promptSpy,',
            '        confirm: vi.fn(),',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modalOverrides.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('return createModalModuleMock({');
        expect(result.text).toContain('alert: (...args: any[]) => modalAlertSpy(...args),');
        expect(result.text).toContain('prompt: promptSpy,');
    });

    it('rewrites modal mocks that include alertAsync to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const alertSpy = vi.fn(async () => {});',
            'const alertAsyncSpy = vi.fn(async () => {});',
            "vi.mock('@/modal', () => ({",
            '    Modal: {',
            '        alert: alertSpy,',
            '        alertAsync: alertAsyncSpy,',
            '        prompt: vi.fn(async () => null),',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modalAlertAsync.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('alertAsync: alertAsyncSpy,');
        expect(result.text).toContain('prompt: vi.fn(async () => null),');
    });

    it('rewrites modal alias object mocks to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const modalMocks = vi.hoisted(() => ({',
            '    alert: vi.fn(),',
            '    alertAsync: vi.fn(async () => {}),',
            '}));',
            "vi.mock('@/modal', () => ({",
            '    Modal: modalMocks,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modalAliasObject.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('spies: modalMocks,');
    });

    it('rewrites modal mocks with hide and update spies to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const modalShowMock = vi.fn();',
            'const modalHideMock = vi.fn();',
            'const modalUpdateMock = vi.fn();',
            'const modalConfirmMock = vi.fn();',
            "vi.mock('@/modal', () => ({",
            '    Modal: {',
            '        show: (...args: unknown[]) => modalShowMock(...args),',
            '        hide: (...args: unknown[]) => modalHideMock(...args),',
            '        update: (...args: unknown[]) => modalUpdateMock(...args),',
            '        confirm: (...args: unknown[]) => modalConfirmMock(...args),',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modalUpdate.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('show: (...args: unknown[]) => modalShowMock(...args),');
        expect(result.text).toContain('hide: (...args: unknown[]) => modalHideMock(...args),');
        expect(result.text).toContain('update: (...args: unknown[]) => modalUpdateMock(...args),');
    });

    it('rewrites modal mocks with shorthand show spies to the canonical modal testkit factory', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const show = vi.fn();',
            "vi.mock('@/modal', () => ({",
            '    Modal: {',
            '        show,',
            '        alert: vi.fn(),',
            '        prompt: vi.fn(),',
            '        confirm: vi.fn(),',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'modalShorthandShow.test.ts' });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('show: show,');
        expect(result.text).toContain('prompt: vi.fn(),');
    });

    it('rewrites simple expo-router mocks to createExpoRouterMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    useRouter: () => routerMock,',
            '    useLocalSearchParams: () => localSearchParams,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'router.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('router: routerMock,');
        expect(result.text).toContain('params: localSearchParams,');
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('rewrites expo-router mocks with useNavigation, pathname, useRouter, and params', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    useLocalSearchParams: () => routeParamsState.value,',
            '    useNavigation: () => ({ dispatch: vi.fn(), getState: () => undefined }),',
            "    usePathname: () => '/settings',",
            '    useRouter: () => ({ replace: vi.fn() }),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerNavigation.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('params: routeParamsState.value,');
        expect(result.text).toContain('navigation: { dispatch: vi.fn(), getState: () => undefined },');
        expect(result.text).toContain("pathname: '/settings',");
        expect(result.text).toContain('router: { replace: vi.fn() },');
    });

    it('rewrites expo-router mocks with legacy direct router exports', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    router: { replace: vi.fn(), push: routerPushSpy },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerDirectExport.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('router: { replace: vi.fn(), push: routerPushSpy },');
    });

    it('rewrites expo-router mocks with useSegments', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    useRouter: () => ({ push: routerPushSpy }),',
            "    useSegments: () => ['(app)', 'home'],",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerSegments.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain("segments: ['(app)', 'home'],");
        expect(result.text).toContain('router: { push: routerPushSpy },');
    });

    it('rewrites expo-router mocks with a simple Stack.Screen stub to createExpoRouterMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            "    Stack: { Screen: 'StackScreen' },",
            '    useNavigation: () => ({ canGoBack: () => false }),',
            '    useRouter: () => ({ push: routerPushSpy, replace: routerReplaceSpy }),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerStack.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('navigation: { canGoBack: () => false },');
        expect(result.text).toContain('router: { push: routerPushSpy, replace: routerReplaceSpy },');
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('rewrites expo-router mocks with an Object.assign Stack stub and route params', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    Stack: Object.assign(',
            "        ({ children }: any) => React.createElement(React.Fragment, null, children),",
            "        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }",
            '    ),',
            '    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),',
            '    useLocalSearchParams: () => ({}),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerObjectAssignStack.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },');
        expect(result.text).toContain('params: {},');
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('rewrites expo-router mocks with an Object.assign Stack stub, direct router export, pathname, and segments', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    Stack: Object.assign(',
            "        ({ children }: any) => React.createElement(React.Fragment, null, children),",
            "        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }",
            '    ),',
            '    router: { replace: vi.fn() },',
            "    useSegments: () => ['(app)'],",
            "    usePathname: () => '/',",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerObjectAssignStackDirectExport.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('router: { replace: vi.fn() },');
        expect(result.text).toContain("segments: ['(app)'],");
        expect(result.text).toContain("pathname: '/',");
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('rewrites stack-only expo-router mocks to the default createExpoRouterMock path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    Stack: { Screen: () => null },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerStackOnly.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('return createExpoRouterMock().module;');
    });

    it('rewrites expo-router mocks with a local Stack alias stub to createExpoRouterMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => {",
            '    const Stack: { Screen: () => null } = { Screen: () => null };',
            '    return {',
            '        Stack,',
            "        useLocalSearchParams: () => ({ id: 'machine-1' }),",
            '        useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerStackAlias.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain("params: { id: 'machine-1' },");
        expect(result.text).toContain('router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },');
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('avoids self-shadowing when the source router identifier is already named routerMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };',
            "vi.mock('expo-router', async () => {",
            "    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');",
            '    const Stack: { Screen: () => null } = { Screen: () => null };',
            '    return {',
            '        Stack,',
            "        useLocalSearchParams: () => ({ token: 'tok-1' }),",
            '        useRouter: () => routerMock,',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerShadowing.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain('const expoRouterMock = createExpoRouterMock({');
        expect(result.text).toContain('router: routerMock,');
        expect(result.text).toContain('return expoRouterMock.module;');
        expect(result.text).not.toContain('const routerMock = createExpoRouterMock({');
    });

    it('rewrites expo-router mocks with Redirect-only stubs to createExpoRouterMock', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            "    Redirect: (props: any) => React.createElement('Redirect', props),",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerRedirectOnly.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('return createExpoRouterMock().module;');
    });

    it('rewrites expo-router mocks with Redirect and a params mock alias to createExpoRouterMock', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            'const useLocalSearchParamsMock = vi.hoisted(() => vi.fn(() => ({ itemId: "item-1" })));',
            "vi.mock('expo-router', () => ({",
            "    Redirect: (props: any) => React.createElement('Redirect', props),",
            '    useLocalSearchParams: useLocalSearchParamsMock,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerRedirectParamsAlias.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('params: () => useLocalSearchParamsMock(),');
        expect(result.text).toContain('return expoRouterMock.module;');
    });

    it('rewrites expo-router mocks with Link-only stubs to createExpoRouterMock', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            "    Link: (props: any) => React.createElement('Link', props, props.children),",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerLinkOnly.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('return createExpoRouterMock().module;');
    });

    it('rewrites vi.doMock react-native mocks and preserves doMock semantics', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.doMock('react-native', () => ({",
            '    Platform: { OS: os },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeDoMock.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("vi.doMock('react-native', async () => {");
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('OS: os,');
    });

    it('rewrites expo-router mocks with a local Stack alias, direct router export, and hookful pathname and segments suppliers', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => {",
            "    const Stack = (props: any) => React.createElement('Stack', props, props.children);",
            "    Stack.Screen = (props: any) => React.createElement('StackScreen', props, props.children);",
            '    return {',
            '        Stack,',
            '        router,',
            '        useSegments: () => {',
            "            React.useMemo(() => 0, [segments.join('|')]);",
            '            return segments;',
            '        },',
            '        usePathname: () => {',
            "            React.useMemo(() => 0, [pathname]);",
            '            return pathname;',
            '        },',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'routerStackAliasHookful.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                family: 'router',
                target: 'expo-router',
            },
        ]);
        expect(result.text).toContain("const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');");
        expect(result.text).toContain('router: router,');
        expect(result.text).toContain("segments: () => {");
        expect(result.text).toContain("React.useMemo(() => 0, [segments.join('|')]);");
        expect(result.text).toContain('return segments;');
        expect(result.text).toContain("pathname: () => {");
        expect(result.text).toContain("React.useMemo(() => 0, [pathname]);");
        expect(result.text).toContain('return pathname;');
    });

    it('rewrites simple storage mocks to createStorageModuleStub', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', () => ({",
            '    useSettingMutable: () => [[], vi.fn()],',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storage.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');");
        expect(result.text).toContain('return createStorageModuleStub({');
        expect(result.text).toContain('useSettingMutable: () => [[], vi.fn()],');
    });

    it('rewrites importOriginal storage merges to createPartialStorageModuleMock overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', async (importOriginal) => {",
            "    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();",
            '    return {',
            '        ...actual,',
            "        useSetting: (key: string) => (key === 'profiles' ? [] : null),",
            '        useSessionMessagesById: () => ({}),',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storageImportOriginal.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');");
        expect(result.text).toContain('return createPartialStorageModuleMock(importOriginal, {');
        expect(result.text).not.toContain('...actual');
    });

    it('rewrites vi.importActual storage merges to createPartialStorageModuleMock overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', async () => {",
            "    const actual = await vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage');",
            '    return {',
            '        ...actual,',
            '        useSessionMessages: () => ({ messages: [], isLoaded: true }),',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storageViImportActual.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');");
        expect(result.text).toContain('return createPartialStorageModuleMock(importOriginal, {');
        expect(result.text).not.toContain('...actual');
    });

    it('repairs broken storage stubs by removing undeclared actual spreads', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', async () => {",
            "    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');",
            '    return createStorageModuleStub({',
            '        ...actual,',
            '        useSessionMessagesById: () => ({}),',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storageBrokenStub.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');");
        expect(result.text).toContain('return createStorageModuleStub({');
        expect(result.text).not.toContain('...actual');
    });

    it('does not treat nested mock-local identifiers as available to storage stub repairs', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', async () => {",
            "    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');",
            '    return createStorageModuleStub({',
            '        ...actual,',
            '        useSessionMessagesById: () => ({}),',
            '    });',
            '});',
            "vi.mock('@/other/module', async (importOriginal) => {",
            "    const actual = await importOriginal<typeof import('@/other/module')>();",
            '    return {',
            '        ...actual,',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storageBrokenStubNestedActual.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');");
        expect(result.text).toContain("return createStorageModuleStub({\n    useSessionMessagesById: () => ({}),\n});");
    });

    it('skips storage rewrites that capture undeclared identifiers', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('@/sync/domains/state/storage', () => ({",
            '    useSessionTranscriptIds: () => ({ ids: emptyIds, isLoaded: true }),',
            '    useSessionMessagesById: () => emptyMessagesById,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'storageUnsafeIdentifiers.test.tsx',
            families: ['storage'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites simple react-native-unistyles mocks to createUnistylesMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', () => ({",
            '    useUnistyles: () => ({',
            '        theme: {',
            '            colors: {',
            "                text: '#000',",
            '            },',
            '        },',
            "        rt: { themeName: 'light' },",
            '    }),',
            '    StyleSheet: { create: () => ({}) },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'unistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain("const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');");
        expect(result.text).toContain('return createUnistylesMock({');
        expect(result.text).toContain('theme: {');
        expect(result.text).toContain("themeName: 'light'");
    });

    it('rewrites StyleSheet-only react-native-unistyles passthrough mocks to createUnistylesMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', () => ({",
            '    StyleSheet: {',
            '        create: (value: any) => value,',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'unistylesStyleSheetOnly.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain("const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');");
        expect(result.text).toContain('return createUnistylesMock();');
    });

    it('preserves inline theme objects from StyleSheet.create passthrough mocks', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', () => ({",
            '    StyleSheet: {',
            '        create: (input: any) =>',
            "            typeof input === 'function'",
            '                ? input({',
            '                    colors: {',
            "                        text: '#111',",
            '                    },',
            '                })',
            '                : input,',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'unistylesStyleSheetTheme.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock({');
        expect(result.text).toContain("text: '#111'");
    });

    it('rewrites useUnistyles-only react-native-unistyles mocks to createUnistylesMock with theme overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', () => ({",
            '    useUnistyles: () => ({',
            '        theme: {',
            '            colors: {',
            "                text: '#111',",
            '            },',
            '        },',
            '    }),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'unistylesUseOnly.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain("const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');");
        expect(result.text).toContain('return createUnistylesMock({');
        expect(result.text).toContain("text: '#111'");
    });

    it('rewrites importOriginal-based react-native-unistyles mocks with StyleSheet and useUnistyles overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async (importOriginal) => {",
            "    const actual = await importOriginal<typeof import('react-native-unistyles')>();",
            '    return {',
            '        ...actual,',
            '        StyleSheet: {',
            "            create: (factory: any) => (typeof factory === 'function' ? factory({",
            "                colors: { surface: '#fff' },",
            '                spacing: (value: number) => value * 4,',
            '            }) : factory),',
            '        },',
            '        useUnistyles: () => ({',
            "            theme: { colors: { surface: '#fff' } },",
            '        }),',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'unistylesImportOriginal.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain("const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');");
        expect(result.text).toContain('return createUnistylesMock({');
        expect(result.text).toContain("surface: '#fff'");
    });

    it('rewrites prompt-style createUnistylesMock filler themes to the default helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                groupped: { background: 'white' },",
            "                textSecondary: '#999',",
            "                divider: '#ddd',",
            "                input: { background: '#fff', text: '#111', placeholder: '#666' },",
            "                accent: { blue: '#00f', indigo: '#60f', purple: '#90f' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'settingsPromptsUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("groupped: { background: 'white' }");
        expect(result.text).not.toContain("textSecondary: '#999'");
    });

    it('rewrites tool view neutral surface filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                text: '#000',",
            "                textSecondary: '#666',",
            "                warning: '#f90',",
            "                surfaceHigh: '#fff',",
            "                surfaceHighest: '#fff',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolViewNeutralUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("surfaceHigh: '#fff'");
        expect(result.text).not.toContain("warning: '#f90'");
    });

    it('rewrites richer tool view fallback filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                surfaceHigh: '#fff',",
            "                surfaceHighest: '#fff',",
            "                text: '#000',",
            "                textSecondary: '#666',",
            "                warning: '#f90',",
            "                success: '#0a0',",
            "                surfacePressedOverlay: 'rgba(0,0,0,0.04)',",
            "                shadow: { color: '#000', opacity: 0.1 },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolViewFallbackColorsUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("success: '#0a0'");
        expect(result.text).not.toContain("shadow: { color: '#000', opacity: 0.1 }");
    });

    it('rewrites permission footer filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                text: '#000',",
            "                textSecondary: '#666',",
            '                permissionButton: {',
            "                    allow: { background: '#0f0' },",
            "                    deny: { background: '#f00' },",
            "                    allowAll: { background: '#00f' },",
            '                },',
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'permissionFooterUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("allow: { background: '#0f0' }");
        expect(result.text).not.toContain("allowAll: { background: '#00f' }");
    });

    it('rewrites modal mocks with ModalProvider-only passthrough stubs to the canonical modal testkit factory', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('@/modal', () => ({",
            '    ModalProvider: ({ children }: { children: React.ReactNode }) => React.createElement(\'ModalProvider\', null, children),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'modalProviderOnly.test.tsx',
            families: ['modal'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'modal',
                target: '@/modal',
            },
        ]);
        expect(result.text).toContain("const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');");
        expect(result.text).toContain('return createModalModuleMock().module;');
    });

    it('rewrites profile editor filler themes with the default light runtime to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                header: { tint: '#000' },",
            "                textSecondary: '#666',",
            "                button: { secondary: { tint: '#000' }, primary: { background: '#00f' } },",
            "                surface: '#fff',",
            "                text: '#000',",
            "                status: { connected: '#0f0', disconnected: '#f00' },",
            "                input: { placeholder: '#999' },",
            '            },',
            '        },',
            "        rt: { themeName: 'light' },",
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'profileEditUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("header: { tint: '#000' }");
        expect(result.text).not.toContain("themeName: 'light'");
    });

    it('does not rewrite profile editor filler themes when the runtime theme is non-default', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                header: { tint: '#000' },",
            "                textSecondary: '#666',",
            "                button: { secondary: { tint: '#000' }, primary: { background: '#00f' } },",
            "                surface: '#fff',",
            "                text: '#000',",
            "                status: { connected: '#0f0', disconnected: '#f00' },",
            "                input: { placeholder: '#999' },",
            '            },',
            '        },',
            "        rt: { themeName: 'dark' },",
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'profileEditUnistylesDarkRuntime.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toContain("themeName: 'dark'");
        expect(result.text).toContain("header: { tint: '#000' }");
    });

    it('rewrites automation list filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                groupped: { background: '#fff' },",
            "                text: '#111',",
            "                textSecondary: '#777',",
            "                surface: '#fff',",
            "                surfaceHigh: '#f7f7f7',",
            "                surfaceHighest: '#eee',",
            "                surfacePressedOverlay: '#f0f0f0',",
            "                divider: '#ddd',",
            "                shadow: { color: '#000', opacity: 0.15 },",
            "                fab: { background: '#0a84ff' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'automationsListUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("fab: { background: '#0a84ff' }");
        expect(result.text).not.toContain("surfacePressedOverlay: '#f0f0f0'");
    });

    it('rewrites automation create filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                groupped: { background: '#fff', chevron: '#777', sectionTitle: '#666' },",
            "                surface: '#fff',",
            "                surfaceHigh: '#f7f7f7',",
            "                surfaceHighest: '#eee',",
            "                surfacePressed: '#f0f0f0',",
            "                surfacePressedOverlay: '#ececec',",
            "                surfaceSelected: '#e6f0ff',",
            "                surfaceRipple: '#ddd',",
            "                text: '#111',",
            "                textSecondary: '#777',",
            "                textDestructive: '#c00',",
            "                input: { background: '#eee', placeholder: '#999' },",
            "                divider: '#ddd',",
            "                accent: { blue: '#0a84ff' },",
            "                modal: { border: '#ddd' },",
            "                shadow: { color: '#000', opacity: 0.2 },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'automationsCreateUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("surfacePressed: '#f0f0f0'");
        expect(result.text).not.toContain("modal: { border: '#ddd' }");
    });

    it('rewrites richer message view filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                success: '#0a0',",
            "                text: '#111',",
            "                textSecondary: '#555',",
            "                tint: '#06f',",
            "                card: '#fff',",
            "                border: '#ddd',",
            "                surface: '#fff',",
            "                surfaceHigh: '#f5f5f5',",
            "                surfaceHighest: '#fff',",
            "                divider: '#ddd',",
            "                overlay: { text: '#fff', scrimStrong: 'rgba(0,0,0,0.7)' },",
            "                shadow: { color: '#000' },",
            "                input: { background: '#f7f7f7' },",
            "                userMessageBackground: '#eef',",
            "                agentEventText: '#777',",
            "                warning: '#f90',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'messageViewRichColorsUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("card: '#fff'");
        expect(result.text).not.toContain("tint: '#06f'");
    });

    it('does not rewrite richer message view themes when forbidden surfacePressedOverlay is present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                success: '#0a0',",
            "                text: '#111',",
            "                textSecondary: '#555',",
            "                surface: '#fff',",
            "                surfaceHigh: '#f5f5f5',",
            "                surfaceHighest: '#fff',",
            "                surfacePressedOverlay: 'rgba(0,0,0,0.04)',",
            "                divider: '#ddd',",
            "                overlay: { text: '#fff', scrimStrong: 'rgba(0,0,0,0.7)' },",
            "                shadow: { color: '#000' },",
            "                input: { background: '#f7f7f7' },",
            "                userMessageBackground: '#eef',",
            "                agentEventText: '#777',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'messageViewRichColorsForbiddenUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites files view surface scaffold filler themes with an optional dark flag to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            dark: true,',
            '            colors: {',
            "                surface: '#000',",
            "                surfaceHigh: '#111',",
            "                surfaceHighest: '#222',",
            "                divider: '#333',",
            "                text: '#fff',",
            "                textSecondary: '#bbb',",
            "                textLink: '#09f',",
            "                success: '#0f0',",
            "                warning: '#f90',",
            "                input: { background: '#000', placeholder: '#666' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'filesViewSurfaceScaffoldUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("surface: '#000'");
        expect(result.text).not.toContain("textLink: '#09f'");
    });

    it('does not rewrite files view surface scaffold themes when groupped and danger colors are present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            dark: false,',
            '            colors: {',
            "                surface: '#fff',",
            "                surfaceHigh: '#fff',",
            "                divider: '#ddd',",
            "                text: '#111',",
            "                textSecondary: '#666',",
            "                warning: '#f00',",
            "                danger: '#c00',",
            "                groupped: { background: '#fff' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'filesViewSurfaceScaffoldForbiddenUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites tool calls group filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                card: '#fff',",
            "                text: '#000',",
            "                textSecondary: '#666',",
            "                textDestructive: '#c00',",
            "                agentEventText: '#666',",
            "                success: '#0a0',",
            "                divider: '#ddd',",
            "                surfacePressedOverlay: '#eee',",
            "                input: { background: '#fafafa' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolCallsGroupUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("card: '#fff'");
        expect(result.text).not.toContain("surfacePressedOverlay: '#eee'");
    });

    it('does not rewrite tool calls group themes when shadow styling is present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                card: '#fff',",
            "                text: '#000',",
            "                textSecondary: '#666',",
            "                textDestructive: '#c00',",
            "                agentEventText: '#666',",
            "                success: '#0a0',",
            "                surfacePressedOverlay: '#eee',",
            "                shadow: { color: '#000' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolCallsGroupShadowUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites files detail grouped scaffold themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            dark: false,',
            '            colors: {',
            "                surface: '#fff',",
            "                surfaceHigh: '#fff',",
            "                surfaceHighest: '#fff',",
            "                divider: '#ddd',",
            "                text: '#111',",
            "                textSecondary: '#666',",
            "                warning: '#f00',",
            "                success: '#0a0',",
            "                danger: '#c00',",
            "                textLink: '#00f',",
            "                groupped: { background: '#fff' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'filesDetailGroupedScaffoldUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("groupped: { background: '#fff' }");
        expect(result.text).not.toContain("textLink: '#00f'");
    });

    it('does not rewrite files detail grouped scaffold themes when input colors are present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                surface: '#fff',",
            "                surfaceHigh: '#fff',",
            "                surfaceHighest: '#fff',",
            "                divider: '#ddd',",
            "                text: '#111',",
            "                textSecondary: '#666',",
            "                textLink: '#00f',",
            "                groupped: { background: '#fff' },",
            "                input: { background: '#f7f7f7' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'filesDetailGroupedScaffoldInputUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites exact ToolFullView palette themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                accent: { orange: '#f90', indigo: '#55f' },",
            "                success: '#0a0',",
            "                surface: '#fff',",
            "                warningCritical: '#f00',",
            "                text: '#111',",
            "                textSecondary: '#666',",
            "                border: '#ddd',",
            "                borderSubtle: '#eee',",
            "                background: '#fff',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolFullViewPaletteUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("accent: { orange: '#f90', indigo: '#55f' }");
        expect(result.text).not.toContain("borderSubtle: '#eee'");
    });

    it('does not rewrite ToolFullView palette themes when surfacePressedOverlay is present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                accent: { orange: '#f90', indigo: '#55f' },",
            "                success: '#0a0',",
            "                surface: '#fff',",
            "                warningCritical: '#f00',",
            "                text: '#111',",
            "                textSecondary: '#666',",
            "                border: '#ddd',",
            "                borderSubtle: '#eee',",
            "                background: '#fff',",
            "                surfacePressedOverlay: '#eee',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolFullViewPaletteForbiddenUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites exact SessionRightPanel dark sidebar filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const themeColors = {',
            "    text: '#fff',",
            "    textSecondary: '#aaa',",
            "    textLink: '#00f',",
            "    surface: '#000',",
            "    surfaceHigh: '#111',",
            "    divider: '#222',",
            "    border: '#222',",
            "    indigo: '#5856D6',",
            "    accent: {",
            "        blue: '#007AFF',",
            "        green: '#34C759',",
            "        orange: '#FF9500',",
            "        yellow: '#FFCC00',",
            "        red: '#FF3B30',",
            "        indigo: '#5856D6',",
            "        purple: '#AF52DE',",
            '    },',
            "    modal: { border: '#222' },",
            "    input: { background: '#111' },",
            "    header: { tint: '#fff' },",
            "    status: { error: '#f00' },",
            "    shadow: { color: '#000', opacity: 0.2 },",
            "    groupped: { background: '#111', chevron: '#222', sectionTitle: '#aaa' },",
            '};',
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: themeColors,',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'sessionRightPanelDarkSidebarUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain('colors: themeColors');
    });

    it('rewrites minimal SessionRightPanelGitView filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            dark: false,',
            '            colors: {',
            "                textSecondary: '#666',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'sessionRightPanelGitMinimalUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("textSecondary: '#666'");
    });

    it('rewrites minimal surface/text/textSecondary filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                surface: '#000',",
            "                text: '#fff',",
            "                textSecondary: '#aaa',",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'minimalPaneSurfaceUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("surface: '#000'");
    });

    it('rewrites picker filler themes that spread a shared PICKER_THEME_COLORS object', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const PICKER_THEME_COLORS = {',
            "    divider: '#ddd',",
            "    groupped: { background: '#ffffff', sectionTitle: '#000' },",
            "    header: { tint: '#000' },",
            "    input: { background: '#fff', placeholder: '#aaa', text: '#000' },",
            "    status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },",
            "    surface: '#fff',",
            "    textSecondary: '#666',",
            '};',
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            '                ...PICKER_THEME_COLORS,',
            "                shadow: { color: '#000', opacity: 0.2 },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'pickerSpreadUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain('...PICKER_THEME_COLORS');
        expect(result.text).not.toContain("shadow: { color: '#000', opacity: 0.2 }");
    });

    it('rewrites picker filler themes that read low-signal colors from PICKER_THEME_COLORS member access', () => {
        const input = [
            "import { vi } from 'vitest';",
            'const PICKER_THEME_COLORS = {',
            "    divider: '#ddd',",
            "    groupped: { background: '#ffffff', sectionTitle: '#000' },",
            "    header: { tint: '#000' },",
            "    input: { background: '#fff', placeholder: '#aaa', text: '#000' },",
            "    status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },",
            "    surface: '#fff',",
            "    textSecondary: '#666',",
            '};',
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            '                textSecondary: PICKER_THEME_COLORS.textSecondary,',
            '                header: PICKER_THEME_COLORS.header,',
            '                surface: PICKER_THEME_COLORS.surface,',
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'pickerMemberAccessUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.textSecondary');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.header');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.surface');
    });

    it('rewrites picker filler themes that spread an imported PICKER_THEME_COLORS object', () => {
        const input = [
            "import { vi } from 'vitest';",
            "import { PICKER_THEME_COLORS } from './__fixtures__/pickerThemeHarness';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            '                ...PICKER_THEME_COLORS,',
            "                shadow: { color: '#000', opacity: 0.2 },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: fileURLToPath(new URL('./pickerImportedSpreadUnistyles.test.tsx', import.meta.url)),
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain('...PICKER_THEME_COLORS');
    });

    it('rewrites picker filler themes that read low-signal colors from imported PICKER_THEME_COLORS member access', () => {
        const input = [
            "import { vi } from 'vitest';",
            "import { PICKER_THEME_COLORS } from './__fixtures__/pickerThemeHarness';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            '                textSecondary: PICKER_THEME_COLORS.textSecondary,',
            '                header: PICKER_THEME_COLORS.header,',
            '                surface: PICKER_THEME_COLORS.surface,',
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: fileURLToPath(new URL('./pickerImportedMemberAccessUnistyles.test.tsx', import.meta.url)),
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.textSecondary');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.header');
        expect(result.text).not.toContain('PICKER_THEME_COLORS.surface');
    });

    it('rewrites ToolTimelineRow filler themes to the default unistyles helper path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                text: '#111',",
            "                textSecondary: '#555',",
            "                surfaceHigh: '#eee',",
            "                surfaceHighest: '#fff',",
            "                surfacePressedOverlay: '#ddd',",
            "                divider: '#ccc',",
            "                shadow: { color: '#000', opacity: 0.1 },",
            "                accent: { blue: '#06f' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolTimelineRowUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        ]);
        expect(result.text).toContain('return createUnistylesMock();');
        expect(result.text).not.toContain("surfacePressedOverlay: '#ddd'");
    });

    it('does not rewrite ToolTimelineRow filler themes when extra accent variants are present', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native-unistyles', async () => {",
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock({',
            '        theme: {',
            '            colors: {',
            "                text: '#111',",
            "                textSecondary: '#555',",
            "                surfaceHigh: '#eee',",
            "                surfaceHighest: '#fff',",
            "                surfacePressedOverlay: '#ddd',",
            "                accent: { blue: '#06f', orange: '#f90' },",
            '            },',
            '        },',
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'toolTimelineRowForbiddenUnistyles.test.tsx',
            families: ['unistyles'],
        });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });

    it('rewrites simple react-native object mocks to createReactNativeWebMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', () => ({",
            "    ActivityIndicator: 'ActivityIndicator',",
            "    Pressable: 'Pressable',",
            "    Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.default },",
            "    View: 'View',",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNative.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain("ActivityIndicator: 'ActivityIndicator'");
        expect(result.text).toContain("OS: 'ios'");
    });

    it('rewrites stub-spread react-native mocks to createReactNativeWebMock overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => {",
            "    const rn = await import('@/dev/reactNativeStub');",
            '    return {',
            '        ...rn,',
            '        Platform: {',
            '            ...rn.Platform,',
            "            OS: 'android',",
            '            select: (value: any) => value.android ?? value.native ?? value.default,',
            '        },',
            "        View: 'View',",
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeStub.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain("OS: 'android'");
        expect(result.text).toContain("View: 'View'");
        expect(result.text).not.toContain('rn.');
        expect(result.text).not.toContain('...rn');
    });

    it('drops stub-alias nested spreads when rewriting react-native module overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => {",
            "    const actual = await import('@/dev/reactNativeStub');",
            '    return {',
            '        ...actual,',
            '        TurboModuleRegistry: {',
            '            ...(actual.TurboModuleRegistry ?? null),',
            '            get: () => ({}),',
            '            getEnforcing: () => ({}),',
            '        },',
            '        Dimensions: {',
            '            ...(actual.Dimensions ?? null),',
            '            get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),',
            '        },',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeNested.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain('TurboModuleRegistry: {');
        expect(result.text).toContain('getEnforcing: () => ({})');
        expect(result.text).toContain('Dimensions: {');
        expect(result.text).not.toContain('actual.');
        expect(result.text).not.toContain('...(actual.');
    });

    it('rewrites direct await-import stub spreads in react-native mocks', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => ({",
            "    ...(await import('@/dev/reactNativeStub')),",
            "    Platform: { OS: 'ios', select: (spec: any) => spec?.ios ?? spec?.default },",
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeDirectAwaitSpread.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain("OS: 'ios'");
        expect(result.text).not.toContain("await import('@/dev/reactNativeStub')");
    });

    it('rewrites alias-backed react-native fallback properties to canonical overrides', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async (importOriginal) => {",
            "    const actual = await importOriginal<any>();",
            '    return {',
            '        ...actual,',
            '        AppState: actual.AppState,',
            '        Platform: {',
            '            ...(actual.Platform ?? {}),',
            "            OS: 'web',",
            "            select: (actual.Platform?.select ?? ((value: any) => value?.web ?? value?.default ?? null)),",
            '        },',
            "        useWindowDimensions: actual.useWindowDimensions ?? (() => ({ width: 1024, height: 768, scale: 1, fontScale: 1 })),",
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeAliasBackedFallbacks.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain("OS: 'web'");
        expect(result.text).toContain('useWindowDimensions: (() => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }))');
        expect(result.text).not.toContain('AppState: actual.AppState');
        expect(result.text).not.toContain('actual.Platform?.select');
        expect(result.text).not.toContain('actual.useWindowDimensions ??');
    });

    it('rewrites local component-shim react-native mocks that return declared identifiers', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', () => {",
            "    const ReactModule = require('react') as typeof React;",
            "    const Pressable = (props: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement('Pressable', props, props.children);",
            "    const Text = (props: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement('Text', props, props.children);",
            "    const View = (props: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement('View', props, props.children);",
            "    const TextInput = ReactModule.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {",
            "        if (ref && typeof ref === 'object') {",
            "            ref.current = { focus: () => {} };",
            '        }',
            "        return ReactModule.createElement('TextInput', props);",
            '    });',
            '    return {',
            "        Platform: { OS: 'ios', select: <T,>(obj: { ios?: T; default?: T }) => obj.ios ?? obj.default },",
            '        Pressable,',
            '        Text,',
            '        View,',
            '        TextInput,',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeLocalComponentShims.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Pressable', props, props.children)");
        expect(result.text).toContain("TextInput: React.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {");
        expect(result.text).not.toContain('ReactModule.');
        expect(result.text).not.toContain('Pressable,');
        expect(result.text).not.toContain('TextInput,');
    });

    it('rewrites local forwardRef view shims and preserves top-level helper references', () => {
        const input = [
            "import * as React from 'react';",
            "import { vi } from 'vitest';",
            'function flattenStyle(style: any): React.CSSProperties | undefined {',
            '    return style;',
            '}',
            "vi.mock('react-native', () => {",
            "    const View = React.forwardRef<HTMLDivElement, any>(function View(props, ref) {",
            '        const { children, style, testID, ...rest } = props;',
            "        return React.createElement('div', { ...rest, ref, style: flattenStyle(style), 'data-testid': testID }, children);",
            '    });',
            '    return {',
            "        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },",
            '        View,',
            '        StyleSheet: {',
            '            flatten: flattenStyle,',
            '        },',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeForwardRefViewShim.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("View: React.forwardRef<HTMLDivElement, any>(function View(props, ref) {");
        expect(result.text).toContain('style: flattenStyle(style)');
        expect(result.text).toContain('flatten: flattenStyle');
        expect(result.text).not.toContain('View,');
    });

    it('normalizes local react import aliases when rewriting react-native module overrides', () => {
        const input = [
            "import * as React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => {",
            "    const actual = await import('@/dev/reactNativeStub');",
            "    const ReactMod = await import('react');",
            '    return {',
            '        ...actual,',
            '        View: (props: any) => ReactMod.createElement(\'View\', props, props.children),',
            '        ActivityIndicator: () => ReactMod.createElement(\'ActivityIndicator\'),',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeReactAlias.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain("View: (props: any) => React.createElement('View', props, props.children)");
        expect(result.text).toContain("ActivityIndicator: () => React.createElement('ActivityIndicator')");
        expect(result.text).not.toContain('ReactMod.');
    });

    it('rewrites react-native mocks that directly return createReactNativeWebMock calls', () => {
        const input = [
            "import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => {",
            '    return createReactNativeWebMock({',
            "        Platform: { OS: 'ios' },",
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeDirectHelperReturn.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain("OS: 'ios'");
    });

    it('rewrites react-native mocks that directly return awaited createReactNativeWebMock calls', () => {
        const input = [
            "import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => {",
            '    return await createReactNativeWebMock({',
            "        Platform: { OS: platformOs },",
            '    });',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeAwaitedHelperReturn.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain('OS: platformOs');
    });

    it('rewrites react-native mocks that return awaited imported createReactNativeWebMock property calls', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => (",
            "    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({",
            "        View: 'View',",
            '    })',
            '));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeAwaitedImportPropertyCall.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain("View: 'View'");
    });

    it('rewrites react-native mocks that return import-then createReactNativeWebMock calls', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', () => (",
            "    import('@/dev/testkit/mocks/reactNative').then(({ createReactNativeWebMock }) => createReactNativeWebMock({",
            "        Platform: { OS: 'web' },",
            '    }))',
            '));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeImportThenHelperCall.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');");
        expect(result.text).toContain('return createReactNativeWebMock(');
        expect(result.text).toContain("OS: 'web'");
    });

    it('rewrites react-native mocks with Platform getters to createReactNativeWebMock', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', () => ({",
            '    Platform: {',
            '        get OS() {',
            '            return platformOS;',
            '        },',
            '        select: (options: any) => options?.[platformOS] ?? options?.default ?? options?.ios ?? options?.android,',
            '    },',
            '    Dimensions: {',
            '        get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),',
            '    },',
            '    useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativePlatformGetter.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain('get OS() {');
        expect(result.text).toContain('return platformOS;');
        expect(result.text).toContain('Dimensions: {');
    });

    it('rewrites react-native mocks with Platform getters and setters to createReactNativeWebMock', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', () => ({",
            "    View: ({ children }: { children?: React.ReactNode }) => React.createElement('View', null, children),",
            '    Platform: {',
            '        get OS() {',
            '            return mockedPlatformOS;',
            '        },',
            '        set OS(value: string) {',
            '            mockedPlatformOS = value;',
            '        },',
            '        select: (options: any) => options?.[mockedPlatformOS] ?? options?.default ?? options?.ios ?? options?.android,',
            '    },',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativePlatformGetterSetter.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain('get OS() {');
        expect(result.text).toContain('return mockedPlatformOS;');
        expect(result.text).toContain('set OS(value: string) {');
        expect(result.text).toContain('mockedPlatformOS = value;');
    });

    it('rewrites importOriginal react-native mocks with Platform getters and actual spreads', () => {
        const input = [
            "import React from 'react';",
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async (importOriginal) => {",
            "    const actual = await importOriginal<typeof import('react-native')>();",
            '    return {',
            '        ...actual,',
            '        View: (props: any) => React.createElement(\'View\', props, props.children),',
            '        Pressable: (props: any) => React.createElement(\'Pressable\', props, props.children),',
            '        PanResponder: { create: () => ({ panHandlers: {} }) },',
            '        Dimensions: {',
            '            ...actual.Dimensions,',
            '            get: () => ({ width: mockWindowDimensions.width, height: mockWindowDimensions.height, scale: 1, fontScale: 1 }),',
            '        },',
            '        useWindowDimensions: () => ({ width: mockWindowDimensions.width, height: mockWindowDimensions.height }),',
            '        Platform: {',
            '            ...actual.Platform,',
            '            get OS() {',
            '                return mockPlatformOS;',
            '            },',
            '            select: (options: any) => options?.[mockPlatformOS] ?? options?.default ?? options?.ios ?? options?.android,',
            '        },',
            '    };',
            '});',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'reactNativeImportOriginalPlatformGetter.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain('PanResponder: {');
        expect(result.text).toContain('get OS() {');
        expect(result.text).toContain('return mockPlatformOS;');
        expect(result.text).not.toContain('...actual.Platform');
        expect(result.text).not.toContain('...actual.Dimensions');
    });

    it('rewrites legacy transcript harness helper wrappers to the shared chat list harness path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => (",
            "    (await import('./ChatList.legacyListTestHarness')).createLegacyChatListReactNativeMock({",
            "        platformOs: 'ios',",
            '    })',
            '));',
            "vi.mock('@/sync/domains/state/storage', async (importOriginal) => (",
            "    (await import('./ChatList.legacyListTestHarness')).createLegacyChatListStorageMock(importOriginal)",
            '));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'ChatList.autoFollowWhenPinned.test.tsx',
            families: ['reactNative', 'storage'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
            {
                family: 'storage',
                target: '@/sync/domains/state/storage',
            },
        ]);
        expect(result.text).toContain("await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListReactNativeMock({");
        expect(result.text).toContain("await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListStorageMock(importOriginal)");
        expect(result.text).not.toContain("./ChatList.legacyListTestHarness')).createLegacyChatListReactNativeMock");
        expect(result.text).not.toContain("./ChatList.legacyListTestHarness')).createLegacyChatListStorageMock");
    });

    it('rewrites flash-list transcript harness helper wrappers to the shared chat list harness path', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('react-native', async () => (",
            "    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({",
            "        platformOs: 'ios',",
            '    })',
            '));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, {
            filePath: 'ChatList.flashListV2.pinOnContentChange.test.tsx',
            families: ['reactNative'],
        });

        expect(result.rewrites).toEqual([
            {
                family: 'reactNative',
                target: 'react-native',
            },
        ]);
        expect(result.text).toContain("await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({");
    });

    it('leaves unsupported inline mocks untouched', () => {
        const input = [
            "import { vi } from 'vitest';",
            "vi.mock('expo-router', () => ({",
            '    useRouter: () => routerMock,',
            '    SomethingElse: () => null,',
            '}));',
        ].join('\n');

        const result = rewriteInlineMockFamilies(input, { filePath: 'unsupported.test.tsx' });

        expect(result.rewrites).toEqual([]);
        expect(result.text).toBe(input);
    });
});
