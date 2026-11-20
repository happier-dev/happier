import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AccountDetailFactsSections } from '../account/AccountDetailSections';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedConnectedAccountQuotaResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Modal } from '@/modal';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { readFreshRecoveryCreditObservationTime } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { AccountUsageResetsLine } from './AccountUsageFacts';
import { useAccountUsageResetAction } from './useAccountUsageResetAction';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
// Substitute only Metro's lazy loader; the default and Protocol Action executors stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it.each(['approve', 'reject', 'disabled', 'stale', 'machine-rpc-failed', 'lost-machine-ack', 'daemon-control-timeout', 'available-after-check',
    'unconfirmed-provider-receipt', 'consumed-without-projection', 'confirmed-consume', 'cancel-wait', 'detail-machine-withdrawn'] as const)('settles the native reset through the shared Action (%s)', async decision => {
    const bridge = await loadSyncSingletonForTests();
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'connectedServices.quota.reset': decision === 'disabled' ? { disabledSurfaces: ['ui'] } : { approvalRequiredSurfaces: ['ui'] },
    } });
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(home);
    const serverUrl = 'https://reset-approval.test';
    const serverId = await home.addHome({ name: 'Reset Home', serverUrl, serverIdentityId: 'srv_reset_approval',
        accountId: 'reset-account', currentAccount: true });
    const artifacts = home.artifacts(serverId);
    const machineRow = createPlainMachineRowFixture({ id: 'selected-machine', accountId: 'reset-account' });
    home.answer(serverId, '/v1/machines', { body: [machineRow] });
    home.answer(serverId, '/v1/machines/selected-machine', { body: { machine: machineRow } });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const token = home.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Missing current Reset Account credential');
    const account = await restoreServerAccountForTest({ serverUrl: 'https://reset-approval.test',
        serverIdentityId: 'srv_reset_approval', accountId: 'reset-account', credentials: { token }, request: home.request });
    const active = getActiveServerSnapshot();
    const machine = createMachineFixture({ id: 'selected-machine', activeAt: Date.now() });
    storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'reset-account' });
    await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'reset-account' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'reset-account' });
    storage.setState({ settings: { ...settingsDefaults, actionsSettingsV1, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: 'srv_reset_approval', machineId: machine.id },
    } }, settingsVersion: 1 });
    storage.getState().applyMachines([machine], true, { sourceServerId: active.serverId });
    storage.setState({ isDataReady: true });
    const spends: unknown[] = [];
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const ref = { service, accountId: 'work' };
    const refreshPath = '/v4/connect/qualified/quotas/refresh';
    home.answer(serverId, 'POST ' + refreshPath, { body: { success: true } });
    let finishIssuedConsume: (() => void) | undefined;
    let loseIssuedConsume: (() => void) | undefined;
    const unconfirmedReceipt = { idempotencyKey: 'reset-receipt', providerCreditId: 'credit-1', status: 'unknown_after_timeout' } as const;
    const refusalCause = { phase: 'rpc.admission.machine', errorClass: 'RpcError', errorCode: 'RPC_FORBIDDEN', httpStatus: null } as const;
    const respond = async (machineId: string, method: string, payload: unknown) => {
        expect(machineId).toBe(machine.id);
        if (method === CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD) {
            expect(payload).toMatchObject({ command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } });
            return {
                status: 'described', service,
                descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [
                    { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' },
                ] } },
                occurrenceId: 'reset-qa-machine', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
                accounts: [], operationTransport: { kind: 'v4' },
            };
        }
        if (method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME) throw new Error(`Unexpected machine RPC ${method}`);
        spends.push(payload);
        if (decision === 'cancel-wait' || decision === 'detail-machine-withdrawn') {
            await new Promise<void>((resolve, reject) => {
                finishIssuedConsume = resolve;
                loseIssuedConsume = () => reject(markRpcRequestDisposition(new Error('Machine socket closed'), 'outcomeUnknown'));
            });
            return { ok: true, receipt: { ...unconfirmedReceipt, status: 'consumed' }, snapshot: null };
        }
        if (decision === 'machine-rpc-failed') throw Object.assign(new Error('Machine refused this request'), {
            rpcErrorCode: 'RPC_FORBIDDEN', effectAttempted: false, failureCause: refusalCause,
        });
        if (decision === 'lost-machine-ack') throw markRpcRequestDisposition(new Error('Machine acknowledgement unavailable'), 'outcomeUnknown');
        if (decision === 'daemon-control-timeout' || decision === 'available-after-check') return {
            ok: false,
            errorCode: 'daemon_control_failed',
            error: 'Request failed: /connected-service-quota-recovery-credit/consume, The operation was aborted due to timeout',
        };
        if (decision === 'unconfirmed-provider-receipt') return {
            ok: false, errorCode: 'connected_service_quota_recovery_credit_failed', error: 'Provider acknowledgement unavailable',
            effectAttempted: true, receipt: unconfirmedReceipt,
        };
        if (decision === 'confirmed-consume') return {
            ok: true, receipt: { ...unconfirmedReceipt, status: 'consumed' }, snapshot: null,
        };
        if (decision === 'consumed-without-projection') return {
            ok: false, errorCode: 'connected_service_quota_recovery_credit_refresh_unavailable', error: 'Quota projection unavailable',
            effectAttempted: true, receipt: { ...unconfirmedReceipt, status: 'consumed' },
        };
        return { ok: true, receipt: { idempotencyKey: 'reset-receipt', providerCreditId: 'credit-1', status: 'nothing_to_reset' }, snapshot: null };
    };
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed scoped machine RPC');
            const separator = payload.method.indexOf(':');
            return { ok: true, result: await respond(payload.method.slice(0, separator), payload.method.slice(separator + 1), payload.params) };
        });
    });
    const rpc = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (machineId, method, payload, options) => {
        options?.signal?.throwIfAborted();
        options?.onIssued?.();
        const response = respond(machineId, method, payload);
        if (decision !== 'cancel-wait' || method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME || !options?.signal) return await response;
        const signal = options.signal;
        // The transport test owns whether the socket sends CANCEL. Its native
        // consumer sees the issued acknowledgement disappear while the provider runs.
        return await new Promise((resolve, reject) => {
            const stopWaiting = () => reject(markRpcRequestDisposition(new Error('Stopped waiting for machine acknowledgement'), 'outcomeUnknown'));
            signal.addEventListener('abort', stopWaiting, { once: true });
            void response.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopWaiting));
        });
    });
    let applied = false;
    const hook = await renderHook(() => useAccountUsageResetAction({ legacyServiceId: 'openai-codex', accountId: 'work',
        // Plans omits detail admission; the sibling detail path supplies its exact fresh choice.
        machineId: decision === 'approve' ? undefined : machine.id,
        snapshotFetchedAtMs: 123, onApplied: () => { applied = true; } }));
    let request: ReturnType<ReturnType<typeof useAccountUsageResetAction>['use']> | undefined;
    let answerConsent: ((approved: boolean) => void) | undefined;
    // Own UI Ask settles at the native consent boundary, without an Inbox Artifact.
    vi.mocked(Modal.confirm).mockImplementation(() => new Promise(resolve => { answerConsent = resolve; }));
    try {
        if (decision === 'detail-machine-withdrawn') {
            home.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({ capabilities: {
                serverIdentity: { serverIdentityId: 'srv_reset_approval' },
                connectedServices: { credentialDelete: { revisionGuard: false }, qualifiedAccounts: { protocolVersion: 4 } },
            } }) });
            const fetchedAt = Date.now();
            const staleAfterMs = 60_000;
            home.answer(serverId, '/v4/connect/qualified/quotas', { body: QualifiedConnectedAccountQuotaResponseV4Schema.parse({
                ref,
                sourceResolution: {
                    source: { ref, bindingKind: 'account' },
                    recordId: buildProviderAccountUsageRecordId({ providerId: 'openai-codex', accountSubjectId: 'provider-work', subjectKind: 'account', quotaScope: 'account' }),
                    providerAccountId: 'provider-work', fetchedAt, staleAfterMs,
                },
                content: { t: 'plain', v: {
                    v: 1, ref, activeAccountId: 'provider-work', fetchedAt, staleAfterMs, planLabel: null, accountLabel: null,
                    meters: [], recoveryCredits: { availableCount: 1, credits: [{ id: 'credit-1', kind: 'usage_limit_reset', status: 'available' }] },
                } },
                metadata: { fetchedAt, staleAfterMs, status: 'ok' },
            }) });
            const detail = (machineId: string | null) => <InjectedAuthProvider credentials={account.credentials}>
                <AccountDetailFactsSections account={ref} legacyServiceId="openai-codex" serviceLabel="Codex" signedOut={false} machineId={machineId} />
            </InjectedAuthProvider>;
            const screen = await renderScreen(detail(machine.id));
            try {
                await vi.waitFor(() => expect(screen.findByTestId('account-detail-resets:credit-1:use'),
                    'detail inventory loaded').toBeTruthy());
                await screen.pressByTestIdAsync('account-detail-resets:credit-1:use');
                await vi.waitFor(() => expect(answerConsent, 'native approval opened').toBeTypeOf('function'));
                await act(async () => { answerConsent!(true); });
                await vi.waitFor(() => expect(loseIssuedConsume, 'approved transport issued').toBeTypeOf('function'));
                expect(spends).toHaveLength(1);
                await screen.update(detail(null));
                await act(async () => { loseIssuedConsume!(); });
                await vi.waitFor(() => expect(screen.findByTestId('account-detail-resets:unknown'), 'same detail presents the issued unknown outcome').toBeTruthy());
                expect(screen.findByTestId('account-detail-resets:check')).toBeTruthy();
                expect(screen.findByTestId('account-detail-resets:credit-1:use')).toBeNull();
                expect(Modal.alert).not.toHaveBeenCalled();
                expect(spends).toHaveLength(1);
            } finally {
                finishIssuedConsume?.();
                await screen.unmount();
            }
            return;
        }
        if (decision === 'daemon-control-timeout' || decision === 'available-after-check' || decision === 'cancel-wait' || decision === 'confirmed-consume') {
            const now = Date.now();
            type QuotaObservation = Readonly<{ fetchedAt: number; recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null; stale?: boolean }>;
            const available: ConnectedServiceQuotaRecoveryCreditsV1 = {
                availableCount: 1, credits: [{ id: 'credit-1', kind: 'usage_limit_reset', status: 'available' }],
            };
            const spent = { availableCount: 0, credits: [] };
            let publishQuota: React.Dispatch<React.SetStateAction<QuotaObservation>>;
            function CreditRow() {
                const [observation, setObservation] = React.useState<QuotaObservation>({ fetchedAt: 123, recoveryCredits: available });
                publishQuota = setObservation;
                return <AccountUsageResetsLine
                    testID="recovery-credit"
                    legacyServiceId="openai-codex"
                    accountId="work"
                    snapshotFetchedAtMs={observation.fetchedAt}
                    recoveryCreditsObservedAtMs={readFreshRecoveryCreditObservationTime({
                        ...observation, staleSince: observation.stale ? observation.fetchedAt : null,
                    })}
                    recoveryCredits={observation.recoveryCredits}
                    now={now}
                    onApplied={() => { applied = true; setObservation({ fetchedAt: 124, recoveryCredits: spent }); }}
                />;
            }
            const screen = await renderScreen(<CreditRow />);
            try {
                await screen.pressByTestIdAsync('recovery-credit:use');
                await waitForHomeGovernance(() => expect(answerConsent).toBeTypeOf('function'));
                expect(spends).toHaveLength(0);
                if (decision === 'daemon-control-timeout' || decision === 'available-after-check') {
                    // A scheduled publication can land while native consent is still open.
                    // This observation predates the pending provider effect.
                    await act(async () => { publishQuota({ fetchedAt: 124, recoveryCredits: available }); });
                }
                await act(async () => { answerConsent!(true); });
                if (decision === 'confirmed-consume') {
                    await waitForHomeGovernance(() => expect(applied).toBe(true));
                    expect(spends).toHaveLength(1);
                    expect(screen.findByTestId('recovery-credit:use')).toBeNull();
                    expect(screen.findByTestId('recovery-credit:check')).toBeNull();
                    expect(screen.findByTestId('recovery-credit:used')).toBeNull();
                    expect(Modal.alert).not.toHaveBeenCalled();
                    return;
                }
                if (decision === 'cancel-wait') {
                    await waitForHomeGovernance(() => expect(finishIssuedConsume).toBeTypeOf('function'));
                    expect(screen.findByTestId('recovery-credit:cancel-wait')).toBeTruthy();
                    await screen.pressByTestIdAsync('recovery-credit:cancel-wait');
                    await waitForHomeGovernance(() => expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy());
                    expect(screen.findByTestId('recovery-credit:check')).toBeTruthy();
                    expect(screen.findByTestId('recovery-credit:use')).toBeNull();
                    expect(spends).toHaveLength(1);
                    expect(Modal.alert).not.toHaveBeenCalled();
                    await act(async () => { finishIssuedConsume!(); });
                    expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy();
                    expect(applied).toBe(false);
                    return;
                }
                await waitForHomeGovernance(() => expect(
                    Boolean(screen.findByTestId('recovery-credit:unknown')) || vi.mocked(Modal.alert).mock.calls.length > 0,
                ).toBe(true));
                expect(screen.findByTestId('recovery-credit:check')).not.toBeNull();
                expect(screen.findByTestId('recovery-credit:use')).toBeNull();
                expect(applied).toBe(false);
                expect(Modal.alert).not.toHaveBeenCalled();
                expect(home.requestsFor(refreshPath)).toHaveLength(0);
                await screen.pressByTestIdAsync('recovery-credit:check');
                await vi.waitFor(() => expect(home.requestsFor(refreshPath).map(request => request.input)).toEqual([{ ref }]));
                expect(screen.findByTestId('recovery-credit:check')).not.toBeNull();
                await act(async () => { publishQuota({ fetchedAt: 124, recoveryCredits: spent }); });
                expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy();
                await act(async () => { publishQuota({ fetchedAt: 123, recoveryCredits: available }); });
                expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy();
                await act(async () => { publishQuota({ fetchedAt: 125, recoveryCredits: spent, stale: true }); });
                expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy();
                await act(async () => { publishQuota({ fetchedAt: 126, recoveryCredits: null }); });
                expect(screen.findByTestId('recovery-credit:unknown')).toBeTruthy();
                await act(async () => {
                    publishQuota({ fetchedAt: 127, recoveryCredits: decision === 'available-after-check' ? available : spent });
                });
                expect(screen.findByTestId('recovery-credit:unknown')).toBeNull();
                expect(screen.findByTestId('recovery-credit:check')).toBeNull();
                expect(Boolean(screen.findByTestId('recovery-credit:use'))).toBe(decision === 'available-after-check');
                expect(screen.findByTestId('recovery-credit:used')).toBeNull();
                expect(spends).toHaveLength(1);
            } finally {
                finishIssuedConsume?.();
                await screen.unmount();
            }
            return;
        }
        if (decision === 'stale') storage.getState().applyMachines([{ ...machine, revokedAt: Date.now() }], true, { sourceServerId: active.serverId });
        await act(async () => { request = hook.getCurrent().use('credit-1'); });
        if (decision === 'disabled' || decision === 'stale') {
            await act(async () => { await request; });
            expect(artifacts.list()).toEqual([]);
            expect(rpc).not.toHaveBeenCalled();
            expect(applied).toBe(false);
            if (decision === 'disabled') {
                expect(Modal.alert).toHaveBeenCalledWith('common.error', 'actionConfirmations.turnedOffUnnamedMessage');
            }
            return;
        }
        expect(rpc).not.toHaveBeenCalled();
        expect(applied).toBe(false);
        await waitForHomeGovernance(() => expect(answerConsent).toBeTypeOf('function'));
        expect(hook.getCurrent().pending).toBe(true);
        expect(artifacts.list()).toEqual([]);
        expect(rpc).not.toHaveBeenCalled();
        expect(applied).toBe(false);
        await act(async () => { answerConsent!(decision !== 'reject'); await request; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        await request;
        if (decision === 'approve') {
            expect(spends).toEqual([expect.objectContaining({
                serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', providerCreditId: 'credit-1',
                idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({ serviceId: 'openai-codex', profileId: 'work',
                    providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 123 }),
            })]);
            expect(applied).toBe(true);
            expect(Modal.alert).toHaveBeenCalledWith('common.info', 'connectedServices.quota.recoveryCreditNothingToReset');
        } else if (decision === 'machine-rpc-failed') {
            expect(await request).toMatchObject({ ok: false, errorCode: 'machine_rpc_failed', effectAttempted: false, failureCause: refusalCause });
            expect(spends).toHaveLength(1);
            expect(applied).toBe(false);
        } else if (decision === 'lost-machine-ack') {
            expect(await request).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            expect(hook.getCurrent()).toMatchObject({ outcome: { kind: 'unknown', errorCode: 'outcome_unknown' } });
            expect(spends).toHaveLength(1);
            expect(applied).toBe(false);
            expect(Modal.alert).not.toHaveBeenCalled();
        } else if (decision === 'unconfirmed-provider-receipt') {
            expect(await request).toMatchObject({ ok: false, errorCode: 'connected_service_quota_recovery_credit_failed',
                effectAttempted: true, details: { receipt: unconfirmedReceipt } });
            expect(spends).toHaveLength(1);
            expect(applied).toBe(false);
            expect(Modal.alert).not.toHaveBeenCalled();

        } else if (decision === 'consumed-without-projection') {
            expect(await request).toMatchObject({ ok: false, errorCode: 'connected_service_quota_recovery_credit_refresh_unavailable',
                details: { receipt: { ...unconfirmedReceipt, status: 'consumed' } } });
            expect(hook.getCurrent().outcome).toBeNull();
            expect(applied).toBe(true);
            expect(spends).toHaveLength(1);
            expect(Modal.alert).not.toHaveBeenCalled();
        } else {
            expect(rpc).not.toHaveBeenCalled();
            expect(applied).toBe(false);
        }
    } finally {
        answerConsent?.(false);
        await hook.unmount(); await request;
        await serverScopedRpcSocketPool.stopAll(); resetScopedMachineTransportCacheForTests();
        installDisconnectedServerSocketBoundary();
        await account.dispose(); await home.reset(); bridge.dispose(); storage.getState().clearProfileScope();
    }
});

