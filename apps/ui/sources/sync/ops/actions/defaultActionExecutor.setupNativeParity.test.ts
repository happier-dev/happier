import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { executeDefaultActionInCapturedAccount } from './defaultActionExecutor';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';

installApprovalCommonModuleMocks();
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

describe('ordinary native setup parity through the UI Action executor', () => {
    it.each([
        ['ui', 'machines.setup.remove'], ['voice', 'machines.setup.remove'],
        ['ui', 'machines.setup.updates.apply'], ['voice', 'machines.setup.updates.apply'],
        ['captured-ui', 'machines.setup.remove'], ['captured-ui', 'machines.setup.updates.apply'],
        ['ui', 'machines.setup.updates.rollout'], ['voice', 'machines.setup.updates.rollout'],
        ['captured-ui', 'machines.setup.updates.rollout'],
    ] as const)('retains the exact reviewed operand and approval for %s %s', async (entry, actionId) => {
        const surface = entry === 'captured-ui' ? 'ui' : entry;
        const homeId = 'srv_setup_parity';
        const target = await upsertServerProfile({ serverUrl: `https://setup-parity-${entry}-${actionId.replaceAll('.', '-')}.test` });
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        const token = createAccountTokenForTests('setup-owner', { currentAccount: true });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        // A deliberate Account preference admits the captured UI entry; native approval stays authoritative.
        const actionsSettingsV1 = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
            actionId, surface: 'ui', approvalRequired: false });
        const input = actionId === 'machines.setup.remove'
            ? ManagedMachineActionInputSchemasV1[actionId].parse({ homeId, machineId: 'controller',
                sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, removeItemKeys: [], removalPlans: [] })
            : actionId === 'machines.setup.updates.rollout'
              ? ManagedMachineActionInputSchemasV1[actionId].parse({ homeId, machineId: 'controller', failurePolicy: 'fail_stop',
                  batches: [[{ homeId, machineId: 'controller', scope: 'security',
                    plan: { v: 1, basis: { kind: 'updates', machineId: 'controller', scope: 'security' },
                      steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) } }]] })
            : ManagedMachineActionInputSchemasV1[actionId].parse({ homeId, machineId: 'controller', scope: 'security',
                plan: { v: 1, basis: { kind: 'updates', machineId: 'controller', scope: 'security' },
                    steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) } });
        const result = entry !== 'ui'
            ? { kind: 'approval_request_created', actionId, artifactId: 'setup-approval' }
            : actionId === 'machines.setup.updates.rollout'
              ? { operationId: 'setup-operation', runId: '22222222-2222-4222-8222-222222222222' }
              : { operationId: 'setup-operation', terminalId: 'setup-terminal' };
        const effects: unknown[] = [];
        // HTTP is the boundary. Account capture, policy, dispatch and native origination remain real.
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/auth/ping' || url.pathname === '/health') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 });
            if (url.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'controller', accountId: 'setup-owner' })]);
            if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === 'controller' ? createPlainMachineRowFixture({ id, accountId: 'setup-owner' }) : null);
            expect(url.pathname).toBe(`/v1/actions/${actionId}`);
            expect(new Headers(init?.headers).get(AUTHORITY_CEILING_HEADER_V1)).toBe(surface !== 'ui' ? 'account_automation' : null);
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            effects.push(envelope);
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } });
        });
        const context = {
            serverId: target.id, expectedAccountId: 'setup-owner', surface,
            authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
            ...(surface === 'ui' ? { presentUserConfirmation: { actionId } } : {}),
        };
        const account = entry === 'captured-ui' ? await captureLazyActionAccountContext(target.id) : null;
        try {
            expect(await (account
                ? executeDefaultActionInCapturedAccount(account, actionId, input, context)
                : createDefaultActionExecutor().execute(actionId, input, context))).toEqual({ ok: true, result });
        } finally { account?.dispose(); }
        expect(effects).toEqual([expect.objectContaining({ input, target: { kind: 'machine', machineId: 'controller' } })]);
    });
});
