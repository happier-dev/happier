import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { t } from '@/text';
import { useDiscussionAttachmentDrafts, useDiscussionAttachmentSettlement } from './useDiscussionAttachmentDrafts';

describe('Discussion shared attachment intake', () => {
    it('settles and patches only the captured Home when a retained manager binds a new key with the same source', async () => {
        const initial = { scope: { serverId: 'old-home', accountId: 'key-account' },
            address: { kind: 'discussion' as const, discussionId: 'key-discussion' }, enabled: true, maxFileBytes: 50 };
        const hook = await renderHook((options: typeof initial) => useDiscussionAttachmentDrafts(options), { initialProps: initial });
        act(() => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'memory', name: 'same.txt', bytes: new Uint8Array([1]) }] }); });
        const captured = hook.getCurrent().getDraftsSnapshot();
        const oldPatch = hook.getCurrent().applyDraftPatch;
        const oldSettle = hook.getCurrent().settleSubmission;
        await hook.rerender({ ...initial, scope: { ...initial.scope, serverId: 'new-home' } });
        act(() => hook.getCurrent().replaceDrafts(captured));
        act(() => { oldPatch(captured[0]!.id, { status: 'error' }, captured[0]!.source); oldSettle(captured, 'observed_success'); });
        expect(hook.getCurrent().drafts).toMatchObject([{ id: captured[0]!.id, status: 'pending' }]);
        act(() => hook.getCurrent().clearDrafts());
        await hook.rerender(initial);
        expect(hook.getCurrent().drafts).toEqual([]);
        await hook.unmount();
    });
    it('settles a detached submission through the reopened tray without deleting later or replaced sources', async () => {
        const options = { scope: { serverId: 'detached-home', accountId: 'detached-account' },
            address: { kind: 'discussion' as const, discussionId: 'detached-discussion' }, enabled: true, maxFileBytes: 50 };
        const first = await renderHook(() => useDiscussionAttachmentDrafts(options));
        act(() => { first.getCurrent().addWebFiles([], { sources: [
            { kind: 'memory', name: 'replace-me.txt', bytes: new Uint8Array([1]) },
            { kind: 'memory', name: 'accepted.txt', bytes: new Uint8Array([2]) },
        ] }); });
        const captured = first.getCurrent().getDraftsSnapshot();
        const settle = first.getCurrent().settleSubmission;
        await first.unmount();
        const reopened = await renderHook(() => useDiscussionAttachmentDrafts(options));
        act(() => {
            const current = reopened.getCurrent().getDraftsSnapshot();
            reopened.getCurrent().replaceDrafts([{ ...current[0]!, source: { kind: 'memory', name: 'replacement.txt', bytes: new Uint8Array([3]) } }, current[1]!]);
            reopened.getCurrent().addWebFiles([], { sources: [{ kind: 'memory', name: 'later.txt', bytes: new Uint8Array([4]) }] });
            settle(captured, 'observed_success');
        });
        expect(reopened.getCurrent().drafts.map(draft => draft.source.kind === 'web' ? draft.source.file.name : draft.source.name))
            .toEqual(['replacement.txt', 'later.txt']);
        act(() => reopened.getCurrent().clearDrafts());
        await reopened.unmount();
    });
    it('projects indeterminate preparation and retained failure through the existing tray owner', async () => {
        const hook = await renderHook(() => useDiscussionAttachmentDrafts({
            scope: { serverId: 'submission-home', accountId: 'submission-account' }, address: { kind: 'newDiscussion' },
            enabled: true, maxFileBytes: 50,
        }));
        act(() => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'memory', name: 'retry.txt', bytes: new Uint8Array([7]) }] }); });
        let preparation: Promise<unknown> | undefined;
        act(() => {
            const current = hook.getCurrent();
            // The asserted contract is the observable tray transition, not a missing-method exception.
            const prepare = 'prepareSubmission' in current ? current.prepareSubmission : null;
            if (typeof prepare === 'function') preparation = prepare();
        });
        expect(hook.getCurrent().drafts).toMatchObject([{ status: 'uploading', uploadProgress: undefined }]);
        await act(async () => { await preparation; });
        const submitted = hook.getCurrent().getDraftsSnapshot();
        act(() => hook.getCurrent().settleSubmission(submitted, 'failed', 'attachment_source_unavailable'));
        // The tray says the reason a person can act on, never the wire code.
        expect(hook.getCurrent().drafts).toMatchObject([{ id: submitted[0]!.id, status: 'error', error: t('common.unavailable') }]);
        act(() => hook.getCurrent().settleSubmission(submitted, 'outcome_unknown'));
        expect(hook.getCurrent().drafts).toMatchObject([{ status: 'error', error: t('session.collaboration.discussion.deliveryUnknown') }]);
        act(() => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'memory', name: 'new.txt', bytes: new Uint8Array([8]) }] }); });
        act(() => hook.getCurrent().settleSubmission(submitted, 'observed_success'));
        expect(hook.getCurrent().drafts).toMatchObject([{ source: { name: 'new.txt' }, status: 'pending' }]);
        act(() => hook.getCurrent().clearDrafts());
        await hook.unmount();
    });
    it('retains the exact draft sources across navigation, isolates Account and removes only submitted files', async () => {
        const options = { scope: { serverId: 'attachment-home', accountId: 'attachment-account' },
            address: { kind: 'discussion' as const, discussionId: 'discussion' }, enabled: true, maxFileBytes: 50 };
        const first = await renderHook(() => useDiscussionAttachmentDrafts(options));
        const file = { kind: 'memory' as const, name: 'original.txt', bytes: new Uint8Array([1]) };
        let submitted = first.getCurrent().getDraftsSnapshot();
        act(() => { first.getCurrent().addWebFiles([], { sources: [file] }); submitted = first.getCurrent().getDraftsSnapshot(); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionAttachmentDrafts(options));
        expect(restored.getCurrent().drafts).toMatchObject([{ id: submitted[0]!.id, source: file }]);
        const other = await renderHook(() => useDiscussionAttachmentDrafts({ ...options, scope: { ...options.scope, accountId: 'other' } }));
        expect(other.getCurrent().drafts).toEqual([]);
        await other.unmount();
        const captured = restored.getCurrent().getDraftsSnapshot();
        act(() => { restored.getCurrent().addWebFiles([], { sources: [{ ...file, name: 'next.txt' }] }); });
        act(() => { restored.getCurrent().removeSubmittedDrafts(captured); });
        expect(restored.getCurrent().drafts).toHaveLength(1);
        expect(restored.getCurrent().drafts[0]?.source).toMatchObject({ name: 'next.txt' });
        act(() => restored.getCurrent().clearDrafts());
        await restored.unmount();
    });
    it('settles a tracked send through every later mutation transition, including a Retry that commits', async () => {
        const calls: Array<readonly [string, string | undefined]> = [];
        const submission = { sources: [], settle: (status: string, errorCode?: string) => { calls.push([status, errorCode]); } };
        type Mutations = Parameters<typeof useDiscussionAttachmentSettlement>[0];
        const hook = await renderHook((mutations: Mutations) => useDiscussionAttachmentSettlement(mutations), { initialProps: {} as Mutations });
        let committed: (value: { kind: string }) => void = () => {};
        act(() => { void hook.getCurrent()('post-1', submission, new Promise<{ kind: string }>(resolve => { committed = resolve; })); });
        expect(calls).toEqual([]);
        await hook.rerender({ 'post-1': { status: 'sending' } });
        await hook.rerender({ 'post-1': { status: 'failed', errorCode: 'offline' } });
        await hook.rerender({ 'post-1': { status: 'failed', errorCode: 'offline' } });
        await hook.rerender({ 'post-1': { status: 'sending' } });
        await hook.rerender({ 'post-1': { status: 'observed_success' } });
        // Acknowledged and gone: nothing more to settle, and an unrelated send is not this tray's.
        await hook.rerender({ 'post-2': { status: 'failed', errorCode: 'offline' } });
        expect(calls).toEqual([['sending', undefined], ['failed', 'offline'], ['sending', undefined], ['observed_success', undefined]]);
        await act(async () => { committed({ kind: 'failed' }); });
        await hook.unmount();
    });
    it('settles a committed send even when its mutation is acknowledged before a render observes it', async () => {
        const calls: string[] = [];
        const hook = await renderHook(() => useDiscussionAttachmentSettlement({}));
        await act(async () => { await hook.getCurrent()('post-2', { sources: [], settle: (status: string) => { calls.push(status); } }, Promise.resolve({ kind: 'succeeded' })); });
        expect(calls).toEqual(['observed_success']);
        await hook.unmount();
    });
});
