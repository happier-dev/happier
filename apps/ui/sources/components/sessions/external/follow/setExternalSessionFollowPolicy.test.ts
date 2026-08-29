import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionFollowPolicySetResponse } from '@happier-dev/protocol';

import type { ExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import type { Metadata } from '@/sync/domains/state/storageTypes';

const machineExternalSessionFollowPolicySetSpy = vi.hoisted(() => vi.fn<
    (input: Record<string, unknown>, opts?: { serverId?: string }) => Promise<ExternalSessionFollowPolicySetResponse>
>(async () => ({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 })));
const applySessionMetadataLocallySpy = vi.hoisted(() => vi.fn());
const accountCurrentnessState = vi.hoisted(() => ({ current: true }));

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionFollowPolicySet: machineExternalSessionFollowPolicySetSpy,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySessionMetadataLocally: applySessionMetadataLocallySpy,
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>(),
    captureActiveServerAccountScopeCurrentness: () => ({
        isCurrent: () => accountCurrentnessState.current,
        onRetire: () => ({ dispose() {} }),
    }),
}));

function createLink(overrides: Record<string, unknown> = {}): ExternalSessionLink {
    return {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 1_000,
        ...overrides,
    } as ExternalSessionLink;
}

function createLinkedSession(link: ExternalSessionLink, id = 'session-1'): never {
    return {
        id,
        metadata: {
            machineId: link.machineId,
            externalSessionV1: link,
        },
    } as never;
}

async function importOwner() {
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    const sessions: Record<string, never> = {};
    registerStorageStateReader(() => ({ sessions } as never));
    const { setExternalSessionFollowPolicy } = await import('./setExternalSessionFollowPolicy');
    const setSessions = (byId: Record<string, never>) => {
        for (const key of Object.keys(sessions)) delete sessions[key];
        Object.assign(sessions, byId);
    };
    return { setExternalSessionFollowPolicy, setSessions };
}

function call(
    owner: Awaited<ReturnType<typeof importOwner>>['setExternalSessionFollowPolicy'],
    link: ExternalSessionLink,
    policy: 'background_follow' | 'attached_only' = 'background_follow',
) {
    return owner({
        sessionId: 'session-1',
        serverId: 'server-1',
        link,
        policy,
    });
}

