import { afterEach, describe, expect, it } from 'vitest';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { randomUUID } from '@/platform/randomUUID';
import { updateSessionMetadataWithRetry } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { log } from '@/log';

installDisconnectedServerSocketBoundary();
const { persistCreatedSessionAuthoringOrigin } = await import('./newSessionAuthoringOrigin');

afterEach(() => resetSessionDraftRepositoryForTests());

describe('created Session authoring origin', () => {
    it.each([0, 7, 8, 'forbidden', 'unavailable', 'birth', 'birth-missing', 'birth-mismatch', 'unknown', 'unknown-missing'] as const)('settles a cold encrypted origin checkpoint with %s concurrent tuple advances or refusal through real Sync', async contention => {
        const conflicts = typeof contention === 'number' ? contention : 0;
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { createLegacyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const { sealSessionOwnerMetadataEnvelopeV1, openSessionOwnerMetadataEnvelopeV1 } =
            await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
        const { SessionCurrentProjectionRecordV1Schema} = await import('@happier-dev/protocol/sessions/listing/response');
        const [{ projectSessionDisplayV1, sealSessionOwnerDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1}, { SessionSharedMetadataV1Schema}] = await Promise.all([import('@happier-dev/protocol/sessions'), import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1')]);
        const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { SessionMetadataTuplePatchV1Schema, SessionMetadataVersionConflictV1Schema } =
            await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        // A Session's version identifies immutable bytes in the real decrypt cache.
        // Different parameter fixtures therefore need different Session identities.
        const sessionId = `cold-encrypted-authoring-${contention}`;
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const sessionEncryption = encryption.getSessionEncryption(sessionId);
        if (!sessionEncryption) throw new Error('Expected fixture Session encryption');
        const metadata = { path: '/checkout', host: 'worker', work: { memoryEnabled: false } };
        const created = createSessionOwnerMetadataV1({ metadata });
        if (!created.ok) throw new Error('Expected admitted owner metadata');
        let record = SessionCurrentProjectionRecordV1Schema.parse({
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 0, active: true, activeAt: 1,
            encryptionMode: 'e2ee', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: await sessionEncryption.encryptRaw(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                ownerMetadata: created.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(7) }),
            agentStateVersion: 0, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
        });
        let relationshipWrites = 0;
        let tupleWrites = 0;
        let sessionReads = 0;
        let birthPublished = false;
        const sealCurrentDisplayProjection = async () => {
            const owner = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', envelope: record.ownerMetadata,
                material: { type: 'legacy', secret } });
            if (!owner.ok) throw new Error('Expected readable current owner fixture');
            const display = projectSessionDisplayV1({
                sharedMetadata: SessionSharedMetadataV1Schema.parse(await sessionEncryption.decryptRaw(record.metadata)),
                ownerMetadata: owner.ownerMetadata,
            });
            if (!display.owner) throw new Error('Expected owner display from current birth producer');
            const shared = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', display: display.shared,
                encryptPayload: payload => sessionEncryption.encryptRaw(payload) });
            const privateDisplay = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display: display.owner,
                material: { type: 'legacy', secret }, randomBytes: length => new Uint8Array(length).fill(7) });
            if (!shared.ok || !privateDisplay.ok) throw new Error('Expected sealed current birth display');
            record = SessionCurrentProjectionRecordV1Schema.parse({ ...record, displayProjectionV1: {
                v: 1, sourceMetadataVersion: record.metadataVersion, metadataLayoutVersion: 1,
                shared: shared.envelope, owner: privateDisplay.envelope,
            } });
        };
        const logStart = log.getCount();
        const homes = await serveAccountHomes({ homes: [{ key: 'origin',
            serverUrl: 'https://qf48b-encrypted-origin.test', serverIdentityId: 'srv_qf48b_encrypted',
            accountId: 'account-a', accountMode: 'e2ee',
            credentials: { token: createAccountTokenForTests('account-a'), secret: encodeBase64(secret) },
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }),
        }], route: async request => {
            if (request.path === `/v2/sessions/${sessionId}`) {
                if (request.method === 'PATCH') {
                    const patch = SessionMetadataTuplePatchV1Schema.parse(request.body);
                    if (patch.mode !== 'owner') throw new Error('Expected owner tuple write');
                    // The HTTP boundary advances like another client immediately before CAS.
                    // Eight is Sync's existing attempt budget, not a new test-only writer limit.
                    tupleWrites += 1;
                    expect(patch.sharedMetadata.expectedVersion).toBe(record.metadataVersion);
                    const candidate = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee',
                        envelope: patch.ownerMetadata, material: { type: 'legacy', secret } });
                    expect(candidate.ok && candidate.ownerMetadata.work?.authoringOriginV1).toEqual(origin);
                    if (tupleWrites > 1) {
                        expect(await sessionEncryption.decryptRaw(patch.sharedMetadata.ciphertext)).toMatchObject({
                            summary: { text: `Concurrent title ${tupleWrites - 1}`, updatedAt: tupleWrites - 1 },
                        });
                    }
                    if (contention === 'forbidden') return Response.json({ error: 'Forbidden' }, { status: 403 });
                    if (contention === 'unavailable') return Response.json({ error: 'Untrusted response prose' }, { status: 503 });
                    if (tupleWrites <= conflicts) {
                        const advanced = { ...metadata, summary: { text: `Concurrent title ${tupleWrites}`, updatedAt: tupleWrites } };
                        const owner = createSessionOwnerMetadataV1({ metadata: advanced });
                        if (!owner.ok) throw new Error('Expected admitted concurrent owner metadata');
                        record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                            metadataVersion: record.metadataVersion + 1,
                            displayProjectionV1: undefined,
                            metadata: await sessionEncryption.encryptRaw(projectSessionSharedMetadataV1({ metadata: advanced })),
                            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                                ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(7) }),
                        });
                        await sealCurrentDisplayProjection();
                        return Response.json(SessionMetadataVersionConflictV1Schema.parse({
                            code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                            sharedMetadata: { version: record.metadataVersion },
                            agentState: { version: record.agentStateVersion },
                        }), { status: 409 });
                    }
                    record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                        metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                        displayProjectionV1: patch.displayProjectionV1 ?? undefined,
                        metadataVersion: record.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                        agentStateVersion: (record.agentStateVersion ?? 0) + 1 });
                    if (!record.displayProjectionV1) await sealCurrentDisplayProjection();
                    return Response.json({ success: true, metadataLayoutVersion: 1,
                        sharedMetadata: { version: record.metadataVersion }, agentState: { version: record.agentStateVersion } });
                }
                if (!birthPublished && (contention === 'birth' || contention === 'unknown' || contention === 'birth-mismatch')) {
                    birthPublished = true;
                    await publishBirthMetadata();
                }
                sessionReads += 1;
                return Response.json({ session: record });
            }
            if (request.path === '/v1/account/project-rows/authoring-session') {
                const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee',
                    envelope: record.ownerMetadata, material: { type: 'legacy', secret } });
                expect(opened.ok && opened.ownerMetadata.work?.authoringOriginV1).toEqual(origin);
                relationshipWrites += 1;
                return Response.json({ status: 'absent' });
            }
            return undefined;
        } });
        const origin = { kind: 'project', accountId: 'account-a', page: 'scripts', workspace: {
            serverId: homes.homes.origin!.id, workspaceId: 'checkout-a', machineId: 'worker', rootPath: '/checkout',
        } } as const;
        const publishBirthMetadata = async () => {
            // Construct twelve daemon-like tuple advances at the HTTP read boundary,
            // exceeding the existing eight-attempt browser CAS budget. These use the
            // real projection and encryption owners, not actual daemon publishers.
            for (let index = 0; index < 12; index += 1) {
                const advanced = { ...metadata, summary: { text: `Birth title ${index}`, updatedAt: index },
                    work: { ...metadata.work, authoringOriginV1: contention === 'birth-mismatch'
                        ? { ...origin, workspace: { ...origin.workspace, workspaceId: 'different-checkout' } } : origin } };
                const owner = createSessionOwnerMetadataV1({ metadata: advanced });
                if (!owner.ok) throw new Error('Expected admitted birth metadata');
                record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                    metadataVersion: record.metadataVersion + 1,
                    displayProjectionV1: undefined,
                    metadata: await sessionEncryption.encryptRaw(projectSessionSharedMetadataV1({ metadata: advanced })),
                    ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                        ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(7) }),
                });
            }
            await sealCurrentDisplayProjection();
        };
        // Session birth includes the current display projection. This checkpoint
        // exercises origin custody, not a separate missing-display backfill.
        await sealCurrentDisplayProjection();
        try {
            const { sync } = await import('@/sync/sync');
            const checkpoint = persistCreatedSessionAuthoringOrigin({ sessionId, serverId: homes.homes.origin!.id, origin,
                ...(contention === 'birth' || contention === 'birth-missing' || contention === 'birth-mismatch'
                    ? { originPersistence: 'daemon-birth' as const }
                    : contention === 'unknown' || contention === 'unknown-missing' ? { originPersistence: 'unknown' as const } : {}),
                shouldContinue: () => true, updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry });
            if (contention === 'birth-missing' || contention === 'birth-mismatch' || contention === 'unknown-missing') {
                await expect(checkpoint).rejects.toMatchObject({ code: 'authoring_origin_birth_unconfirmed', phase: 'authoring_origin' });
                expect(tupleWrites).toBe(0);
                expect(relationshipWrites).toBe(0);
                expect(sessionReads).toBe(1);
            } else if (conflicts === 8 || contention === 'forbidden' || contention === 'unavailable') {
                const code = contention === 'unavailable' ? 'service_temporarily_unavailable'
                    : contention === 'forbidden' ? 'forbidden' : 'conflict';
                await expect(checkpoint).rejects.toMatchObject({ code, phase: 'authoring_origin',
                    ...(contention === 'unavailable' ? { name: 'HappyError', canTryAgain: true, status: 503 } : {}) });
                const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee',
                    envelope: record.ownerMetadata, material: { type: 'legacy', secret } });
                expect(opened.ok && opened.ownerMetadata.work?.authoringOriginV1).toBeUndefined();
                expect(relationshipWrites).toBe(0);
                expect(tupleWrites).toBe(typeof contention === 'string' ? 1 : 8);
                expect(log.getLogs().slice(logStart).filter(line => line.startsWith('[SessionAuthoringOrigin]'))).toEqual([expect.stringContaining(
                    `"phase":"authoring_origin","code":"${contention === 'unavailable' ? 'session_metadata_update_failed' : code}"`,
                )]);
                expect(log.getLogs().slice(logStart).join(' ')).not.toContain('Concurrent title');
                expect(log.getLogs().slice(logStart).join(' ')).not.toContain('Untrusted response prose');
            } else {
                await checkpoint;
                expect(relationshipWrites).toBe(1);
                expect(tupleWrites).toBe(contention === 'birth' || contention === 'unknown' ? 0 : conflicts + 1);
                if (contention === 'birth' || contention === 'unknown') {
                    expect(sessionReads).toBe(1);
                    expect(await sessionEncryption.decryptRaw(record.metadata)).toMatchObject({ summary: { text: 'Birth title 11' } });
                }
                expect(log.getLogs().slice(logStart).filter(line => line.startsWith('[SessionAuthoringOrigin]'))).toEqual([]);
            }
        } finally { await homes.dispose(); }
    });

    it('records only ids on the original checkout Home after the owner tuple commits, and refuses retired origins', async () => {
        const writes: unknown[] = [];
        let tupleCommitted = false;
        const homes = await serveAccountHomes({ homes: [
            { key: 'origin', serverUrl: 'https://qf48-origin-identity.test', serverIdentityId: 'srv_qf48_origin', accountId: 'account-a' },
            { key: 'launch', serverUrl: 'https://qf48-launch-identity.test', serverIdentityId: 'srv_qf48_launch', accountId: 'account-b' },
        ], route: request => {
            if (request.path !== '/v1/account/project-rows/authoring-session') return undefined;
            expect(request.url.origin).toBe('https://qf48-origin-identity.test');
            expect(request.accountId).toBe('account-a');
            expect(tupleCommitted).toBe(true);
            writes.push(request.body);
            return Response.json({ status: 'absent' });
        } });
        const origin = { kind: 'project' as const, accountId: 'account-a', page: 'scripts' as const,
            workspace: { serverId: homes.homes.origin!.id, workspaceId: 'checkout-a', machineId: 'original-machine', rootPath: '/private-original' } };
        try {
            await persistCreatedSessionAuthoringOrigin({ sessionId: 'created-session', serverId: homes.homes.launch!.profileId, origin,
                shouldContinue: () => true,
                updateSessionMetadataWithRetry: async (_id, update) => {
                    expect(update({ path: '/edited', host: 'h' })).toMatchObject({ work: { authoringOriginV1: origin } });
                    tupleCommitted = true;
                },
            });
            expect(tupleCommitted).toBe(true);
            expect(writes).toEqual([{ key: { kind: 'workspace-ref', serverId: homes.homes.origin!.id, id: 'checkout-a' },
                session: { serverId: homes.homes.launch!.id, sessionId: 'created-session' } }]);
            await persistCreatedSessionAuthoringOrigin({ sessionId: 'retired-session', serverId: homes.homes.launch!.id, origin,
                shouldContinue: () => false, updateSessionMetadataWithRetry: async () => undefined });
            expect(writes).toHaveLength(1);
        } finally { await homes.dispose(); }
    });

    it.each(['files', { kind: 'plugin', destination: { pluginId: 'acme.preview', localId: 'project-review' }, instanceKey: 'review-a' }] as const)
        ('hands the reopened original destination to the real owner tuple without replacing unrelated work or publishing it to recipients (%j)', async companion => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const draftId = randomUUID();
        const origin = { kind: 'project', purpose: 'session', accountId: scope.accountId, page: 'overview', layoutId: 'release-dashboard',
            surface: 'tabs', companion, resource: { kind: 'file', path: 'src/a.ts' },
            workspace: { serverId: scope.serverId, workspaceId: 'workspace-a', machineId: 'original-machine', rootPath: '/original' } } as const;
        writeNewSessionDraftToRepository({ scope, draftId, draft: {
            input: 'Review the changes', selectedMachineId: 'edited-machine', selectedPath: '/edited',
            targetServerId: 'server-b', selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'edited-machine' } },
            authoringOrigin: origin,
        } });
        resetSessionDraftRepositoryForTests();
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        if (!recovered?.authoringOrigin) throw new Error('Expected the reopened authoring origin');
        const metadata: Metadata = { path: '/edited', host: 'target-host', machineId: 'edited-machine',
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } } };
        const created = createSessionOwnerMetadataV1({ metadata });
        if (!created.ok) throw new Error('Expected admitted Session metadata');
        const envelope = createPlainSessionOwnerMetadataEnvelopeV1(created.ownerMetadata);
        const initial = {
            mode: 'owner' as const, metadataLayoutVersion: 1 as const, metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current', ownerMetadataEnvelope: envelope,
            agentStateVersion: 5, agentStateCiphertext: null,
            value: { metadata, ownerMetadata: created.ownerMetadata,
                sharedMetadata: projectSessionSharedMetadataV1({ metadata }), agentState: null },
        };
        const transportWrites: unknown[] = [];
        let committed: unknown;
        await persistCreatedSessionAuthoringOrigin({
            sessionId: 'created-session', serverId: 'server-b', origin: recovered.authoringOrigin,
            shouldContinue: () => true,
            updateSessionMetadataWithRetry: async (sessionId, updater, options) => {
                expect(sessionId).toBe('created-session');
                expect(options.serverId).toBe('server-b');
                await updateSessionMetadataWithRetry<Metadata>({
                    sessionId, getSession: () => ({ metadataLayoutVersion: 1, metadataVersion: 3, metadata }),
                    refreshSessions: async () => undefined, acquireTupleSnapshot: async () => initial,
                    tupleCrypto: { encryptPayload: async (value) => JSON.stringify(value),
                        encodeOwnerMetadata: (owner) => createPlainSessionOwnerMetadataEnvelopeV1(owner) },
                    emitUpdateMetadata: async (payload) => {
                        transportWrites.push(payload);
                        return { result: 'success', metadataLayoutVersion: 1, version: 4, agentStateVersion: 6 };
                    },
                    applyTupleSnapshot: (snapshot) => { committed = snapshot; }, updater,
                });
            },
        });
        expect(committed).toMatchObject({ value: { metadata: {
            path: '/edited', machineId: 'edited-machine', work: {
                memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin,
            },
        } } });
        expect(transportWrites).toMatchObject([{ mode: 'owner', ownerMetadata: { t: 'plain', v: {
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin },
        } } }]);
        const wire = transportWrites[0];
        if (!wire || typeof wire !== 'object' || !('sharedMetadata' in wire)) throw new Error('Expected tuple transport output');
        expect(JSON.stringify(wire.sharedMetadata)).not.toContain('release-dashboard');
        expect(JSON.stringify(wire.sharedMetadata)).not.toContain('/original');
        expect(JSON.stringify(wire.sharedMetadata)).not.toContain('acme.preview');
    });
});
