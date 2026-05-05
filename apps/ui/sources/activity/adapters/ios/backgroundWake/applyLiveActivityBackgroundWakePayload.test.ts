import { describe, expect, it } from 'vitest';

async function loadModule() {
    return import('./applyLiveActivityBackgroundWakePayload').catch(() => null);
}

function createContentState(overrides: Record<string, unknown> = {}) {
    return {
        version: 1,
        generatedAt: 1_000,
        staleAt: 1_801_000,
        sessionId: 'session-1',
        title: 'Session work',
        subtitle: null,
        previewText: null,
        statusText: null,
        attentionState: 'thinking',
        defaultTarget: 'open-session:session-1?serverId=server-a',
        sessionTarget: 'open-session:session-1?serverId=server-a',
        overflowCount: 0,
        totalAttentionCount: 1,
        allowActionButtons: true,
        labels: {
            title: 'Happier Focus',
            openLabel: 'Open',
            inboxLabel: 'Inbox',
            attentionLabel: 'Attention',
        },
        ...overrides,
    };
}

function createWakePayload(overrides: Record<string, unknown> = {}) {
    return {
        type: 'happier.liveActivityRemoteUpdate.v1',
        v: 1,
        requestId: 'wake-1',
        createdAt: 1_000,
        event: 'update',
        activityKey: {
            serverId: 'server-a',
            sessionId: 'session-1',
            activityName: 'HappierFocusLiveActivity',
        },
        snapshotFingerprint: 'fingerprint-new',
        contentState: createContentState(),
        ...overrides,
    };
}

describe('applyLiveActivityBackgroundWakePayload', () => {
    it('applies a sanitized background wake snapshot when it is newer than local state', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveLiveActivityBackgroundWakePayloadApplication({
            payload: createWakePayload(),
            current: {
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
                generatedAt: 500,
                snapshotFingerprint: 'fingerprint-old',
            },
        });

        expect(result).toMatchObject({
            action: 'apply_update',
            snapshot: {
                serverId: 'server-a',
                sessionId: 'session-1',
                activityName: 'HappierFocusLiveActivity',
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
                title: 'Session work',
            },
        });
    });

    it('ignores old background wake payloads so they cannot regress newer local state', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveLiveActivityBackgroundWakePayloadApplication({
            payload: createWakePayload({
                createdAt: 1_000,
                contentState: createContentState({ generatedAt: 1_000 }),
            }),
            current: {
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
                generatedAt: 2_000,
                snapshotFingerprint: 'fingerprint-newer-local',
            },
        });

        expect(result).toEqual({
            action: 'ignore',
            reason: 'older_than_current',
        });
    });

    it('ignores matching fingerprints because the local activity is already current', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveLiveActivityBackgroundWakePayloadApplication({
            payload: createWakePayload({ snapshotFingerprint: 'same-fingerprint' }),
            current: {
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
                generatedAt: 1_000,
                snapshotFingerprint: 'same-fingerprint',
            },
        });

        expect(result).toEqual({
            action: 'ignore',
            reason: 'same_fingerprint',
        });
    });

    it('maps end events to the exact server-scoped activity identity', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveLiveActivityBackgroundWakePayloadApplication({
            payload: createWakePayload({
                event: 'end',
                contentState: null,
            }),
            current: {
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
                generatedAt: 1_000,
                snapshotFingerprint: 'fingerprint-old',
            },
        });

        expect(result).toEqual({
            action: 'apply_end',
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
        });
    });

    it('rejects malformed background wake payloads', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveLiveActivityBackgroundWakePayloadApplication({
            payload: {
                type: 'happier.liveActivityRemoteUpdate.v1',
                v: 1,
                event: 'start',
            },
            current: null,
        });

        expect(result).toEqual({
            action: 'ignore',
            reason: 'invalid_payload',
        });
    });
});