describe('setExternalSessionFollowPolicy', () => {
    beforeEach(() => {
        accountCurrentnessState.current = true;
        machineExternalSessionFollowPolicySetSpy.mockClear();
        machineExternalSessionFollowPolicySetSpy.mockImplementation(
            async () => ({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 }),
        );
        applySessionMetadataLocallySpy.mockClear();
    });

    afterEach(async () => {
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        registerStorageStateReader(() => null as never);
    });

    it('serializes rapid toggles for one scoped link so the last completed intent stays visible', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(link) });

        let resolveEnable: ((value: ExternalSessionFollowPolicySetResponse) => void) | undefined;
        let resolveDisable: ((value: ExternalSessionFollowPolicySetResponse) => void) | undefined;
        const enableResponse = new Promise<ExternalSessionFollowPolicySetResponse>((resolve) => {
            resolveEnable = resolve;
        });
        const disableResponse = new Promise<ExternalSessionFollowPolicySetResponse>((resolve) => {
            resolveDisable = resolve;
        });
        machineExternalSessionFollowPolicySetSpy
            .mockReturnValueOnce(enableResponse)
            .mockReturnValueOnce(disableResponse);

        const enable = call(setExternalSessionFollowPolicy, link, 'background_follow');
        const disable = call(setExternalSessionFollowPolicy, link, 'attached_only');
        // Release the microtasks the per-scope chain needs to start the first
        // request, then assert the ordering contract.
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // The second request waits for the first settlement: enable runs first.
        expect(machineExternalSessionFollowPolicySetSpy).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionFollowPolicySetSpy).toHaveBeenNthCalledWith(1,
            expect.objectContaining({ enabled: true }),
            { serverId: 'server-1' },
        );

        resolveEnable?.({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
        await enable;
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(machineExternalSessionFollowPolicySetSpy).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionFollowPolicySetSpy).toHaveBeenNthCalledWith(2,
            expect.objectContaining({ enabled: false }),
            { serverId: 'server-1' },
        );
        resolveDisable?.({ ok: true, enabled: false, leaseActive: false, updatedAtMs: 84 });

        await expect(disable).resolves.toEqual({ kind: 'applied' });
        expect(applySessionMetadataLocallySpy).toHaveBeenCalledTimes(2);
        expect(applySessionMetadataLocallySpy).toHaveBeenLastCalledWith(
            'session-1',
            expect.any(Function),
        );
    });

    it('retires a late settlement without publishing when the Account is no longer current', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(link) });

        let settle: ((value: ExternalSessionFollowPolicySetResponse) => void) | undefined;
        machineExternalSessionFollowPolicySetSpy.mockReturnValueOnce(
            new Promise<ExternalSessionFollowPolicySetResponse>((resolve) => {
                settle = resolve;
            }),
        );

        const request = call(setExternalSessionFollowPolicy, link);
        accountCurrentnessState.current = false;
        settle?.({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });

        await expect(request).resolves.toEqual({ kind: 'stale' });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();
    });

    it('retires the settlement when the session relinked to a different external identity', async () => {
        const originalLink = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(originalLink) });

        let settle: ((value: ExternalSessionFollowPolicySetResponse) => void) | undefined;
        machineExternalSessionFollowPolicySetSpy.mockReturnValueOnce(
            new Promise<ExternalSessionFollowPolicySetResponse>((resolve) => {
                settle = resolve;
            }),
        );

        const request = call(setExternalSessionFollowPolicy, originalLink);
        // The session relinked to a different remote identity while the request
        // was in flight; the old link's result may not land on the new link.
        setSessions({ 'session-1': createLinkedSession(createLink({ remoteSessionId: 'remote-2', linkedAtMs: 2_000 })) });
        settle?.({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });

        await expect(request).resolves.toEqual({ kind: 'stale' });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();
    });

    it('retires the settlement when the linked session is no longer present', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(link) });

        let settle: ((value: ExternalSessionFollowPolicySetResponse) => void) | undefined;
        machineExternalSessionFollowPolicySetSpy.mockReturnValueOnce(
            new Promise<ExternalSessionFollowPolicySetResponse>((resolve) => {
                settle = resolve;
            }),
        );

        const request = call(setExternalSessionFollowPolicy, link);
        setSessions({});
        settle?.({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });

        await expect(request).resolves.toEqual({ kind: 'stale' });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();
    });

    it('maps daemon refusals without treating an unsupported capability as a transport failure', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(link) });

        machineExternalSessionFollowPolicySetSpy.mockResolvedValueOnce({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        } as ExternalSessionFollowPolicySetResponse);
        await expect(call(setExternalSessionFollowPolicy, link)).resolves.toEqual({
            kind: 'refused',
            reason: 'unsupported',
        });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();

        machineExternalSessionFollowPolicySetSpy.mockResolvedValueOnce({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'session_not_running',
        } as ExternalSessionFollowPolicySetResponse);
        await expect(call(setExternalSessionFollowPolicy, link)).resolves.toEqual({
            kind: 'refused',
            reason: 'error',
        });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();
    });

    it('reports a thrown transport failure as failed and keeps the metadata untouched', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        setSessions({ 'session-1': createLinkedSession(link) });

        machineExternalSessionFollowPolicySetSpy.mockRejectedValueOnce(new Error('machine rpc failed'));
        await expect(call(setExternalSessionFollowPolicy, link)).resolves.toEqual({ kind: 'failed' });
        expect(applySessionMetadataLocallySpy).not.toHaveBeenCalled();
    });

    it('applies the requested policy through the canonical metadata writer on success', async () => {
        const link = createLink();
        const { setExternalSessionFollowPolicy, setSessions } = await importOwner();
        const session = createLinkedSession(link);
        setSessions({ 'session-1': session });
        const { readExternalSessionLink } = await import(
            '@/sync/domains/session/external/readExternalSessionLink'
        );
        applySessionMetadataLocallySpy.mockImplementation(
            (sessionId: string, updater: (metadata: Metadata) => Metadata) => {
                const source = (session as unknown as { metadata: Metadata }).metadata;
                const updated = updater(source);
                return {
                    ...readExternalSessionLink(updated),
                    identity: sessionId,
                };
            },
        );

        await expect(
            call(setExternalSessionFollowPolicy, link, 'attached_only'),
        ).resolves.toEqual({ kind: 'applied' });
        expect(machineExternalSessionFollowPolicySetSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 'session-1',
            agentId: 'claude',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            enabled: false,
        }, { serverId: 'server-1' });
        expect(applySessionMetadataLocallySpy).toHaveBeenCalledWith('session-1', expect.any(Function));
        const updater = applySessionMetadataLocallySpy.mock.calls[0]?.[1] as
            | ((metadata: Metadata) => Metadata)
            | undefined;
        const updated = updater?.((session as unknown as { metadata: Metadata }).metadata);
        expect(readExternalSessionLink(updated)?.followPolicyV1).toEqual({
            v: 1,
            policy: 'attached_only',
            updatedAtMs: 42,
        });
    });
});