it.each([null, 'different-machine'])('refuses a usage reset outside the explicitly admitted detail machine (%s)', async machineId => {
    const bridge = await loadSyncSingletonForTests();
    await adoptHomeProfile({ descriptor: { serverUrl: 'https://reset-admission.test', homeServerIdentityId: 'srv_reset_admission' }, source: 'manual' });
    const account = await restoreServerAccountForTest({ serverUrl: 'https://reset-admission.test', accountId: 'reset-account',
        request: async () => Response.json({}, { status: 404 }) });
    const active = getActiveServerSnapshot();
    const machine = createMachineFixture({ id: 'selected-machine', activeAt: Date.now() });
    storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'reset-account' });
    await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'reset-account' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'reset-account' });
    storage.setState({ settings: { ...settingsDefaults, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: 'srv_reset_admission', machineId: machine.id },
    } }, settingsVersion: 1 });
    storage.getState().applyMachines([machine], true, { sourceServerId: active.serverId });
    storage.setState({ isDataReady: true });
    // Socket RPC is the external effect; target resolution and the consume operation remain real.
    const rpc = vi.spyOn(apiSocket, 'machineRPC').mockResolvedValue({ ok: true,
        receipt: { idempotencyKey: 'reset-receipt', status: 'consumed' }, snapshot: null });
    let applied = false;
    const hook = await renderHook(() => useAccountUsageResetAction({ legacyServiceId: 'openai-codex', accountId: 'work',
        machineId, snapshotFetchedAtMs: 1, onApplied: () => { applied = true; } }));
    try {
        await act(async () => { await hook.getCurrent().use(null); });
        expect(rpc).not.toHaveBeenCalled();
        expect(applied).toBe(false);
    } finally { await hook.unmount(); await account.dispose(); bridge.dispose(); storage.getState().clearProfileScope(); }
});
