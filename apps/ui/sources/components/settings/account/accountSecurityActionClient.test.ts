import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePasswordCredentialFieldV1, PlainAccountPasswordCredentialV1Schema } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { AccountPasswordEnrollRequestV1Schema, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { AccountSecurityActionApprovalPendingError, createAccountSecurityActionClient } from './accountSecurityActionClient';

const confirmNative = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmNative } }).module;
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/ops/actions/defaultActionExecutor');
const plainCredential = PlainAccountPasswordCredentialV1Schema.parse({
    v: 1, kind: 'plain_password_hash', hash: {
        v: 1, algorithm: 'scrypt', parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
        digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
    },
});
const enrollment = AccountPasswordEnrollRequestV1Schema.parse({
    v: 1, kind: 'plain', email: 'person@example.test', targetCredential: plainCredential,
    verificationToken: 'A'.repeat(43), reauthentication: { provider: 'github', pending: 'pending-1', proof: 'proof-1' },
});
if (enrollment.kind !== 'plain') throw new Error('Expected Plain enrollment fixture');
let serverId: string;
let client: ReturnType<typeof createAccountSecurityActionClient>;
beforeEach(async () => {
    await homes.reset();
    confirmNative.mockReset().mockResolvedValue(true);
    serverId = await homes.addHome({ name: 'Security Home', serverUrl: 'https://security-client.test', accountId: 'account', active: true });
    client = createAccountSecurityActionClient({ resolveServerId: () => serverId });
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('accountSecurityActionClient', () => {
    it('uses the authenticated enrollment-email HTTP path and preserves host cancellation', async () => {
        const path = '/v1/account/password/enroll/email/request';
        homes.answer(serverId, path, { body: { v: 1, status: 'verification_sent' } });
        await expect(client.requestPasswordEnrollmentEmail({ email: 'person@example.test' })).resolves.toBeUndefined();
        expect(homes.requestsFor(path)[0]?.input).toEqual({ v: 1, email: 'person@example.test' });
        const controller = new AbortController(); controller.abort();
        await expect(client.requestPasswordEnrollmentEmail({ email: 'person@example.test' }, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('reads and mutates Account Security through the real present-user Action front door', async () => {
        const summary = AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain',
            nativeEmail: 'person@example.test', password: { status: 'enrolled', revision: 3 } });
        homes.answer(serverId, '/v1/account/security', { body: summary });
        homes.answer(serverId, '/v1/account/password/change', { body: { v: 1, status: 'updated' } });
        homes.answer(serverId, '/v1/account/password/enroll', { body: { v: 1, status: 'enrolled' } });
        homes.answer(serverId, '/v1/account/password/remove', { body: { v: 1, status: 'removed' } });
        homes.answer(serverId, '/v1/account/email/change/request', { body: { v: 1, status: 'verification_sent' } });
        const change = { expectedCredentialRevision: 3, currentPassword: 'old password that is long enough', newPassword: 'new password that is long enough' };
        await expect(client.read()).resolves.toEqual(summary);
        await expect(client.changePlainPassword(change)).resolves.toEqual({ v: 1, status: 'updated' });
        await expect(client.enrollPlainPassword(enrollment)).resolves.toEqual({ v: 1, status: 'enrolled' });
        await expect(client.removePlainPassword({ expectedCredentialRevision: 3, currentPassword: change.currentPassword }))
            .resolves.toEqual({ v: 1, status: 'removed' });
        await expect(client.requestEmailChange({ email: 'next@example.test' })).resolves.toEqual({ v: 1, status: 'verification_sent' });
        expect(homes.requestsFor('/v1/account/password/change')[0]?.input).toEqual({ v: 1, kind: 'plain', ...change });
        expect(homes.requestsFor('/v1/account/password/enroll')[0]?.input).toEqual(enrollment);
        expect(homes.requestsFor('/v1/account/email/change/request')[0]?.input).toEqual({ v: 1, email: 'next@example.test' });
    });

    it('rejects an incomplete E2EE enrollment at real Action admission before an HTTP mutation', async () => {
        // @ts-expect-error Deliberately missing targetCredential and proof exercises untyped external input.
        await expect(client.enrollE2eePassword({ v: 1, kind: 'e2ee', email: 'person@example.test' }))
            .rejects.toMatchObject({ code: 'invalid_parameters' });
        expect(homes.requestsFor('/v1/account/password/enroll')).toHaveLength(0);
    });

    it('preserves a native approval rejection without issuing the destructive request', async () => {
        await homes.requireUiApproval(serverId, 'account.password.remove');
        confirmNative.mockResolvedValue(false);
        await expect(client.removePlainPassword({ expectedCredentialRevision: 2, currentPassword: 'current password is long enough' }))
            .rejects.toMatchObject({ code: 'approval_canceled' });
        expect(homes.requestsFor('/v1/account/password/remove')).toHaveLength(0);
    });

    it('keeps the clicked enrollment pending until native confirmation, then returns its typed result', async () => {
        await homes.requireUiApproval(serverId, 'account.password.enroll');
        const confirmation = createDeferred<boolean>();
        confirmNative.mockImplementationOnce(() => confirmation.promise);
        homes.answer(serverId, '/v1/account/password/enroll', { body: { v: 1, status: 'enrolled' } });
        let settled = false;
        const pending = client.enrollPlainPassword(enrollment);
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await waitForHomeGovernance(() => expect(confirmNative).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(homes.requestsFor('/v1/account/password/enroll')).toHaveLength(0);
        confirmation.resolve(true);
        await expect(pending).resolves.toEqual({ v: 1, status: 'enrolled' });
        expect(homes.requestsFor('/v1/account/password/enroll')).toHaveLength(1);
    });

    it('does not reinterpret a malformed Home response as another Action approval', async () => {
        homes.answer(serverId, '/v1/account/password/enroll', { body: {
            kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'account.password.change',
        } });
        const pending = client.enrollPlainPassword(enrollment);
        await expect(pending).rejects.not.toBeInstanceOf(AccountSecurityActionApprovalPendingError);
        await expect(pending).rejects.toMatchObject({ code: 'outcome_unknown' });
    });
});
