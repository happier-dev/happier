import { describe, expect, it } from 'vitest';
import type { GetSessionFollowResponse, SetSessionFollowResponse } from '@happier-dev/protocol/sessions/follow/api';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import {
    createAccountSessionFollowController,
    type AccountSessionFollowTransport,
    type FollowTransportResult,
} from './accountSessionFollowController';

const address = { serverId: 'home-a', sessionId: 'same-id' };
const initial: GetSessionFollowResponse = {
    follow: { sessionId: 'same-id', following: true, notificationLevel: 'important', includeInVoice: false },
    isSessionOwner: false,
    capabilities: { manageFollow: true },
    voiceInitialSnapshotPending: false,
};

function createTransport(overrides: Partial<AccountSessionFollowTransport> = {}): AccountSessionFollowTransport {
    // Only the HTTP boundary is substituted; controller state and settlement stay real.
    return {
        get: async () => ({ kind: 'ok', value: initial }),
        set: async (target, preferences) => ({ kind: 'ok', value: {
            changed: true,
            follow: { ...initial.follow!, sessionId: target.sessionId, following: true, ...preferences },
            voiceInitialSnapshotPending: preferences.includeInVoice ?? false,
        } }),
        remove: async () => ({ kind: 'ok', value: { changed: true } }),
        ...overrides,
    };
}

