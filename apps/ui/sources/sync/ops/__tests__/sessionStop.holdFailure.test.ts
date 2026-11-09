import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SessionStopResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectSessionOwnerCompatibilityViewV1, SessionMetadataTuplePatchV1Schema, StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionExplicitStopV1FromMetadata, resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Real Account admission, Sync tuple writer and Stop strategy; only HTTP/Socket.IO are replaced.
const boundary = await (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')).installSessionOpsNetworkBoundary();
const { sessionStopWithServerScope } = await import('../sessions');
const { createDefaultActionExecutor } = await import('../actions/defaultActionExecutor');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

beforeEach(async () => { boundary.resetRequests(); await loadSyncSingletonForTests(); });
afterAll(async () => { await resetServerReachabilitySupervisors(); await boundary.dispose(); });

describe('explicit Stop hold failure through real metadata transport', () => {
    it('preserves the successful hold and physical Stop result', async () => {
        const home = await boundary.addHome('https://stop-hold-success.example', 'stop-owner');
        const sessionId = 'stop-hold-success';
        const metadata = createSessionMetadataHttpBoundary(() => ({}));
        metadata.replaceSession(sessionId, createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true }));
        boundary.setHttpResponder(async (input, init) => metadata.handle(input, init));
        boundary.respond('stop-session', { status: 'stopped' });

        await expect(sessionStopWithServerScope(sessionId, { serverId: home.id, stopIntent: 'explicit_stop' }))
            .resolves.toEqual({ sessionId, stopped: true, success: true });
        expect(metadata.writes).toEqual([sessionId]);
    });

    it('persists the hold after a concurrent metadata write and still refuses automatic wake', async () => {
        const home = await boundary.addHome('https://stop-hold-conflict.example', 'stop-owner');
        const sessionId = 'stop-hold-conflict';
        const metadata = createSessionMetadataHttpBoundary(() => ({}));
        const initial = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true });
        metadata.replaceSession(sessionId, initial);
        let concurrentWrite = true;
        boundary.setHttpResponder(async (input, init) => {
            if (new URL(String(input)).pathname === `/v2/sessions/${sessionId}` && init?.method === 'PATCH' && concurrentWrite) {
                concurrentWrite = false;
                metadata.replaceSession(sessionId, { ...initial, metadataVersion: initial.metadataVersion + 1 });
            }
            return metadata.handle(input, init);
        });
        boundary.respond('stop-session', { status: 'stopped' });

        await expect(sessionStopWithServerScope(sessionId, { serverId: home.id, stopIntent: 'explicit_stop' }))
            .resolves.toMatchObject({ sessionId, stopped: true, success: true });
        const persisted = await metadata.handle(`https://stop-hold-conflict.example/v2/sessions/${sessionId}`)!.json();
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const record = SessionCurrentProjectionRecordV1Schema.parse(persisted.session);
        const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', envelope: record.ownerMetadata });
        if (!opened.ok) throw new Error('Persisted Stop owner envelope is unreadable');
        const ownerView = projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(record.metadata!)),
            ownerMetadata: opened.ownerMetadata,
        });
        expect(readSessionExplicitStopV1FromMetadata(ownerView)).toMatchObject({ cause: 'explicit_stop' });
        expect(resolveSessionAutoResumeAdmissionV1({ metadata: ownerView, archivedAt: null,
            machineAvailable: true, authorityAvailable: true })).toBe('held_by_person');
    });

    it.each([
        { physical: 'stopped', status: 409, code: 'metadata_privacy_upgrade_required' },
        { physical: 'unavailable', status: 409, code: 'metadata_privacy_upgrade_required' },
        { physical: 'stopped', status: 500, code: 'session_metadata_update_failed' },
    ] as const)('reaches physical Stop and surfaces the hold failure ($physical / $code)', async ({ physical, status, code }) => {
        const home = await boundary.addHome(`https://stop-hold-${physical}-${status}.example`, 'stop-owner');
        const sessionId = `stop-hold-${physical}-${status}`;
        const metadata = createSessionMetadataHttpBoundary(() => ({}));
        metadata.replaceSession(sessionId, createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true }));
        boundary.setHttpResponder(async (input, init) => {
            if (new URL(String(input)).pathname === `/v2/sessions/${sessionId}` && init?.method === 'PATCH') {
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                const ownerMetadata = patch.mode === 'owner_migration' ? patch.target.ownerMetadata
                    : patch.mode === 'owner' ? patch.ownerMetadata : null;
                const owner = ownerMetadata && openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', envelope: ownerMetadata });
                // Display maintenance is a different metadata producer, not a Stop retry.
                if (owner && owner.ok && readSessionExplicitStopV1FromMetadata(owner.ownerMetadata.runtime)) {
                    return Response.json(status === 409 ? { error: 'Session metadata privacy upgrade required',
                        code: 'metadata_privacy_upgrade_required' } : { error: 'Failed to update session' }, { status });
                }
            }
            return metadata.handle(input, init);
        });
        boundary.setRpcAckResponder(async () => physical === 'stopped'
            ? { ok: true, result: { status: 'stopped' } }
            : { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

        const result = await sessionStopWithServerScope(sessionId, { serverId: home.id, stopIntent: 'explicit_stop' });
        expect(boundary.requests.map(request => request.method)).toContain('stop-session');
        expect(result).toMatchObject({ sessionId, stopped: physical === 'stopped', success: false,
            holdRecorded: false, holdFailure: code, code,
        });
        expect(SessionStopResultSchema.parse(result)).toMatchObject({ holdRecorded: false, holdFailure: code });
        const physicalStops = boundary.requests.filter(request => request.method === 'stop-session').length;
        const actionResult = await createDefaultActionExecutor().execute('session.stop', { sessionId }, {
            serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        expect(actionResult).toMatchObject({ ok: false, errorCode: code,
            details: { sessionId, stopped: physical === 'stopped', holdRecorded: false, holdFailure: code },
        });
        expect(boundary.requests.filter(request => request.method === 'stop-session')).toHaveLength(physicalStops + 1);
        const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
        await expect(stopSessionAndMaybeArchive({ address: { serverId: home.id, sessionId },
            hideInactiveSessions: false, isPinned: false, archiveAfterStop: 'never',
            stopSession: async () => result,
            archiveSession: async () => { throw new Error('A failed hold must not advance to Archive'); },
            stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed',
        })).rejects.toMatchObject({ name: 'HappyError', code, message: result.message });
    });

    it.each(['stopped', 'requested', 'not_found'] as const)('preserves the Action confirmation for physical %s with a saved hold', async physical => {
        const home = await boundary.addHome(`https://stop-action-${physical}.example`, 'stop-owner');
        const sessionId = `stop-action-${physical}`;
        const metadata = createSessionMetadataHttpBoundary(() => ({}));
        metadata.replaceSession(sessionId, createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: physical !== 'not_found' }));
        boundary.setHttpResponder(async (input, init) => metadata.handle(input, init));
        boundary.respond('stop-session', { status: physical });

        const result = await createDefaultActionExecutor().execute('session.stop', { sessionId }, {
            serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        expect(result).toMatchObject({ ok: true, result: { sessionId, stopped: physical === 'stopped' } });
        if (physical === 'requested') expect(result).toMatchObject({ result: { success: false, code: 'session_stop_requested' } });
        if (physical === 'not_found') expect(result).toMatchObject({ result: { stopOutcome: { status: 'already_stopped' } } });
        expect(boundary.requests.filter(request => request.method === 'stop-session')).toHaveLength(1);
    });
});
