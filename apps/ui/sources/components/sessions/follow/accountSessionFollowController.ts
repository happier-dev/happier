import { EXPLICIT_SESSION_UNFOLLOW_STATE_V1, projectAccountSessionFollowEditorStateV1, type PersonalFollowOnceV1, type SessionFollowNotificationLevel } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type {
    GetSessionFollowResponse,
    RemoveSessionFollowResponse,
    SessionFollowErrorCodeV1,
    SetSessionFollowRequest,
    SetSessionFollowResponse,
} from '@happier-dev/protocol/sessions/follow/api';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { FollowEventKindV1, FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { editFollowPolicyV1, projectFollowPolicyEditorV1, type FollowPolicyEditorEditV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';

import {
    createIdleSessionFollowMutationIntent,
    reduceSessionFollowMutationIntent,
    type SessionFollowMutationIntentEvent,
} from './sessionFollowMutationIntent';

type AccountSessionFollowIntent =
    | Readonly<{ kind: 'set'; preferences: SetSessionFollowRequest }>
    | Readonly<{ kind: 'remove' }>;

type FollowTransportError = SessionFollowErrorCodeV1 | 'credential_scope_denied' | 'unavailable';

export type FollowTransportResult<T> =
    | Readonly<{ kind: 'ok'; value: T }>
    | Readonly<{ kind: 'failed'; error: FollowTransportError }>;

export type AccountSessionFollowTransport = Readonly<{
    get(address: SessionAddress): Promise<FollowTransportResult<GetSessionFollowResponse>>;
    set(address: SessionAddress, preferences: SetSessionFollowRequest): Promise<FollowTransportResult<SetSessionFollowResponse>>;
    remove(address: SessionAddress): Promise<FollowTransportResult<RemoveSessionFollowResponse>>;
}>;

export type AccountSessionFollowEditorSnapshot = Readonly<{
    projection: GetSessionFollowResponse | null;
    /** An uncommitted form selection. Never publishes Follow interest or read state. */
    draft: Readonly<{ notificationLevel: SessionFollowNotificationLevel; includeInVoice: boolean }> | null;
    policyDraft?: FollowPolicyV1 | null;
    loading: boolean;
    saving: boolean;
    online: boolean;
    error: FollowTransportError | null;
    /** Feedback for this editor's explicit enable interaction, not a delivery acknowledgement. */
    voiceInitialSnapshotPending: boolean;
}>;

/** Personal adapter for the same event/channel editor used by Session and rule follows. */
export function projectAccountSessionFollowPolicyEditor(
    snapshot: AccountSessionFollowEditorSnapshot,
    supportedEvents?: readonly FollowEventKindV1[],
) {
    const effective = snapshot.projection ? projectAccountSessionFollowEditorStateV1({
        follow: snapshot.projection.follow, isSessionOwner: snapshot.projection.isSessionOwner,
    }) : null;
    const policy = snapshot.policyDraft ?? effective?.policy ?? null;
    return {
        /** Owner relevance is independent of an active delivery choice. */
        following: effective?.tracked === true,
        suppressed: effective?.suppressed === true,
        deliveryEnabled: effective?.policy != null,
        model: policy ? projectFollowPolicyEditorV1(policy, supportedEvents) : null,
        once: snapshot.projection?.follow?.once ?? null,
        hasDraft: snapshot.policyDraft != null,
        canEdit: snapshot.projection?.capabilities.manageFollow === true && snapshot.online && !snapshot.saving,
    };
}

/**
 * One editor lifetime over the canonical Home projection. All hosts use this
 * controller; none stores a second durable Follow choice. The injected boundary
 * is HTTP, so request/retry/race tests retain the actual state transitions.
 */
export function createAccountSessionFollowController(
    address: SessionAddress,
    transport: AccountSessionFollowTransport,
) {
    const target = Object.freeze({ ...address });
    let snapshot: AccountSessionFollowEditorSnapshot = Object.freeze({
        projection: null,
        draft: null,
        policyDraft: null,
        loading: false,
        saving: false,
        online: true,
        error: null,
        voiceInitialSnapshotPending: false,
    });
    const listeners = new Set<() => void>();
    let disposed = false;
    let activeRead: object | null = null;
    let refreshAfterSave = false;
    // The shared Follow retry owner: this editor's failed intent, its error and the rule that a
    // passive refresh reconciles the Home projection *beneath* it rather than erasing it.
    let mutation = createIdleSessionFollowMutationIntent<
        AccountSessionFollowIntent,
        FollowTransportError
    >();

    function update(patch: Partial<AccountSessionFollowEditorSnapshot>) {
        if (disposed) return;
        snapshot = Object.freeze({ ...snapshot, ...patch });
        for (const listener of listeners) listener();
    }

    function applyMutation(
        event: SessionFollowMutationIntentEvent<AccountSessionFollowIntent, FollowTransportError>,
        patch: Partial<AccountSessionFollowEditorSnapshot> = {},
    ) {
        mutation = reduceSessionFollowMutationIntent(mutation, event);
        const outstanding = mutation.pending ?? mutation.failed;
        update({
            draft: outstanding?.kind === 'set' && outstanding.preferences.notificationLevel !== undefined && outstanding.preferences.includeInVoice !== undefined
                ? { notificationLevel: outstanding.preferences.notificationLevel, includeInVoice: outstanding.preferences.includeInVoice } : null,
            policyDraft: outstanding?.kind === 'set' ? outstanding.preferences.policy ?? null : null,
            error: mutation.error,
            ...patch,
        });
    }

    function failed(error: FollowTransportError) {
        const accessLost = error === 'session_not_found' || error === 'account_inactive' || error === 'feature_unavailable'
            || error === 'credential_scope_denied';
        if (accessLost) {
            applyMutation({ kind: 'abandoned' }, {
                error,
                loading: false,
                saving: false,
                projection: null,
                voiceInitialSnapshotPending: false,
            });
            return;
        }
        applyMutation({ kind: 'failed', error }, { loading: false, saving: false });
    }

    async function refresh(): Promise<void> {
        if (disposed || !snapshot.online) return;
        if (snapshot.saving) {
            refreshAfterSave = true;
            return;
        }
        const read = {};
        activeRead = read;
        update({ loading: true, ...(mutation.failed === null ? { error: null } : {}) });
        try {
            const result = await transport.get(target);
            if (disposed || activeRead !== read) return;
            activeRead = null;
            if (result.kind === 'failed') {
                failed(result.error);
                return;
            }
            applyMutation({ kind: 'refreshed' }, {
                projection: result.value,
                loading: false,
                voiceInitialSnapshotPending: result.value.voiceInitialSnapshotPending,
            });
        } catch {
            if (disposed || activeRead !== read) return;
            activeRead = null;
            failed('unavailable');
        }
    }

    async function finishSave() {
        if (!refreshAfterSave || disposed) return;
        refreshAfterSave = false;
        await refresh();
    }

    async function set(preferences: SetSessionFollowRequest): Promise<void> {
        if (disposed || !snapshot.online || snapshot.saving || snapshot.projection?.capabilities.manageFollow !== true) return;
        activeRead = null;
        applyMutation({ kind: 'started', intent: { kind: 'set', preferences } }, { saving: true, loading: false });
        try {
            const result = await transport.set(target, preferences);
            if (disposed) return;
            if (result.kind === 'failed') {
                failed(result.error);
                return;
            }
            applyMutation({ kind: 'succeeded' }, {
                projection: {
                    follow: result.value.follow,
                    isSessionOwner: snapshot.projection?.isSessionOwner === true,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: result.value.voiceInitialSnapshotPending,
                },
                saving: false,
                voiceInitialSnapshotPending: result.value.voiceInitialSnapshotPending,
            });
        } catch {
            failed('unavailable');
        } finally {
            await finishSave();
        }
    }

    async function remove(): Promise<void> {
        if (disposed || !snapshot.online || snapshot.saving || !snapshot.projection) return;
        activeRead = null;
        applyMutation({ kind: 'started', intent: { kind: 'remove' } }, { saving: true, loading: false });
        try {
            const result = await transport.remove(target);
            if (disposed) return;
            if (result.kind === 'failed') {
                failed(result.error);
                return;
            }
            applyMutation({ kind: 'succeeded' }, {
                projection: {
                    follow: { sessionId: target.sessionId, ...EXPLICIT_SESSION_UNFOLLOW_STATE_V1 },
                    isSessionOwner: snapshot.projection?.isSessionOwner === true,
                    capabilities: snapshot.projection?.capabilities ?? { manageFollow: false },
                    voiceInitialSnapshotPending: false,
                },
                saving: false,
                voiceInitialSnapshotPending: false,
            });
        } catch {
            failed('unavailable');
        } finally {
            await finishSave();
        }
    }

    function currentEditorPolicy(): FollowPolicyV1 {
        return snapshot.policyDraft ?? (snapshot.projection ? projectAccountSessionFollowEditorStateV1({
            follow: snapshot.projection.follow, isSessionOwner: snapshot.projection.isSessionOwner,
        }).policy : null) ?? { preset: 'important' };
    }

    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        refresh,
        set,
        setOnce: (once: PersonalFollowOnceV1 | null) => set({ once }),
        setPolicy: (policy: FollowPolicyV1) => set({ policy }),
        getPolicyEditorState: (supportedEvents?: readonly FollowEventKindV1[]) => projectAccountSessionFollowPolicyEditor(snapshot, supportedEvents),
        getPolicyEditorModel: (supportedEvents?: readonly FollowEventKindV1[]) => snapshot.projection
            ? projectFollowPolicyEditorV1(currentEditorPolicy(), supportedEvents) : null,
        editPolicy: (edit: FollowPolicyEditorEditV1) => set({ policy: editFollowPolicyV1(currentEditorPolicy(), edit) }),
        remove,
        retry: async () => {
            const intent = mutation.failed;
            if (intent?.kind === 'set') await set(intent.preferences);
            else if (intent?.kind === 'remove') await remove();
            else await refresh();
        },
        setOnline(online: boolean) {
            if (online !== snapshot.online) update({ online });
        },
        dispose() {
            disposed = true;
            activeRead = null;
            listeners.clear();
        },
    };
}

export type AccountSessionFollowController = ReturnType<typeof createAccountSessionFollowController>;