describe('Account Session Follow controller', () => {
    it('submits a generic shared-policy editor change through the existing Follow transport', async () => {
        const controller = createAccountSessionFollowController(address, createTransport());
        await controller.refresh();
        expect(controller.getPolicyEditorModel()?.preset).toBe('important');
        await controller.editPolicy({ kind: 'event', event: { kind: 'finished' }, voice: true });
        expect(controller.getSnapshot().projection?.follow?.policy).toMatchObject({ preset: 'custom', events: {
            finished: { delivery: 'quiet', voice: true },
        } });
    });
    it('exposes Quiet and Custom form state separately from Unfollow, preserving failed drafts and one-shot custody', async () => {
        let fail = false;
        const controller = createAccountSessionFollowController(address, createTransport({
            get: async () => ({ kind: 'ok', value: { ...initial, follow: { ...initial.follow!,
                policy: { preset: 'quiet' }, once: { kind: 'first_needs_you' } } } }),
            set: async (_target, preferences) => fail ? { kind: 'failed', error: 'unavailable' }
                : { kind: 'ok', value: { changed: true, follow: { ...initial.follow!, ...preferences }, voiceInitialSnapshotPending: false } },
        }));
        await controller.refresh();
        expect(controller.getPolicyEditorState()).toMatchObject({ following: true,
            model: { preset: 'quiet' }, once: { kind: 'first_needs_you' } });
        fail = true;
        await controller.editPolicy({ kind: 'event', event: { kind: 'needs_you', type: 'blocked' }, delivery: 'interrupt' });
        await controller.refresh();
        expect(controller.getPolicyEditorState()).toMatchObject({ following: true, hasDraft: true,
            model: { preset: 'custom' }, once: { kind: 'first_needs_you' } });
        await controller.remove();
        expect(controller.getPolicyEditorState()).toMatchObject({ following: false, model: null, once: null });
    });
    it('keeps the Custom policy draft on failure and retries the same Action intent', async () => {
        const policy = { preset: 'custom' as const, events: { finished: { delivery: 'quiet' as const } } };
        let fail = true;
        const controller = createAccountSessionFollowController(address, createTransport({ set: async (_target, preferences) => {
            if (fail) return { kind: 'failed', error: 'unavailable' };
            return { kind: 'ok', value: { changed: true, follow: { ...initial.follow!, policy: preferences.policy }, voiceInitialSnapshotPending: false } };
        } }));
        await controller.refresh();
        await controller.setPolicy(policy);
        expect(controller.getSnapshot().policyDraft).toEqual(policy);
        expect(controller.getSnapshot().projection).toEqual(initial);
        fail = false;
        await controller.retry();
        expect(controller.getSnapshot().projection?.follow?.policy).toEqual(policy);
        expect(controller.getSnapshot().policyDraft).toBeNull();
    });
    it('arms and cancels only the one-shot on its captured Home and retries that exact intent', async () => {
        const submitted: unknown[] = [];
        let fail = true;
        const controller = createAccountSessionFollowController(address, createTransport({ set: async (target, preferences) => {
            submitted.push({ target, preferences });
            if (fail) return { kind: 'failed', error: 'unavailable' };
            return { kind: 'ok', value: { changed: true, follow: { ...initial.follow!, once: preferences.once }, voiceInitialSnapshotPending: false } };
        } }));
        await controller.refresh();
        await controller.setOnce({ kind: 'turn_finished', sourceTurnId: 'turn-a' });
        expect(controller.getSnapshot().projection).toEqual(initial);
        fail = false;
        await controller.retry();
        expect(controller.getSnapshot().projection?.follow).toMatchObject({ ...initial.follow!, once: { kind: 'turn_finished', sourceTurnId: 'turn-a' } });
        await controller.setOnce(null);
        expect(submitted).toEqual([
            { target: address, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'turn-a' } } },
            { target: address, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'turn-a' } } },
            { target: address, preferences: { once: null } },
        ]);
    });
    it('settles the initial Voice pending state from the refreshed Home projection', async () => {
        let pending = true;
        const controller = createAccountSessionFollowController(address, createTransport({
            get: async () => ({ kind: 'ok', value: {
                ...initial,
                follow: { ...initial.follow!, includeInVoice: true },
                voiceInitialSnapshotPending: pending,
            } }),
        }));
        await controller.refresh();
        expect(controller.getSnapshot().voiceInitialSnapshotPending).toBe(true);
        pending = false;
        await controller.refresh();
        expect(controller.getSnapshot().voiceInitialSnapshotPending).toBe(false);
    });

    it('keeps Voice independent from notifications and rolls a failed edit back to the confirmed preference', async () => {
        const response = createDeferred<FollowTransportResult<SetSessionFollowResponse>>();
        const controller = createAccountSessionFollowController(address, createTransport({ set: async () => response.promise }));
        await controller.refresh();
        const save = controller.set({ notificationLevel: 'none', includeInVoice: true });
        // A Home wake during the save must not hide the failed edit's retry.
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({
            saving: true,
            projection: initial,
            draft: { notificationLevel: 'none', includeInVoice: true },
        });
        response.resolve({ kind: 'failed', error: 'unavailable' });
        await save;
        expect(controller.getSnapshot()).toMatchObject({
            saving: false,
            projection: initial,
            error: 'unavailable',
            draft: { notificationLevel: 'none', includeInVoice: true },
        });
    });

    it('retries the edited preferences on the captured Home and preserves the successful Voice choice on a later edit', async () => {
        const submitted: Array<Readonly<{ serverId: string; sessionId: string; includeInVoice: boolean; notificationLevel: string }>> = [];
        let fail = true;
        const transport = createTransport({ set: async (target, preferences) => {
            submitted.push({ ...target, notificationLevel: preferences.notificationLevel ?? 'none', includeInVoice: preferences.includeInVoice ?? false });
            if (fail) return { kind: 'failed', error: 'unavailable' };
            return { kind: 'ok', value: {
                changed: true,
                follow: { ...initial.follow!, sessionId: target.sessionId, following: true, ...preferences },
                voiceInitialSnapshotPending: preferences.includeInVoice ?? false,
            } };
        } });
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        await controller.set({ notificationLevel: 'none', includeInVoice: true });
        fail = false;
        await controller.retry();
        expect(controller.getSnapshot().projection?.follow).toMatchObject({ notificationLevel: 'none', includeInVoice: true });
        expect(controller.getSnapshot().projection?.voiceInitialSnapshotPending).toBe(true);
        expect(controller.getSnapshot().voiceInitialSnapshotPending).toBe(true);
        await controller.set({ notificationLevel: 'all_messages', includeInVoice: true });
        expect(submitted).toEqual([
            { ...address, notificationLevel: 'none', includeInVoice: true },
            { ...address, notificationLevel: 'none', includeInVoice: true },
            { ...address, notificationLevel: 'all_messages', includeInVoice: true },
        ]);
    });

    it('does not let a stale refresh overwrite a successful mutation', async () => {
        const read = createDeferred<FollowTransportResult<GetSessionFollowResponse>>();
        let reads = 0;
        const controller = createAccountSessionFollowController(address, createTransport({
            get: async () => ++reads === 1 ? { kind: 'ok', value: initial } : read.promise,
        }));
        await controller.refresh();
        const refresh = controller.refresh();
        await controller.set({ notificationLevel: 'none', includeInVoice: true });
        read.resolve({ kind: 'ok', value: initial });
        await refresh;
        expect(controller.getSnapshot().projection?.follow).toMatchObject({ notificationLevel: 'none', includeInVoice: true });
    });

    it.each(['session_not_found', 'credential_scope_denied'] as const)('keeps an unavailable refresh visible, then clears private state after %s', async (denial) => {
        let failure: 'unavailable' | typeof denial | null = null;
        const controller = createAccountSessionFollowController(address, createTransport({
            get: async () => failure ? { kind: 'failed', error: failure } : { kind: 'ok', value: initial },
        }));
        await controller.refresh();
        failure = 'unavailable';
        await controller.refresh();
        expect(controller.getSnapshot().projection).toEqual(initial);
        failure = denial;
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ projection: null, draft: null, error: denial });
    });

    it('retains an explicit Unfollow and never sends writes while offline', async () => {
        const writes: string[] = [];
        const controller = createAccountSessionFollowController(address, createTransport({ remove: async () => {
            writes.push('remove');
            return { kind: 'ok', value: { changed: true } };
        } }));
        await controller.refresh();
        controller.setOnline(false);
        await controller.remove();
        expect(writes).toEqual([]);
        controller.setOnline(true);
        await controller.remove();
        expect(controller.getSnapshot().projection?.follow).toEqual({
            sessionId: address.sessionId, following: false, notificationLevel: 'none', includeInVoice: false,
        });
        expect(controller.getSnapshot().projection?.voiceInitialSnapshotPending).toBe(false);
        expect(controller.getSnapshot().voiceInitialSnapshotPending).toBe(false);
    });

    it('drops a late response after its editor lifetime retires', async () => {
        const read = createDeferred<FollowTransportResult<GetSessionFollowResponse>>();
        const controller = createAccountSessionFollowController(address, createTransport({ get: async () => read.promise }));
        const load = controller.refresh();
        controller.dispose();
        const retired = controller.getSnapshot();
        read.resolve({ kind: 'ok', value: initial });
        await load;
        expect(controller.getSnapshot()).toBe(retired);
    });
});
