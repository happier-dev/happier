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
