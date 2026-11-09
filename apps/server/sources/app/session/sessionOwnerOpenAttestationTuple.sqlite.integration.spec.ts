import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { buildSessionMetadataEnvelopeFields } from '../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { updateSessionMetadataWithRetry } from '../../../../cli/src/session/metadata/updateSessionMetadataWithRetry';
import { createSessionTurnLifecycle } from '../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { classifyPrimarySessionRuntimeIssue } from '../../../../cli/src/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { awaitTrackedRunnerAgentSessionOpen, recordTrackedRunnerAgentSessionOpenAttestation } from '../../../../cli/src/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createAgentSessionRunnerFactoryBinding } from '../../../../cli/src/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '../../../../cli/src/daemon/types';
import { resolveSessionStartFailureNotice } from '../../../../ui/sources/components/sessions/startFailure/sessionStartFailureNotice';
import { createPresentUserSessionAccessAuthentication } from './access/sessionAccessAuthentication.testkit';
import { applySessionTurnMutation } from './sessionWriteService';
import { parseStoredSessionRuntimeIssue } from './turns/parseSessionTurnState';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';

describe('owner open-attestation metadata tuple (SQLite)', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-owner-open-attestation-',
            initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
        });
    }, 180_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('retires a recovered startup issue after confirmed idle open and stop without losing failed-turn history', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ t: 'plain', v: {} }), active: false } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const lifecycle = createSessionTurnLifecycle({ session: { sessionId: session.id,
            enqueueSessionTurnMutation: async mutation => {
                expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation })).toMatchObject({ ok: true });
            } } });
        const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
            error: { code: 'native_agent_privileged_effect_authority_unavailable' }, occurredAt: Date.now() - 1000 });
        await lifecycle.failTurn({ issue, allocateWhenIdle: true });
        const failed = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(resolveSessionStartFailureNotice({ issue: parseStoredSessionRuntimeIssue(failed.lastRuntimeIssue), sessionActive: failed.active }))
            .toMatchObject({ code: issue.code });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'fixture' } });
        const presence = createSessionPublisherPresence();
        const socket = {};
        expect(await presence.registerPublisher({ socket, binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).active).toBe(true);
        const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'fixture.open', pluginVersion: '1.0.0',
            agentId: 'fixture-agent', localAgentId: 'fixture-agent',
            sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
            locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            normalizedModulePath: '/fixture/runtime.mjs', loadMode: 'immutable-js' });
        const runner = { pid: 4321, processStartTimeMs: Date.now(), processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-open' };
        const tracked: TrackedSession = { startedBy: 'daemon', pid: runner.pid, happySessionId: session.id,
            processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
            runnerAgentSourceCustodyV1: binding.sourceCustody, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/authority' };
        const request = { kind: 'resume' as const, sessionId: session.id, cwd: '/fixture', providerSessionId: 'native-session' };
        // The provider's successful open and marker filesystem are external boundaries;
        // retained failure, attestation admission, turn persistence and notice stay real.
        expect(await recordTrackedRunnerAgentSessionOpenAttestation({ tracked, runner, retainedAgent: binding,
            phase: 'commit', request, providerSessionId: request.providerSessionId, updateMarker: async () => true })).not.toBeNull();
        expect(await awaitTrackedRunnerAgentSessionOpen({ sessionId: session.id, getTrackedSessions: () => [tracked] }))
            .toMatchObject({ status: 'opened' });
        await lifecycle.confirmSessionOpened();
        expect(await presence.closePublisher({ socket })).toMatchObject({ status: 'closed' });
        const stopped = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(stopped.active).toBe(false);
        expect(stopped.lastRuntimeIssue).toBeNull();
        expect(resolveSessionStartFailureNotice({ issue: parseStoredSessionRuntimeIssue(stopped.lastRuntimeIssue), sessionActive: stopped.active })).toBeNull();
        const history = await db.sessionTurn.findMany({ where: { sessionId: session.id } });
        expect(history).toHaveLength(1);
        expect(parseStoredSessionRuntimeIssue(history[0]!.lastRuntimeIssueJson)).toMatchObject({ code: issue.code });
    });

    it.each(['runtime-failure', 'newer-startup'] as const)('keeps an unresolved %s when an idle open cannot supersede it', async scenario => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const openedAt = Date.now();
        const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: openedAt + (scenario === 'newer-startup' ? 1 : -1000),
            error: { code: scenario === 'newer-startup' ? 'native_agent_privileged_effect_authority_unavailable' : 'ordinary_runtime_error' } });
        const lifecycle = createSessionTurnLifecycle({ session: { sessionId: session.id, enqueueSessionTurnMutation: async mutation => {
            expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation })).toMatchObject({ ok: true });
        } } });
        await lifecycle.failTurn({ issue, occurredAt: issue.occurredAt, allocateWhenIdle: true });
        expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
            v: 1, sessionId: session.id, mutationId: randomUUID(), action: 'session_opened', observedAt: openedAt,
        } })).toMatchObject({ ok: true, didApply: false });
        expect(parseStoredSessionRuntimeIssue((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastRuntimeIssue))
            .toMatchObject({ code: issue.code, occurredAt: issue.occurredAt });
    });

    it('keeps an unrelated owner PATCH predecessor-compatible and still refuses an Account-mode mismatch', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const credentials = { token: 'fixture', encryption: null };
        const fields = buildSessionMetadataEnvelopeFields({
            credentials,
            accountEncryptionMode: 'plain',
            storedContentMode: 'plain',
            metadata: { path: '/repo', host: 'runner' },
            agentState: {},
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: randomUUID(),
                encryptionMode: 'plain',
                active: true,
                metadataLayoutVersion: 1,
                metadata: fields.sharedMetadata.ciphertext,
                ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(fields.ownerMetadata),
                agentState: fields.agentState,
            },
        });
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => {
            request.headers['x-test-user-id'] = owner.id;
        });
        let observedPatch: unknown;
        app.addHook('preValidation', async request => {
            observedPatch = request.body;
        });
        registerSessionPatchRoute(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                const raw = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                await expect(updateSessionMetadataWithRetry({
                    token: credentials.token,
                    credentials,
                    accountEncryptionCurrentness: {
                        mode: 'plain',
                        version: 1,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                    },
                    sessionId: session.id,
                    rawSession: { ...raw, ownerMetadata: fields.ownerMetadata },
                    updater: metadata => ({ ...metadata, codexSessionId: 'native-session-1' }),
                })).resolves.toMatchObject({ version: 1 });
            });
            expect(observedPatch).toMatchObject({ mode: 'owner', metadataLayoutVersion: 1 });
            expect(observedPatch).not.toHaveProperty('sharedActionConfirmationSummaryV1');

            await db.session.update({
                where: { id: session.id },
                data: { ownerMetadata: JSON.stringify({ t: 'encrypted', c: 'account-mode-mismatch' }) },
            });
            const incompatible = await app.inject({
                method: 'PATCH',
                url: `/v2/sessions/${session.id}`,
                headers: {
                    'x-test-user-id': owner.id,
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                },
                payload: observedPatch,
            });
            expect(incompatible.statusCode).toBe(409);
            expect(incompatible.json()).toEqual({
                error: 'Session metadata privacy upgrade required',
                code: 'metadata_privacy_upgrade_required',
            });
        } finally {
            await app.close();
        }
    });
});
