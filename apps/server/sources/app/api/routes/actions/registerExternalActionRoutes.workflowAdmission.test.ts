import type { FastifyRequest } from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bindExternalActionExecutionAuthorizationHttpPathV1, computeExternalActionRequestEnvelopeDigestV1,
    ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { installedSessionExternalActionStorage as storage } from '../../testkit/installedSessionExternalActionStorage';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

const runs = vi.hoisted(() => ({ row: null as null | {
    id: string; accountId: string; claimedByMachineId: string; workflowAcceptedSnapshotEnvelope: object;
    workflowCustodyState: string; state: string;
} }));

// Only persistence is substituted. Both Apply HTTP admissions, installation
// proofs, retained requester projection and signed authorization mint stay real.
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: { ...(await import('../../testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
        automationRun: { findFirst: async ({ where }: { where: unknown }) => {
            const { matchesDbMockWhere } = await import('../../testkit/dbMocks');
            return runs.row && matchesDbMockWhere(runs.row, where) ? runs.row : null;
        } } },
}));

describe('retained Machine Apply requester at Home issuance', () => {
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'workflow-apply-issuance-test-secret');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('AUTH_TOKEN_CACHE_TTL', '0');
        await auth.init();
    });
    afterAll(() => { vi.unstubAllEnvs(); });

    it.each([
        { kind: 'account', fromSession: false }, { kind: 'terminal', fromSession: false },
        { kind: 'account', fromSession: true }, { kind: 'terminal', fromSession: true },
    ] as const)('issues an admitted Apply leaf with original $kind evidence (Session root: $fromSession)', async ({ kind, fromSession }) => {
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
        storage.state.publicKey = installation.publicKey;
        const app = createAuthenticatedTestApp();
        app.addHook('preHandler', async (request: FastifyRequest) => {
            request.authTokenLegacy = false;
            request.authTokenEpoch = 1;
        });
        app.decorate('resolveCurrentSessionMachine', async () => 'machine');
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Issuance does not execute the effect'); } });
        const actionId = 'machines.setup.apply';
        const homeId = storage.state.homeId;
        const evidence = [{ kind: 'home_method', methodId: 'key_challenge' }];
        const headers = { 'x-test-user-id': 'account', 'x-test-auth-token-kind': kind,
            'x-test-authentication-evidence': JSON.stringify(evidence) };
        const envelope = { v: 1 as const, requestId: `root-${kind}-${fromSession}`, target: { kind: 'machine' as const, machineId: 'machine' },
            input: { homeId, machineId: 'machine', targets: [{ homeId, machineId: 'machine', desiredRevision: 0,
                sources: [{ kind: 'direct', setup: { scripts: [{ body: 'true', affects: 'none' }] } }], recipePlans: [], exclusions: [] }] } };
        const url = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
        try {
            const sessionActionOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'setup-turn', callerPermissionMode: null, requestId: envelope.requestId };
            const sessionActionSource = { machineId: 'machine', installationId: 'installation' };
            const rootInstallationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId: 'account', ...sessionActionSource,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin } } });
            const rootResponse = await app.inject({ method: 'POST', url, headers,
                payload: { v: 1, machineId: 'machine', envelope, ...(fromSession
                    ? { sessionActionOrigin, sessionActionSource, installationProof: rootInstallationProof } : {}) } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const leaf = { ...envelope, requestId: `leaf-${kind}` };
            const origin = { runId: deriveMachineSetupCombinedRunIdV1({ homeId, accountId: 'account', requestId: envelope.requestId }),
                requestId: leaf.requestId };
            runs.row = { id: origin.runId, accountId: 'account', claimedByMachineId: 'machine',
                workflowAcceptedSnapshotEnvelope: {}, workflowCustodyState: 'pending', state: 'running' };
            const installationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId: 'account', machineId: 'machine', installationId: 'installation',
                    externalActionOrigin: { homeId, actionId, requestId: leaf.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(leaf), origin } } });
            const response = await app.inject({ method: 'POST', url, headers,
                payload: { v: 1, machineId: 'machine', envelope: leaf, workflowActionOrigin: origin,
                    executionAuthorization: root, installationProof } });
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(authorization.binding).toMatchObject({ actionId, accountId: 'account', admittedMachineRole: 'manage',
                authentication: { kind, tokenEpoch: 1, evidence }, workflowActionOrigin: origin });
            expect(authorization.binding).not.toHaveProperty('sessionActionOrigin');
            expect(authorization.binding).not.toHaveProperty('sessionActionSource');
            expect(authorization.binding).not.toHaveProperty('authenticationEvidence');
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
        } finally {
            runs.row = null;
            await app.close();
        }
    });
});
