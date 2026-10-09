import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useManagedPendingWakeObservation } from './useManagedPendingWakeObservation';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';

installApprovalCommonModuleMocks();
afterEach(() => {
    resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); resetServerFeaturesClientForTests(); vi.restoreAllMocks();
});

describe('managed pending wake protected observation', () => {
    it('reads exact Home facts, refreshes its ordinary change edge and retires without requesting native Start', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://wake-target.test', scope: 'tab' });
        expect((await setServerProfileIdentityForUrl(target.serverUrl, 'srv_home_a'))?.serverIdentityId).toBe('srv_home_a');
        await upsertAndActivateServer({ serverUrl: 'https://wake-focused.test', scope: 'tab' });
        const token = createAccountTokenForTests('wake-owner');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const controller = { machineId: 'controller-a', installationId: 'installation-a' };
        const contribution = { pluginId: 'happier.machine.lima', localId: 'lima' };
        let power: 'stopped' | 'running' = 'stopped';
        const paths: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://wake-target.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            paths.push(url.pathname);
            expect(JSON.parse(String(init?.body))).toEqual({ homeId: 'srv_home_a', managedId: 'managed-a' });
            return Response.json({
                id: 'managed-a', homeId: 'srv_home_a', custodianAccountId: 'wake-owner',
                launch: { provider: contribution, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: contribution, schemaVersion: 1, value: {} },
                controller, allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest-a',
                desired: 'start', desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 10, availability: 'present', power, storage: 'retained', daemon: 'disconnected' },
            });
        });
        const retirement = new AbortController();
        const account = await captureLazyActionAccountContext(target.id, retirement.signal);
        const authorization: PendingActivationAuthorizationV1 = { status: 'waiting', requestId: 'request-a', requestedAt: 10, managedWakeTargetV1: {
            homeId: 'srv_home_a', managedId: 'managed-a', enrolledMachineId: 'guest-a', expectedIntentRevision: 1,
            controller, reason: 'admitted-work',
            origin: { kind: 'session-input', session: { homeId: 'srv_home_a', sessionId: 'session-a' }, pendingRequestId: 'request-a', requestedAt: 10 },
        } };
        const hook = await renderHook(() => useManagedPendingWakeObservation({
            sessionId: 'session-a', reconnectSignal: 1, accountLifetime: account.accountLifetime,
            authorization,
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()?.observation?.power).toBe('stopped'));
            power = 'running';
            await act(async () => publishHomeAccountChange(target.id, ['managed-a']));
            await flushHookEffects();
            await vi.waitFor(() => expect(hook.getCurrent()?.observation?.power).toBe('running'));
            await act(async () => retirement.abort());
            expect(hook.getCurrent()).toBeNull();
            expect(paths.every((path) => path === '/v1/machines/managed/actions/get')).toBe(true);
        } finally {
            await hook.unmount(); account.dispose();
        }
    });
});
