import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { useAskSelection } = await import('./useAskSelection');
afterEach(standardCleanup);

describe('web transcript selection without a workspace', () => {
    it('routes the shared Ask command to the surface Quote action without requiring file context', async () => {
        const quotes: string[] = [];
        const selected = { startLine: 1, endLine: 1, text: 'The exact rendered passage' };
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:pure-prose', workspaceScope: null,
            source: 'transcript', getSelection: () => selected, sessionTarget: { sessionId: 's1' },
            accountLifetime: null, openDetailsTab: () => undefined,
            onAskSelection: async (selection) => { quotes.push(selection.text); return true; },
        }));
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        expect(quotes).toEqual(['The exact rendered passage']);
    });

    it('keeps the published selection while a caret moves along its line, so typing does not render the host per key', async () => {
        let line = 'const a';
        let notify: (() => void) | undefined;
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useAskSelection({ scopeId: 'file:caret', workspaceScope: null, source: 'file',
                getSelection: () => ({ startLine: 4, endLine: 4, text: line, collapsed: true, rect: null }),
                subscribeSelection: (listener) => { notify = listener; return () => { notify = undefined; }; },
                sessionTarget: null, accountLifetime: null, openDetailsTab: () => undefined });
        });
        const published = hook.getCurrent().selection;
        const rendersBefore = renders;
        for (const typed of ['const ab', 'const abc', 'const abcd']) {
            line = typed;
            await act(async () => { notify?.(); });
        }
        expect(hook.getCurrent().selection).toBe(published);
        expect(renders).toBe(rendersBefore);
    });
});
