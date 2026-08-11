import { describe, expect, it } from 'vitest';

import { collectInlineMockFamilyStats } from './inlineMockClassifier';

describe('collectInlineMockFamilyStats', () => {
    it('distinguishes canonical factory-backed mocks from ad hoc inline mocks', () => {
        const input = [
            "vi.mock('@/text', () => ({ t: (key: string) => key }));",
            "vi.mock('@/modal', async () => {",
            "    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');",
            '    return createModalModuleMock().module;',
            '});',
            "vi.mock('expo-router', async () => {",
            "    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');",
            '    return createExpoRouterMock().module;',
            '});',
            "vi.mock('@/sync/domains/state/storage', async () => {",
            "    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');",
            '    return createStorageModuleStub({ useSettingMutable: () => [null, () => undefined] });',
            '});',
            "vi.mock('react-native', () => ({ View: 'View' }));",
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'inlineMockClassifier.test.tsx' });

        expect(stats.text).toEqual({ total: 1, canonical: 0, adHoc: 1 });
        expect(stats.modal).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.router).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.storage).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.reactNative).toEqual({ total: 1, canonical: 0, adHoc: 1 });
    });

    it('counts shared chat list harness helper wrappers as canonical and local harness wrappers as ad hoc', () => {
        const input = [
            "vi.mock('react-native', async () => (",
            "    (await import('./ChatList.legacyListTestHarness')).createLegacyChatListReactNativeMock()",
            '));',
            "vi.mock('react-native', async () => (",
            "    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListReactNativeMock({ platformOs: 'ios' })",
            '));',
            "vi.mock('@/sync/domains/state/storage', async (importOriginal) => (",
            "    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal)",
            '));',
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'chatListHarnessClassifier.test.tsx' });

        expect(stats.reactNative).toEqual({ total: 2, canonical: 1, adHoc: 1 });
        expect(stats.storage).toEqual({ total: 1, canonical: 1, adHoc: 0 });
    });

    // The canonical testkit publishes each family factory in two spellings: `create*`, which returns
    // the module object, and `install*`, a one-line wrapper returning a factory that calls it
    // (`installStorageModuleStub` is literally `() => createStorageModuleStub(overrides)`).
    // `createReactNativeNativeMock` is the documented native counterpart of `createReactNativeWebMock`
    // in that same module. All of them are the canonical shape, so a file reaching for one is not ad
    // hoc -- the first test in this file keeps the ad hoc object-literal spelling pinned as ad hoc.
    it('counts install wrappers and the native react-native factory as canonical', () => {
        const input = [
            "vi.mock('@/text', async () => {",
            "    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');",
            '    return installTextModuleMock()();',
            '});',
            "vi.mock('@/sync/domains/state/storage', async () => {",
            "    const { installStorageModuleStub } = await import('@/dev/testkit/mocks/storage');",
            '    return installStorageModuleStub({ storage: { getState: () => ({}) } })();',
            '});',
            "vi.mock('react-native', async () => {",
            "    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');",
            "    return createReactNativeNativeMock({ platformOS: 'ios' });",
            '});',
            "vi.mock('react-native-unistyles', async () => {",
            "    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return installUnistylesMock()();',
            '});',
            "vi.mock('@/modal', async () => {",
            "    const { installModalModuleMock } = await import('@/dev/testkit/mocks/modal');",
            '    return installModalModuleMock()();',
            '});',
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'installWrapperClassifier.test.tsx' });

        expect(stats.text).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.storage).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.reactNative).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.unistyles).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.modal).toEqual({ total: 1, canonical: 1, adHoc: 0 });
    });

    // The remaining two install wrappers the testkit exports for these specifiers. Pinned so every
    // marker in the table is load-bearing rather than added on the assumption it belongs.
    it('counts the remaining canonical install wrappers as canonical', () => {
        const input = [
            "vi.mock('react-native', async () => {",
            "    const { installReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');",
            '    return installReactNativeWebMock()();',
            '});',
            "vi.mock('@/sync/domains/state/storage', async (importOriginal) => {",
            "    const { installPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');",
            '    return installPartialStorageModuleMock({ useSetting: () => null })(importOriginal);',
            '});',
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'remainingInstallWrappers.test.tsx' });

        expect(stats.reactNative).toEqual({ total: 1, canonical: 1, adHoc: 0 });
        expect(stats.storage).toEqual({ total: 1, canonical: 1, adHoc: 0 });
    });

    it('counts alias-backed canonical router mocks as canonical', () => {
        const input = [
            "const expoRouterMock = createExpoRouterMock({ params: { sessionId: 'session-1' } });",
            "vi.mock('expo-router', () => expoRouterMock.module);",
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'aliasBackedRouterClassifier.test.tsx' });

        expect(stats.router).toEqual({ total: 1, canonical: 1, adHoc: 0 });
    });

    it('counts local helper-backed canonical router mocks as canonical', () => {
        const input = [
            'const localSearchParamsMock = () => ({ server: "https://example.test" });',
            'const routerMock = createTerminalRouterMock();',
            'function createTerminalRouterMock() {',
            '    return createExpoRouterMock({',
            '        router: { back: vi.fn() },',
            '        params: () => localSearchParamsMock(),',
            '    });',
            '}',
            "vi.mock('expo-router', async () => {",
            '    return routerMock.module;',
            '});',
        ].join('\n');

        const stats = collectInlineMockFamilyStats(input, { filePath: 'helperBackedRouterClassifier.test.tsx' });

        expect(stats.router).toEqual({ total: 1, canonical: 1, adHoc: 0 });
    });
});
