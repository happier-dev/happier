import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { discardMachineAddFlowDraft, updateMachineAddFlowDraft, useMachineAddFlowDraft, useMachineAddFlowDraftSelector } from './machineAddFlowStore';

afterEach(async () => { await act(async () => discardMachineAddFlowDraft()); vi.useRealTimers(); standardCleanup(); });
describe('machine add retained draft', () => {
    it('does not rerender a narrow rail title subscription when a password changes', async () => {
        let renders = 0;
        const title = await renderHook(() => { renders++; return useMachineAddFlowDraftSelector((draft) => draft.sshDraft.host); });
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, sshDraft: { ...draft.sshDraft, host: 'box' } })));
        const beforePassword = renders;
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, sshDraft: { ...draft.sshDraft, password: 'secret' } })));
        expect(title.getCurrent()).toBe('box');
        expect(renders).toBe(beforePassword);
        await title.unmount();
    });
    it('retains the target Home, credentials and baseline after every presenter leaves', async () => {
        const first = await renderHook(() => useMachineAddFlowDraft());
        const baseline = { serverUrl: 'https://retained.example.test', knownIds: new Set(['existing']), wasOnlineById: new Map([['existing', true]]) };
        await act(async () => first.getCurrent().update((draft) => ({
            ...draft, serverId: 'home-one', path: 'ssh', os: 'windows',
            sshDraft: { ...draft.sshDraft, host: 'build-box' }, baseline, startedAtMs: Date.now(),
        })));
        await first.unmount();
        const resumed = await renderHook(() => useMachineAddFlowDraft());
        expect(resumed.getCurrent().draft).toMatchObject({ serverId: 'home-one', path: 'ssh', os: 'windows', sshDraft: { host: 'build-box' }, baseline });
        await act(async () => resumed.getCurrent().discard());
        expect(resumed.getCurrent().draft).toMatchObject({ serverId: null, path: null, baseline: null, startedAtMs: null });
        await resumed.unmount();
    });
    it('notifies both presenters after five minutes and resumes the elapsed watch when remounted', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const first = await renderHook(() => useMachineAddFlowDraft());
        const second = await renderHook(() => useMachineAddFlowDraft());
        await act(async () => first.getCurrent().update((draft) => ({ ...draft, serverId: 'home-clock', path: 'anotherComputer', startedAtMs: Date.now() })));
        await act(async () => { vi.advanceTimersByTime(5 * 60_000 - 1); });
        expect(first.getCurrent().notSeeing).toBe(false);
        await first.unmount();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(second.getCurrent().notSeeing).toBe(true);
        const resumed = await renderHook(() => useMachineAddFlowDraft());
        expect(resumed.getCurrent().notSeeing).toBe(true);
        await act(async () => resumed.getCurrent().discard());
        expect(second.getCurrent().notSeeing).toBe(false);
        await resumed.unmount();
        await second.unmount();
    });
    it('clears the view deadline when only the rail still observes the retained draft', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const rail = await renderHook(() => useMachineAddFlowDraftSelector(draft => draft));
        const presenter = await renderHook(() => useMachineAddFlowDraft());
        const timersBeforeWatch = vi.getTimerCount();

        await act(async () => presenter.getCurrent().update(draft => ({ ...draft, path: 'anotherComputer', startedAtMs: Date.now() })));
        expect(vi.getTimerCount()).toBe(timersBeforeWatch + 1);
        const retained = rail.getCurrent();
        await presenter.unmount();
        expect(vi.getTimerCount()).toBe(timersBeforeWatch);

        await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
        expect(rail.getCurrent()).toBe(retained);
        const reopened = await renderHook(() => useMachineAddFlowDraft());
        expect(reopened.getCurrent().notSeeing).toBe(true);
        await reopened.unmount();
        await rail.unmount();
    });
});
