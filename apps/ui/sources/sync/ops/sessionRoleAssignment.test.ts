import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionRoleAssignmentMessageV1, buildSessionRoleClearedMessageV1 } from '@happier-dev/protocol';

// The sync engine's socket CAS writer and the pending-outbox transport are the boundaries.
// Their retry/merge and outbox contracts are proven by their own owners; the role decision,
// snapshot, message text and ordering here stay real.
const boundary = vi.hoisted(() => ({
    metadata: {} as Record<string, unknown>,
    patch: vi.fn(),
    send: vi.fn(),
    settings: {} as Record<string, unknown>,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ patchSessionMetadataWithRetry: boundary.patch }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
    sendSessionMessageWithServerScope: boundary.send,
}));
// Credential storage behind server-scope resolution is a boundary; server-b and server-c are non-active accounts.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: vi.fn(async ({ serverId }: { serverId?: string | null }) => (
        serverId === 'server-b' || serverId === 'server-c'
            ? { scope: 'scoped', timeoutMs: 1, targetServerId: serverId, targetServerUrl: `https://${serverId}.test`,
                targetAccountId: `account-${serverId}`, token: 't', encryption: {} }
            : { scope: 'active', timeoutMs: 1 }
    )),
}));

describe('setSessionRoleWithDelivery', () => {
    beforeEach(async () => {
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'coordinator' };
        boundary.metadata = { path: '/repo', permissionMode: 'read-only', sessionOriginV1: origin, summary: { text: 'T', updatedAt: 1 } };
        boundary.patch.mockReset().mockImplementation(async (_id: string, updater: (m: Record<string, unknown>) => Record<string, unknown>) => {
            boundary.metadata = updater(boundary.metadata);
        });
        boundary.send.mockReset().mockResolvedValue({ ok: true, ack: { ok: true, persistence: 'pending' } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'Edited reviewer rules.' } } } }));
    });

    it('records the snapshot, then queues the visible instruction through the canonical outbox with an idempotent id', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        const before = structuredClone(boundary.metadata);

        const result = await setSessionRoleWithDelivery({ sessionId: 's1', role: 'reviewer', serverId: 'server-a' });

        expect(result).toMatchObject({ ok: true });
        const role = boundary.metadata.sessionRoleV1 as { role: string; instructions: string; assignmentId: string };
        expect(role).toMatchObject({ v: 1, role: 'reviewer', instructions: 'Edited reviewer rules.' });
        const { sessionRoleV1: _role, ...unchanged } = boundary.metadata;
        expect(unchanged).toEqual(before);
        expect(boundary.patch.mock.invocationCallOrder[0]).toBeLessThan(boundary.send.mock.invocationCallOrder[0]);
        expect(boundary.send).toHaveBeenCalledWith({
            sessionId: 's1',
            serverId: 'server-a',
            message: buildSessionRoleAssignmentMessageV1({ role: 'reviewer', instructions: 'Edited reviewer rules.' }),
            localId: `session-role:${role.assignmentId}`,
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it('assigns a current custom profile, resumes its retained snapshot after deletion, and rejects a new assignment', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        const { storage } = await import('@/sync/domains/state/storage');
        const customRole = 'custom:123e4567-e89b-12d3-a456-426614174000' as const;
        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: {},
                customRoles: [{ id: customRole, name: 'Architect', instructions: 'Design.', color: '#123456' }],
            },
        } }));

        expect(await setSessionRoleWithDelivery({ sessionId: 's1', role: customRole, serverId: null, actionRequestId: 'custom-1' }))
            .toMatchObject({ ok: true });
        const retained = boundary.metadata.sessionRoleV1;
        expect(retained).toMatchObject({ role: customRole, name: 'Architect', color: '#123456', instructions: 'Design.' });

        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: { v: 1, instructionsByRole: {}, customRoles: [] },
        } }));
        expect(await setSessionRoleWithDelivery({ sessionId: 's1', role: customRole, serverId: null, actionRequestId: 'custom-1', resume: true }))
            .toMatchObject({ ok: true });
        expect(boundary.metadata.sessionRoleV1).toBe(retained);
        const writesBeforeRejectedAssignment = boundary.patch.mock.calls.length;
        expect(await setSessionRoleWithDelivery({ sessionId: 's1', role: customRole, serverId: null }))
            .toMatchObject({ ok: false, stage: 'settings', error: 'session_role_profile_not_found' });
        expect(boundary.patch).toHaveBeenCalledTimes(writesBeforeRejectedAssignment);
        expect(boundary.metadata.sessionRoleV1).toBe(retained);
    });

    it('reapplies the current role with a fresh snapshot and a new instruction', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        await setSessionRoleWithDelivery({ sessionId: 's1', role: 'reviewer', serverId: null });
        const first = boundary.metadata.sessionRoleV1 as { assignmentId: string };
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'Newer reviewer rules.' } } } }));
        await setSessionRoleWithDelivery({ sessionId: 's1', role: 'reviewer', serverId: null });
        const second = boundary.metadata.sessionRoleV1 as { assignmentId: string; instructions: string };
        expect(second.instructions).toBe('Newer reviewer rules.');
        expect(second.assignmentId).not.toBe(first.assignmentId);
        expect(boundary.send).toHaveBeenCalledTimes(2);
    });

    it('session.role.set with a recycled request id and no resume applies a new visible change (real UI executor)', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        // Agent tool bridges pass MCP JSON-RPC ids, which restart per client connection.
        await executor.execute('session.role.set', { sessionId: 's1', role: 'worker' }, { actionRequestId: '7' });
        const first = boundary.metadata.sessionRoleV1 as { assignmentId: string };
        const result = await executor.execute('session.role.set', { sessionId: 's1', role: 'planner' }, { actionRequestId: '7' });
        const second = boundary.metadata.sessionRoleV1 as { assignmentId: string };

        expect(result).toMatchObject({ ok: true });
        expect(second).toMatchObject({ role: 'planner', actionRequestId: '7' });
        expect(second.assignmentId).not.toBe(first.assignmentId);
        const sends = boundary.send.mock.calls.map((call) => call[0] as { localId: string; message: string });
        expect(sends.map((send) => send.localId)).toEqual([`session-role:${first.assignmentId}`, `session-role:${second.assignmentId}`]);
        expect(sends[1]?.message.startsWith('Role assignment: Planner')).toBe(true);
    });

    it('clears only the role and queues the visible clearing instruction', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        await setSessionRoleWithDelivery({ sessionId: 's1', role: 'planner', serverId: null });
        await setSessionRoleWithDelivery({ sessionId: 's1', role: null, serverId: null });
        expect(boundary.metadata).not.toHaveProperty('sessionRoleV1');
        expect(boundary.metadata.permissionMode).toBe('read-only');
        expect(boundary.send).toHaveBeenLastCalledWith(expect.objectContaining({
            message: buildSessionRoleClearedMessageV1(),
            requestedAction: { v: 1, kind: 'enqueue' },
        }));
    });

    it('resolves the instruction snapshot from the target account, never the active one', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        saveAccountSettings({ serverId: 'server-b', accountId: 'account-server-b' } as never,
            settingsParse({ sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'B reviewer rules.' } } }), 3);

        const result = await setSessionRoleWithDelivery({ sessionId: 's-b', role: 'reviewer', serverId: 'server-b' });

        expect(result).toMatchObject({ ok: true });
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ role: 'reviewer', instructions: 'B reviewer rules.' });
        const sent = boundary.send.mock.calls[0]?.[0] as { message: string; serverId: string };
        expect(sent.serverId).toBe('server-b');
        expect(sent.message).toContain('B reviewer rules.');
        expect(JSON.stringify(boundary.patch.mock.calls) + sent.message).not.toContain('Edited reviewer rules.');
    });

    it('refuses to assign when the target account profile is unknown on this device, without writing or queueing', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        const before = structuredClone(boundary.metadata);
        const result = await setSessionRoleWithDelivery({ sessionId: 's-c', role: 'planner', serverId: 'server-c' });
        expect(result).toMatchObject({ ok: false, stage: 'settings' });
        expect(boundary.patch).not.toHaveBeenCalled();
        expect(boundary.send).not.toHaveBeenCalled();
        expect(boundary.metadata).toEqual(before);
    });

    it('reports an undelivered instruction honestly and retries the same message without rewriting the role', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });

        const result = await setSessionRoleWithDelivery({ sessionId: 's1', role: 'worker', serverId: null });

        expect(result).toMatchObject({ ok: false, stage: 'delivery', errorCode: 'session_not_found' });
        if (result.ok || result.stage !== 'delivery') throw new Error('expected a delivery failure');
        const assignment = boundary.metadata.sessionRoleV1;
        const firstSend = boundary.send.mock.calls[0]?.[0];
        expect(await result.retry()).toMatchObject({ ok: true });
        expect(boundary.send.mock.calls[1]?.[0]).toEqual(firstSend);
        expect(boundary.patch).toHaveBeenCalledTimes(1);
        expect(boundary.metadata.sessionRoleV1).toBe(assignment);
    });

    it('an explicit resume after a profile edit delivers the persisted snapshot and localId; a new request uses the edit', async () => {
        const { setSessionRoleForAction } = await import('./sessionRoleAssignment');
        const { storage } = await import('@/sync/domains/state/storage');
        const originalMessage = buildSessionRoleAssignmentMessageV1({ role: 'reviewer', instructions: 'Edited reviewer rules.' });
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        expect(await setSessionRoleForAction({ sessionId: 's1', role: 'reviewer', serverId: null, actionRequestId: 'req-9' }))
            .toMatchObject({ ok: false, errorCode: 'role_instruction_not_delivered', roleSaved: true });
        const firstLocalId = (boundary.send.mock.calls[0]?.[0] as { localId: string }).localId;

        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'Later reviewer rules.' } } } }));
        expect(await setSessionRoleForAction({ sessionId: 's1', role: 'reviewer', serverId: null, actionRequestId: 'req-9', resume: true }))
            .toMatchObject({ ok: true, instructionLocalId: firstLocalId });

        expect(boundary.metadata.sessionRoleV1).toMatchObject({ instructions: 'Edited reviewer rules.', actionRequestId: 'req-9' });
        const sends = boundary.send.mock.calls.map((call) => call[0] as { localId: string; message: string });
        expect(sends.map((send) => [send.localId, send.message])).toEqual([
            [firstLocalId, originalMessage],
            [firstLocalId, originalMessage],
        ]);

        await setSessionRoleForAction({ sessionId: 's1', role: 'reviewer', serverId: null, actionRequestId: 'req-10' });
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ instructions: 'Later reviewer rules.', actionRequestId: 'req-10' });
        const latest = boundary.send.mock.calls[2]?.[0] as { localId: string; message: string };
        expect(latest.localId).not.toBe(firstLocalId);
        expect(latest.message).toBe(buildSessionRoleAssignmentMessageV1({ role: 'reviewer', instructions: 'Later reviewer rules.' }));
    });

    it('session.role.set resume resolves a current assignment and cannot overwrite a newer role (real UI executor)', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const run = (role: string, actionRequestId: string, resumeActionRequest?: boolean) => executor.execute(
            'session.role.set',
            { sessionId: 's1', role },
            { actionRequestId, ...(resumeActionRequest ? { resumeActionRequest } : {}) },
        );
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        await run('worker', 'req-9');
        const worker = boundary.metadata.sessionRoleV1;
        expect(await run('worker', 'req-9', true)).toMatchObject({ ok: true });
        expect(boundary.metadata.sessionRoleV1).toBe(worker);

        await run('reviewer', 'req-10');
        const reviewer = boundary.metadata.sessionRoleV1;
        const sendsBeforeStaleResume = boundary.send.mock.calls.length;
        expect(await run('worker', 'req-9', true)).toMatchObject({ ok: false, errorCode: 'role_change_not_current' });
        expect(boundary.metadata.sessionRoleV1).toBe(reviewer);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeStaleResume);
    });

    it('session.role.set never resolves a resumed clear: no write of a role and no re-sent note (real UI executor)', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        await executor.execute('session.role.set', { sessionId: 's1', role: 'planner' }, { actionRequestId: 'req-7' });
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        await executor.execute('session.role.set', { sessionId: 's1', role: 'none' }, { actionRequestId: 'req-8' });
        const sendsBeforeResume = boundary.send.mock.calls.length;

        for (const actionRequestId of ['req-8', 'req-11']) {
            expect(await executor.execute('session.role.set', { sessionId: 's1', role: 'none' }, { actionRequestId, resumeActionRequest: true }))
                .toMatchObject({ ok: false, errorCode: 'role_change_not_current' });
        }
        expect(boundary.metadata).not.toHaveProperty('sessionRoleV1');
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeResume);
    });

    it('session.role.set rejects a resume whose role differs from the recorded attempt (real UI executor)', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        await executor.execute('session.role.set', { sessionId: 's1', role: 'planner' }, { actionRequestId: 'req-9' });
        const planner = boundary.metadata.sessionRoleV1;
        const sendsBeforeResume = boundary.send.mock.calls.length;

        for (const role of ['reviewer', 'none']) {
            expect(await executor.execute('session.role.set', { sessionId: 's1', role }, { actionRequestId: 'req-9', resumeActionRequest: true }))
                .toMatchObject({ ok: false, errorCode: 'role_change_not_current' });
        }
        expect(boundary.metadata.sessionRoleV1).toBe(planner);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeResume);
        expect(await executor.execute('session.role.set', { sessionId: 's1', role: 'planner' }, { actionRequestId: 'req-9', resumeActionRequest: true }))
            .toMatchObject({ ok: true, result: { ok: true, role: 'planner', action: 'assigned' } });
    });

    it('rejected resumes (role mismatch, clear, stale) emit no metadata update through the real CAS writer (real UI executor)', async () => {
        const { updateSessionMetadataWithRetry } = await import('@/sync/domains/session/metadata/updateSessionMetadataWithRetry');
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        // Route the sync boundary through the real writer so an emitted update-metadata is observable.
        let version = 1;
        const emitUpdateMetadata = vi.fn(async (payload: { metadata: string }) => {
            boundary.metadata = JSON.parse(payload.metadata) as Record<string, unknown>;
            version += 1;
            return { result: 'success' as const };
        });
        boundary.patch.mockImplementation(async (_id: string, updater: (m: Record<string, unknown>) => Record<string, unknown>) => {
            await updateSessionMetadataWithRetry<Record<string, unknown>>({
                sessionId: 's1',
                getSession: () => ({ metadataVersion: version, metadata: boundary.metadata }),
                refreshSessions: async () => {},
                encryptMetadata: async (metadata) => JSON.stringify(metadata),
                decryptMetadata: async (_v, encrypted) => JSON.parse(encrypted) as Record<string, unknown>,
                emitUpdateMetadata,
                applySessionMetadata: () => {},
                updater,
            });
        });
        const executor = createDefaultActionExecutor();
        const run = (role: string, actionRequestId: string, resumeActionRequest?: boolean) => executor.execute(
            'session.role.set',
            { sessionId: 's1', role },
            { actionRequestId, ...(resumeActionRequest ? { resumeActionRequest } : {}) },
        );

        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        await run('planner', 'req-9');
        await run('reviewer', 'req-10');
        const writesBefore = emitUpdateMetadata.mock.calls.length;
        const sendsBefore = boundary.send.mock.calls.length;
        expect(writesBefore).toBe(2);

        // Role mismatch with the current request, a clear, and a stale (superseded) request.
        for (const [role, id] of [['planner', 'req-10'], ['none', 'req-10'], ['planner', 'req-9']] as const) {
            expect(await run(role, id, true)).toMatchObject({ ok: false, errorCode: 'role_change_not_current' });
        }
        expect(emitUpdateMetadata).toHaveBeenCalledTimes(writesBefore);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBefore);
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ role: 'reviewer', actionRequestId: 'req-10' });

        // Ordinary fresh changes still write and deliver.
        await run('worker', 'req-11');
        expect(emitUpdateMetadata).toHaveBeenCalledTimes(writesBefore + 1);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBefore + 1);
    });

    it('session.role.set resume of an old clear cannot remove a newer assignment (real UI executor)', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        await executor.execute('session.role.set', { sessionId: 's1', role: 'planner' }, { actionRequestId: 'req-7' });
        await executor.execute('session.role.set', { sessionId: 's1', role: 'none' }, { actionRequestId: 'req-8' });
        await executor.execute('session.role.set', { sessionId: 's1', role: 'reviewer' }, { actionRequestId: 'req-10' });
        const reviewer = boundary.metadata.sessionRoleV1;
        const sendsBeforeStaleResume = boundary.send.mock.calls.length;

        expect(await executor.execute('session.role.set', { sessionId: 's1', role: 'none' }, { actionRequestId: 'req-8', resumeActionRequest: true }))
            .toMatchObject({ ok: false, errorCode: 'role_change_not_current' });
        expect(boundary.metadata.sessionRoleV1).toBe(reviewer);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeStaleResume);
    });

    it('reports agent-facing outcomes truthfully: explicit clear, saved-but-undelivered, and nothing saved', async () => {
        const { setSessionRoleForAction } = await import('./sessionRoleAssignment');
        await setSessionRoleForAction({ sessionId: 's1', role: 'planner', serverId: null });
        expect(await setSessionRoleForAction({ sessionId: 's1', role: null, serverId: null }))
            .toMatchObject({ ok: true, role: null, action: 'cleared' });
        boundary.send.mockResolvedValueOnce({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
        const undelivered = await setSessionRoleForAction({ sessionId: 's1', role: 'reviewer', serverId: null });
        expect(undelivered).toMatchObject({ ok: false, errorCode: 'role_instruction_not_delivered', roleSaved: true, role: 'reviewer' });
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ role: 'reviewer' });
        expect(await setSessionRoleForAction({ sessionId: 's-c', role: 'planner', serverId: 'server-c' }))
            .toMatchObject({ ok: false, errorCode: 'role_profiles_unavailable', roleSaved: false });
    });

    it('does not queue an instruction when the role could not be recorded', async () => {
        const { setSessionRoleWithDelivery } = await import('./sessionRoleAssignment');
        boundary.patch.mockRejectedValueOnce(new Error('version mismatch exhausted'));
        const result = await setSessionRoleWithDelivery({ sessionId: 's1', role: 'planner', serverId: null });
        expect(result).toMatchObject({ ok: false, stage: 'metadata' });
        expect(boundary.send).not.toHaveBeenCalled();
    });
});
