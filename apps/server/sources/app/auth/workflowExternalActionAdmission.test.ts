import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationBindingV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { auth } from './auth';
import { resolveExternalActionExecutionMachineAdmissionInTx, type WorkflowExternalActionAdmission } from './externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { installedSessionExternalActionStorage as storage } from '../api/testkit/installedSessionExternalActionStorage';

const database = vi.hoisted(() => ({ readToken: vi.fn(async () => null) }));
// Only database I/O is replaced; the canonical mint, grant evaluation and signing stay real.
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: { ...(await import('../api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
        accountApiToken: { findFirst: database.readToken } },
}));

describe('retained signed Workflow admission at the canonical leaf mint', () => {
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'workflow-leaf-admission-test-secret');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('AUTH_TOKEN_CACHE_TTL', '0');
        await auth.init();
    });
    afterAll(() => { vi.unstubAllEnvs(); });
    beforeEach(() => { database.readToken.mockClear(); });

    const origin = { runId: 'admitted-run', requestId: 'leaf-request' };
    const captured = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
        serverIdentityId: 'srv_proposal_admission', accountId: 'account', principalId: 'account', credentialId: 'revoked-token',
        grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine', custodianAccountId: 'account', installationId: 'installation',
        admittedMachineRole: 'manage', accountEncryptionMode: 'plain', actionId: 'machines.setup.apply',
        requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    });
    if (!('grant' in captured)) throw new Error('Expected captured API authority');
    const leaf = { ...captured, actionId: 'machines.work.summary.get', requestId: origin.requestId, workflowActionOrigin: origin };
    const { custodianAccountId: _custodian, installationId: _installation, ...input } = leaf;
    // This is the internal result of the installed publisher + assigned Run owner,
    // not a new wire input or an assertion that an arbitrary retained token is valid.
    const workflowAdmission = { binding: { ...captured, admittedMachineRole: 'manage' as const }, principal: { accountId: 'account', principalId: 'account',
        credentialId: 'revoked-token', grant: captured.grant, authority: 'account_automation' as const, workflowActionOrigin: origin } } satisfies WorkflowExternalActionAdmission;

    it('finishes an admitted finite Run after PAT revocation without reopening credential admission', async () => {
        const authorization = await auth.mintExternalActionExecutionAuthorization(input, { workflowAdmission });
        expect(authorization.binding).toMatchObject({ credentialId: 'revoked-token', workflowActionOrigin: origin,
            admittedMachineRole: 'manage', installationId: storage.state.installationId });
        expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
        expect(database.readToken).not.toHaveBeenCalled();
    });

    it('still refuses a new request after revocation', async () => {
        await expect(auth.mintExternalActionExecutionAuthorization(input)).rejects.toMatchObject({ code: 'invalid_token' });
        expect(database.readToken).toHaveBeenCalledOnce();
    });

    it('keeps each leaf within the admitted static grant', async () => {
        const grant = { ...captured.grant, actions: { families: [], ids: ['machines.setup.apply'] } };
        await expect(auth.mintExternalActionExecutionAuthorization({ ...input, grant }, {
            workflowAdmission: { ...workflowAdmission, binding: { ...workflowAdmission.binding, grant },
                principal: { ...workflowAdmission.principal, grant } },
        })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        expect(database.readToken).not.toHaveBeenCalled();
    });

    it('spends captured cross-Account Manage after Machine grant withdrawal without readmitting policy', async () => {
        const principal = { ...workflowAdmission.principal, accountId: 'other-account', principalId: 'other-account' };
        const admission = { ...workflowAdmission, principal,
            binding: { ...workflowAdmission.binding, accountId: principal.accountId, principalId: principal.principalId } };
        const request = { actorAccountId: principal.accountId, machineId: 'machine', actionId: 'machines.setup.apply' };
        expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, request)).toMatchObject({ kind: 'denied' });
        expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { ...request, workflowAdmission: admission }))
            .toMatchObject({ kind: 'admitted', actorAccountId: 'other-account', custodianAccountId: 'account', role: 'manage' });
        expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { ...request, machineId: 'foreign', workflowAdmission: admission }))
            .toMatchObject({ kind: 'denied' });
        storage.state.revokedAt = new Date();
        try {
            expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { ...request, workflowAdmission: admission }))
                .toMatchObject({ kind: 'denied' });
        } finally { storage.state.revokedAt = null; }
    });
});
