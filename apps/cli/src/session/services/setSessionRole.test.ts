import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionRoleAssignmentMessageV1, buildSessionRoleClearedMessageV1, DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1 } from '@happier-dev/protocol';

// The CAS metadata writer, the message transport, and account-settings HTTP are this
// service's boundaries; each has its own owner tests. The role decision, snapshot,
// message, ordering and truthful result stay real.
const boundary = vi.hoisted(() => ({
    metadata: {} as Record<string, unknown>,
    update: vi.fn(),
    send: vi.fn(),
    settings: vi.fn(),
}));
vi.mock('./updateSessionMetadataForTarget', () => ({ updateSessionMetadataForTarget: boundary.update }));
vi.mock('./sendSessionMessage', () => ({ sendSessionMessage: boundary.send }));
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({ bootstrapAccountSettingsContext: boundary.settings }));

const credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } } as never;

describe('setSessionRole', () => {
    beforeEach(() => {
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'planner' };
        boundary.metadata = { path: '/repo', permissionMode: 'read-only', sessionOriginV1: origin, folder: 'kept' };
        boundary.update.mockReset().mockImplementation(async ({ updater }: { updater: (m: Record<string, unknown>) => Record<string, unknown> }) => {
            boundary.metadata = updater(boundary.metadata);
            return { ok: true, sessionId: 'sess-2', metadata: boundary.metadata, version: 2 };
        });
        boundary.send.mockReset().mockResolvedValue({ ok: true, sessionId: 'sess-2' });
        boundary.settings.mockReset().mockResolvedValue({
            settings: { sessionRoleProfilesV1: { v: 1, instructionsByRole: { worker: 'Account worker rules.' } } },
        });
    });

    it('records the account snapshot, then queues the visible instruction with the shared idempotent id', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        const before = structuredClone(boundary.metadata);

        const result = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker' });

        expect(result).toMatchObject({ ok: true, sessionId: 'sess-2', role: 'worker', action: 'assigned' });
        const { sessionRoleV1, ...rest } = boundary.metadata;
        expect(rest).toEqual(before);
        expect(sessionRoleV1).toMatchObject({ v: 1, role: 'worker', instructions: 'Account worker rules.' });
        const assignmentId = (sessionRoleV1 as { assignmentId: string }).assignmentId;
        expect(boundary.update.mock.invocationCallOrder[0]).toBeLessThan(boundary.send.mock.invocationCallOrder[0]);
        expect(boundary.send).toHaveBeenCalledWith(expect.objectContaining({
            idOrPrefix: 'sess-2',
            message: buildSessionRoleAssignmentMessageV1({ role: 'worker', instructions: 'Account worker rules.' }),
            localId: `session-role:${assignmentId}`,
            requestedAction: { v: 1, kind: 'enqueue' },
            wait: false,
        }));
    });

    it('applies a recycled external request id without resume as a new visible change with a fresh identity', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        // MCP JSON-RPC ids restart per client connection: the second call is a genuinely new change.
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: '7' });
        const first = boundary.metadata.sessionRoleV1 as { assignmentId: string };
        const result = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner', actionRequestId: '7' });
        const second = boundary.metadata.sessionRoleV1 as { assignmentId: string };

        expect(second).toMatchObject({ role: 'planner', actionRequestId: '7' });
        expect(second.assignmentId).not.toBe(first.assignmentId);
        expect(second.assignmentId).not.toBe('7');
        expect(result).toMatchObject({ ok: true, role: 'planner', instructionLocalId: `session-role:${second.assignmentId}` });
        const sends = boundary.send.mock.calls.map((call) => call[0] as { localId: string; message: string });
        expect(sends.map((send) => send.localId)).toEqual([`session-role:${first.assignmentId}`, `session-role:${second.assignmentId}`]);
        expect(sends[1]?.message).toBe(buildSessionRoleAssignmentMessageV1({ role: 'planner', instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.planner }));
    });

    it('clears explicitly and says so', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'reviewer' });
        const result = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: null });
        expect(result).toMatchObject({ ok: true, role: null, action: 'cleared' });
        expect(boundary.metadata).not.toHaveProperty('sessionRoleV1');
        expect(boundary.metadata.permissionMode).toBe('read-only');
        expect(boundary.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: buildSessionRoleClearedMessageV1() }));
    });

    it('reports a saved role whose instruction was not delivered, with the exact message to resend', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'session_not_found' });
        const result = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner' });
        expect(result).toMatchObject({ ok: false, errorCode: 'role_instruction_not_delivered', roleSaved: true, role: 'planner' });
        if (result.ok || result.errorCode !== 'role_instruction_not_delivered') throw new Error('expected undelivered');
        expect(result.instruction).toEqual({
            localId: boundary.send.mock.calls[0]?.[0].localId,
            message: boundary.send.mock.calls[0]?.[0].message,
        });
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ role: 'planner' });
    });

    it('an explicit resume after a profile edit delivers the persisted snapshot and localId; a new request uses the edit', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        const originalMessage = buildSessionRoleAssignmentMessageV1({ role: 'worker', instructions: 'Account worker rules.' });
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'delivery_failed' });
        const failed = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-9' });
        expect(failed).toMatchObject({ ok: false, errorCode: 'role_instruction_not_delivered', roleSaved: true });
        const recorded = boundary.metadata.sessionRoleV1;
        const firstLocalId = boundary.send.mock.calls[0]?.[0].localId as string;

        boundary.settings.mockResolvedValue({
            settings: { sessionRoleProfilesV1: { v: 1, instructionsByRole: { worker: 'Edited worker rules.' } } },
        });
        const resumed = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-9', resume: true });

        expect(resumed).toMatchObject({ ok: true, instructionLocalId: firstLocalId });
        expect(boundary.metadata.sessionRoleV1).toBe(recorded);
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ instructions: 'Account worker rules.', actionRequestId: 'req-9' });
        expect(boundary.send.mock.calls.map((call) => [call[0].localId, call[0].message])).toEqual([
            [firstLocalId, originalMessage],
            [firstLocalId, originalMessage],
        ]);

        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-10' });
        expect(boundary.metadata.sessionRoleV1).toMatchObject({ instructions: 'Edited worker rules.', actionRequestId: 'req-10' });
        expect(boundary.send.mock.calls[2]?.[0].localId).not.toBe(firstLocalId);
        expect(boundary.send.mock.calls[2]?.[0].message)
            .toBe(buildSessionRoleAssignmentMessageV1({ role: 'worker', instructions: 'Edited worker rules.' }));
    });

    it('assigns a catalog custom role and resumes its retained snapshot after catalog deletion', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        const customRole = 'custom:123e4567-e89b-12d3-a456-426614174000' as const;
        boundary.settings.mockResolvedValue({
            settings: {
                sessionRoleProfilesV1: {
                    v: 1,
                    instructionsByRole: {},
                    customRoles: [{ id: customRole, name: 'Architect', instructions: 'Design.', color: '#123456' }],
                },
            },
        });
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'delivery_failed' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: customRole, actionRequestId: 'custom-1' });
        const retained = boundary.metadata.sessionRoleV1;
        expect(retained).toMatchObject({ role: customRole, name: 'Architect', color: '#123456', instructions: 'Design.' });

        boundary.settings.mockResolvedValue({ settings: { sessionRoleProfilesV1: { v: 1, instructionsByRole: {}, customRoles: [] } } });
        const resumed = await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: customRole, actionRequestId: 'custom-1', resume: true });
        expect(resumed).toMatchObject({ ok: true, role: customRole });
        expect(boundary.metadata.sessionRoleV1).toBe(retained);
        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: customRole }))
            .toMatchObject({ ok: false, errorCode: 'role_profiles_unavailable', roleSaved: false });
        expect(boundary.metadata.sessionRoleV1).toBe(retained);
    });

    it('resolves a resumed assignment while it is current, and never lets a stale resume overwrite a newer role', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'delivery_failed' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-9' });
        const worker = boundary.metadata.sessionRoleV1;
        const firstLocalId = boundary.send.mock.calls[0]?.[0].localId as string;

        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-9', resume: true }))
            .toMatchObject({ ok: true, instructionLocalId: firstLocalId });
        expect(boundary.metadata.sessionRoleV1).toBe(worker);

        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'reviewer', actionRequestId: 'req-10' });
        const reviewer = boundary.metadata.sessionRoleV1;
        const sendsBeforeStaleResume = boundary.send.mock.calls.length;

        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'worker', actionRequestId: 'req-9', resume: true }))
            .toMatchObject({ ok: false, errorCode: 'role_change_not_current', roleSaved: false });
        expect(boundary.metadata.sessionRoleV1).toBe(reviewer);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeStaleResume);
    });

    it('never resolves a resumed clear, because a clear retains no identity: nothing is written or re-sent', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner', actionRequestId: 'req-7' });
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'delivery_failed' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: null, actionRequestId: 'req-8' });
        const sendsBeforeResume = boundary.send.mock.calls.length;
        const updatesBeforeResume = boundary.update.mock.calls.length;

        // Also true for a clear that was never recorded at all: the empty role proves nothing about req-11.
        for (const actionRequestId of ['req-8', 'req-11']) {
            expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: null, actionRequestId, resume: true }))
                .toMatchObject({ ok: false, errorCode: 'role_change_not_current', roleSaved: false });
        }
        expect(boundary.metadata).not.toHaveProperty('sessionRoleV1');
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeResume);
        expect(boundary.update.mock.calls.length).toBeGreaterThanOrEqual(updatesBeforeResume);
    });

    it('rejects a resume whose role differs from the recorded attempt instead of reporting a role it did not deliver', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        boundary.send.mockResolvedValueOnce({ ok: false, code: 'delivery_failed' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner', actionRequestId: 'req-9' });
        const planner = boundary.metadata.sessionRoleV1;
        const sendsBeforeResume = boundary.send.mock.calls.length;

        for (const role of ['reviewer', null] as const) {
            expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role, actionRequestId: 'req-9', resume: true }))
                .toMatchObject({ ok: false, errorCode: 'role_change_not_current', roleSaved: false });
        }
        expect(boundary.metadata.sessionRoleV1).toBe(planner);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeResume);
        // The matching resume still resolves, reporting the role it delivered.
        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner', actionRequestId: 'req-9', resume: true }))
            .toMatchObject({ ok: true, role: 'planner', action: 'assigned' });
    });

    it('never lets a stale resumed clear remove a newer assignment', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner', actionRequestId: 'req-7' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: null, actionRequestId: 'req-8' });
        await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'reviewer', actionRequestId: 'req-10' });
        const reviewer = boundary.metadata.sessionRoleV1;
        const sendsBeforeStaleResume = boundary.send.mock.calls.length;

        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: null, actionRequestId: 'req-8', resume: true }))
            .toMatchObject({ ok: false, errorCode: 'role_change_not_current', roleSaved: false });
        expect(boundary.metadata.sessionRoleV1).toBe(reviewer);
        expect(boundary.send).toHaveBeenCalledTimes(sendsBeforeStaleResume);
    });

    it('fails closed without writing or queueing when account role profiles are unavailable or the write fails', async () => {
        const { setSessionRole } = await import('./setSessionRole');
        boundary.settings.mockRejectedValueOnce(new Error('settings offline'));
        expect(await setSessionRole({ credentials, idOrPrefix: 'sess-2', role: 'planner' }))
            .toMatchObject({ ok: false, errorCode: 'role_profiles_unavailable', roleSaved: false });
        boundary.update.mockResolvedValueOnce({ ok: false, code: 'session_not_found' });
        expect(await setSessionRole({ credentials, idOrPrefix: 'missing', role: 'planner' }))
            .toMatchObject({ ok: false, errorCode: 'role_update_failed', roleSaved: false });
        expect(boundary.send).not.toHaveBeenCalled();
        expect(boundary.metadata).not.toHaveProperty('sessionRoleV1');
    });
});
