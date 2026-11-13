import { afterEach, describe, expect, it, vi } from 'vitest';

// Prisma is the database boundary; current Session audience resolution stays real.
vi.mock('@/storage/db', async () => {
    const { createDbMocks, createDbTransactionMock, inTxPostgresControlStatementMock } = await import('@/app/api/testkit/dbMocks');
    const { db } = createDbMocks({ session: ['findMany'], sessionShare: ['findMany'],
        sessionTeamGrant: ['findMany'], sessionGroupGrant: ['findMany'] });
    db.session.findMany.mockResolvedValue([{ id: 'session_1', accountId: 'session_owner', account: { status: 'active' },
        currentStorageState: 'hosted', seq: 0, acceptedThroughServerSeq: null,
        materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null }]);
    db.sessionShare.findMany.mockResolvedValue([{ sessionId: 'session_1', sharedWithUserId: 'coadmin' },
        { sessionId: 'session_1', sharedWithUserId: 'creator' }]);
    db.sessionTeamGrant.findMany.mockResolvedValue([]);
    db.sessionGroupGrant.findMany.mockResolvedValue([]);
    const reader = { ...db, ...inTxPostgresControlStatementMock,
        $queryRawUnsafe: async (query: string) => {
            if (!query.includes('WITH RECURSIVE selected AS') || !query.includes('MachineAccountGrant')) throw new Error('Unexpected audience fixture SQL');
            return [{ machineId: 'machine_1', custodianAccountId: 'machine_owner', source: 'account',
                membershipStatus: null, membershipRole: null, teamArchivedAt: null, groupArchivedAt: null,
                inherited: 0, accessLevel: 'view', id: 'machine_reader', status: 'active' }];
        } };
    return { db: createDbTransactionMock(() => reader).wrapDb(reader),
        getDbProviderFromEnv: (await import('@/storage/prisma')).getDbProviderFromEnv };
});
import { eventRouter } from '@/app/events/connectionEventRouter';
import { publishLocalServicePublicPreviewChange } from './changes';
import { createLocalServicePublicRuntime } from './runtime';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';

describe('public preview change delivery', () => {
    afterEach(() => eventRouter.clearIo());
    it.each([{ kind: 'session', id: 'session_1' }, { kind: 'user', id: 'creator' }] as const)(
        'uses current Session recipients for a $kind preview without a managed Service target', async owner => {
        const delivered: Array<{ room: string | string[]; payload: unknown }> = [];
        eventRouter.setIo({ to: room => ({ emit: (_event, payload) => { delivered.push({ room, payload }); },
            disconnectSockets: () => {} }) });
        const change = { type: 'local-service-public-preview-changed' as const, machineId: 'machine_1',
            previewId: 'preview_1', exposureId: 'exposure_1' };
        await publishLocalServicePublicPreviewChange({ actorId: 'creator', owner,
            sessionId: 'session_1', change });
        expect(delivered).toEqual(['creator', 'coadmin', 'session_owner'].map(accountId => ({
            room: `user-scoped:${accountId}`, payload: change,
        })));
    });
    it('delivers real create and revoke transitions to the creator and current service owner without link content', async () => {
        const delivered: Array<{ room: string | string[]; event: string; payload: unknown }> = [];
        // Only Socket.IO is replaced; runtime lifecycle, recipient selection and routing stay real.
        eventRouter.setIo({ to: room => ({
            emit: (event, payload) => { delivered.push({ room, event, payload }); },
            disconnectSockets: () => {},
        }) });
        const pending: Promise<void>[] = [];
        const runtime = createLocalServicePublicRuntime({
            publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
            tokenSecret: 'fixture-key', nowMs: () => 1_000, allowTestDevAuditSink: true,
            recordAuditEvent: () => {}, checkRateLimit: () => true,
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000,
                dnsTlsRequired: false, auditRequired: true, rateLimitProfileIds: ['default'] },
            onExposureChanged: change => { pending.push(publishLocalServicePublicPreviewChange(change)); },
        });
        const preview = { previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user', id: 'service_owner' },
            serviceTarget: { kind: 'managed_service', machineId: 'machine_1', managedServiceId: 'service_1', cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } } },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Service', addressLabel: 'localhost:5173' }, originMode: 'host' } satisfies LocalServicePreviewResourceV1;
        const result = runtime.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'creator', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!result.ok) throw new Error(result.reasonCode);
        await Promise.all(pending);
        const change = { type: 'local-service-public-preview-changed', machineId: preview.machineId,
            previewId: preview.previewId, exposureId: result.exposure.exposureId };
        const expected = ['creator', 'service_owner', 'machine_owner', 'machine_reader'].map(accountId => ({ room: `user-scoped:${accountId}`,
            event: 'ephemeral', payload: change }));
        expect(delivered).toEqual(expected);
        runtime.revokeExposure(result.exposure.exposureId, { actorId: 'creator' });
        await Promise.all(pending);
        expect(delivered).toEqual([...expected, ...expected]);
    });
});
