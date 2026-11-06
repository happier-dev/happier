import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { UsageWidgetBodyModel } from './useUsageWidgetResource';
import { ConnectedPresentationRecordV1Schema, ConnectedPresentationRowMutationV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { UsagePlanAccount } from './widgets/plans/usagePlansModel';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { UsageCapacityAlertsSettingsGroup } = await import('../session/UsageCapacityAlertsSettingsGroup');
const { ProviderUsageGaugeSettingsGroup } = await import('../connectedServices/ProviderUsageGaugeSettingsGroup');
const { UsageNightShiftWidget } = await import('./widgets/UsageNightShiftWidget');
const { UsageCoachWidget } = await import('./widgets/UsageCoachWidget');
const { UsageModelPricesEditor } = await import('./widgets/UsageModelPrices');
const { UsageSubscriptionPriceEditor } = await import('./widgets/plans/UsagePlanActions');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { SessionModelRoutingHint } = await import('@/components/sessions/modelPicker/SessionModelRoutingHint');
const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { normalizeUsageQuery, getUsageQueryKey } = await import('@happier-dev/protocol/inputs/usageQuery');
const { ApprovalRequestV2Schema, AccountProfileSchema } = await import('@happier-dev/protocol');
const { z } = await import('zod/mini');
const machineRpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { t } = await import('@/text');

const settingsInput = z.object({ content: z.object({ t: z.literal('plain'), v: z.record(z.string(), z.unknown()) }), expectedVersion: z.number() });
let serverId: string;
let raw: Record<string, unknown>;
let version: number;

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    await loadSyncSingletonForTests();
    serverId = await harness.addHome({ name: 'Usage settings', serverUrl: 'https://usage-settings.test', accountId: 'usage-account', currentAccount: true });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    raw = {};
    version = 1;
    storage.setState({ settings: settingsParse(raw), settingsScope: { serverId, accountId: 'usage-account' }, profileScope: { serverId, accountId: 'usage-account' }, settingsVersion: version });
    harness.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
    // Persisted settings and its CAS are the genuine HTTP boundary. All declaration, Action and
    // approval logic above it stays real, including the store projection after acknowledgement.
    harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const parsed = settingsInput.parse(input);
        expect(parsed.expectedVersion).toBe(version);
        raw = parsed.content.v;
        return { body: { success: true, version: ++version } };
    } });
    harness.answer(serverId, '/v1/auth/ping', { body: {} });
    harness.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    harness.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-settings.test');
    if (!credentials) throw new Error('The synthetic Home credential is missing');
    await restoreConnectionToActiveServer(credentials);
    const { sync } = await import('@/sync/sync');
    const settingsQueue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await settingsQueue.awaitQueue();
    storage.setState({ settings: settingsParse(raw), settingsScope: { serverId, accountId: 'usage-account' }, profileScope: { serverId, accountId: 'usage-account' }, settingsVersion: version });
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'usage-account' });
    // Seed policy only after restoration: before this point the harness correctly
    // seeds the saved Home, not the not-yet-applied Account's live settings.
    await harness.requireUiApproval(serverId, 'settings.set');
    raw = { ...storage.getState().settings };
    harness.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
});
afterEach(async () => { standardCleanup(); await disconnectActiveServerConnection(); });

function approvalFor(anchor: string) {
    return harness.artifacts(serverId).list().find(artifact => {
        const request = ApprovalRequestV2Schema.safeParse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
        return request.success && request.data.actionId === 'settings.set'
            && request.data.actionArgs && typeof request.data.actionArgs === 'object'
            && 'anchor' in request.data.actionArgs && request.data.actionArgs.anchor === anchor;
    });
}

async function renderNight() {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, metric: 'tokens', granularity: 'day' });
    const slice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false, sources: [] };
    const identity = { query, authority: { serverId, accountId: 'usage-account' } };
    const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    return renderScreen(<UsageNightShiftWidget id="usage_night_shift" testID="night" serverId={serverId} query={query} slice={slice} model={model} />);
}

function priceSlice() {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const contribution = { id: 'c1', observedAtMs: 150, sessionId: null, turnId: null, agentId: null, modelId: 'qa-private-model',
        machineId: null, projectKey: null, workspaceId: null, source: null, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } };
    return { query, slice: { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false,
        sources: [{ source: 'accounting' as const, status: 'available' as const }],
        accounting: { v: 1 as const, totals: { eventCount: 1, tokens, cost: contribution.cost }, contributions: [contribution] } } };
}

describe('Usage settings UI Action admission', () => {
    it('round-trips mounted Save and Clear through quota read-back when the provider reports no subscription', async () => {
        const { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol');
        const { ConnectedServiceQuotaGetResultV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createUiConnectedServiceAction } = await import('@/sync/ops/actions/connectedServiceActionDeps');
        const ref = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'personal' };
        const source = { ref, bindingKind: 'account' as const };
        const recordKey = { providerId: 'claude', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
        const now = Date.now();
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'claude', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
            staleAfterMs: 60000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
        const profile = AccountProfileSchema.parse({ id: 'usage-account', connectedAccountsV4: [{ ref,
            status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
            revisionSemantics: 'legacy_unfenced', credentialRevision: null }] });
        storage.setState({ profile });
        harness.answer(serverId, '/v1/account/profile', { body: profile });
        let record = ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [] });
        let revision = 1;
        harness.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/presentation', {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: record } } }),
        });
        harness.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/acknowledgements', {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } },
        });
        harness.answer(serverId, 'POST /v1/account/entity-rows/connected-metadata/presentation', { select: input => {
            const body = ConnectedPresentationRowMutationV1Schema.parse(input);
            expect(body.expectedRevision).toBe(revision);
            if (body.content?.t !== 'plain') throw new Error('Expected keyless personal metadata');
            record = body.content.v;
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
        harness.answer(serverId, '/v4/connect/qualified/provider-account-usage/sources/resolve', { body: {
            source, recordId: snapshot.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 60000,
        } });
        harness.answer(serverId, '/v4/connect/qualified/provider-account-usage/record', { body: {
            content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: now, staleAfterMs: 60000, status: 'ok' }, sources: [source],
        } });
        harness.answer(serverId, 'POST /v2/pending/reset-starts/read', { body: { entries: [] } });
        const captured = await captureLazyActionAccountContext(serverId);
        const action = createUiConnectedServiceAction(captured);
        const initial: UsagePlanAccount = { key: 'subscription', source, service: ref.service, accountId: ref.accountId,
            groupId: null, planLabel: null, accountLabel: null, state: { source: 'quota', status: 'available' }, read: null,
            windows: [], headline: null, stale: false, observedAtMs: now, subscription: null,
            prices: { paid: null, list: null, entered: null }, recoveryCredits: undefined };
        let readBack: Promise<void> | undefined;
        function MountedEditor() {
            const [account, setAccount] = React.useState(initial);
            return <UsageSubscriptionPriceEditor account={account} serverId={serverId} testID="roundtrip" onSettled={() => {
                readBack = action({ actionId: 'connectedServices.quota.get', input: { source }, context: { surface: 'ui', authority: 'present_user' } })
                    .then(read => setAccount({ ...initial, subscription: ConnectedServiceQuotaGetResultV1Schema.parse(read).current?.subscription ?? null }));
            }} />;
        }
        const screen = await renderScreen(<MountedEditor />);
        try {
            await screen.pressByTestIdAsync('roundtrip-header');
            const field = (name: string) => screen.findAllByType(FieldTextInput).find(input => input.props.testID === `roundtrip.${name}`)!;
            await act(async () => { field('amount').props.onChangeText('1.23'); field('currency').props.onChangeText('USD'); });
            await screen.pressByTestIdAsync('roundtrip.save');
            await waitForHomeGovernance(() => expect(record.entries[0]?.subscriptionMonthlyPrice).toMatchObject({ amount: 1.23, currency: 'USD' }));
            expect(readBack).toBeDefined();
            await act(async () => { await readBack; });
            expect(screen.findByTestId('roundtrip.clear')).toBeTruthy();
            expect(field('amount').props.value).toBe('1.23');
            await screen.pressByTestIdAsync('roundtrip.clear');
            await waitForHomeGovernance(() => expect(record.entries).toEqual([]));
            await act(async () => { await readBack; });
            expect(screen.findByTestId('roundtrip.clear')).toBeNull();
            expect(field('amount').props.value).toBe('');
            expect(revision).toBe(3);
        } finally { captured.dispose(); await screen.unmount(); }
    });
    it.each([
        ['save', false], ['clear', false], ['save', true], ['clear', true],
    ] as const)('subscription price %s persists through the mounted front door (explicit Ask: %s)', async (operation, requireApproval) => {
        const actionId = 'connectedServices.subscription.price.set';
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'personal' };
        let record = ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [{ v: 1, label: '', subject: { kind: 'account', account: ref },
            subscriptionMonthlyPrice: { amount: 11, currency: 'EUR', enteredAtMs: 1 } }] });
        let revision = 1;
        const original = record;
        const profile = AccountProfileSchema.parse({ id: 'usage-account', connectedAccountsV4: [{ ref,
            status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
            revisionSemantics: 'legacy_unfenced', credentialRevision: null }] });
        storage.setState({ profile });
        harness.answer(serverId, '/v1/account/profile', { body: profile });
        harness.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/presentation', {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: record } } }),
        });
        harness.answer(serverId, 'GET /v1/account/entity-rows/connected-metadata/acknowledgements', {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } },
        });
        harness.answer(serverId, 'POST /v1/account/entity-rows/connected-metadata/presentation', { select: input => {
            const body = ConnectedPresentationRowMutationV1Schema.parse(input);
            expect(body.expectedRevision).toBe(revision);
            if (body.content?.t !== 'plain') throw new Error('Expected keyless personal metadata');
            record = body.content.v;
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
        if (requireApproval) await harness.requireUiApproval(serverId, actionId);
        const account: UsagePlanAccount = { key: 'subscription', source: { ref, bindingKind: 'account' },
            service: ref.service, accountId: ref.accountId, groupId: null, planLabel: null, accountLabel: null,
            state: { source: 'quota', status: 'available' }, read: null, windows: [], headline: null, stale: false,
            observedAtMs: null, subscription: { status: 'subscribed', renewal: 'unknown', observedAtMs: 1, staleAfterMs: 1000,
                enteredMonthlyPrice: { amount: 11, currency: 'EUR', enteredAtMs: 1 } },
            prices: { paid: null, list: null, entered: null }, recoveryCredits: undefined };
        const settled = vi.fn();
        const screen = await renderScreen(<UsageSubscriptionPriceEditor account={account} serverId={serverId} testID="subscription" onSettled={settled} />);
        await screen.pressByTestIdAsync('subscription-header');
        const change = (name: string, value: string) => screen.findAllByType(FieldTextInput)
            .find(input => input.props.testID === `subscription.${name}`)!.props.onChangeText(value);
        await act(async () => { change('amount', '17'); change('currency', 'USD'); });
        expect(screen.findByTestId(`subscription.${operation}`)?.props.disabled).toBe(false);
        const approvals = () => harness.artifacts(serverId).list().filter(artifact => {
            const request = ApprovalRequestV2Schema.safeParse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
            return request.success && request.data.actionId === actionId;
        });
        await screen.pressByTestIdAsync(`subscription.${operation}`);
        if (requireApproval) {
            await waitForHomeGovernance(() => expect(approvals()).toHaveLength(1));
            expect(record).toEqual(original);
            const rejectedId = approvals()[0]!.id;
            await decideApprovalAsInbox(serverId, rejectedId, 'reject');
            await waitForHomeGovernance(() => expect(screen.findByTestId(`subscription.${operation}`)?.props.disabled).toBe(false));
            expect(record).toEqual(original);
            expect(settled).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync(`subscription.${operation}`);
            await waitForHomeGovernance(() => expect(approvals()).toHaveLength(2));
            await decideApprovalAsInbox(serverId, approvals().find(artifact => artifact.id !== rejectedId)!.id, 'approve');
        } else expect(approvals()).toHaveLength(0);
        await waitForHomeGovernance(() => expect(record.entries).toMatchObject(operation === 'clear' ? [] : [{
            subject: { kind: 'account', account: ref }, subscriptionMonthlyPrice: { amount: 17, currency: 'USD' },
        }]));
        expect(revision).toBe(2);
        await waitForHomeGovernance(() => expect(settled).toHaveBeenCalledTimes(1));
        await screen.unmount();
    });

    it('retains mounted local delivery beneath canonical admission and refuses it after Account retirement', async () => {
        const dismissed = new Set<string>();
        const executorOptions = { usageSourceDismiss: async (input: { sourceId: string }) => {
            dismissed.add(input.sourceId);
            return { status: 'dismissed' as const };
        } };
        const hook = await renderHook(() => useMountedActionExecution({ serverId, accountId: 'usage-account' },
            { openOnRequest: true, executorOptions }));
        const input = { serverId, machineId: 'machine', sourceId: 'source' };
        expect(await hook.getCurrent().execute('usage.sources.dismiss', input))
            .toMatchObject({ ok: true, result: { status: 'dismissed' } });
        expect([...dismissed]).toEqual(['source']);
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        expect(await hook.getCurrent().execute('usage.sources.dismiss', { ...input, sourceId: 'retired' }))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect([...dismissed]).toEqual(['source']);
        await hook.unmount();
    });
    it('retries model-price Refresh after approval rejection and refuses a retired control', async () => {
        let refreshes = 0;
        harness.answer(serverId, 'POST /v1/account/usage/prices/refresh', { select: () => {
            refreshes++;
            return { body: { v: 1, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
                provenance: { source: 'litellm', origin: 'bundled', asOfMs: 100, revision: 'refreshed', fetchStatus: 'ready' } } };
        } });
        await harness.requireUiApproval(serverId, 'usage.prices.refresh');
        raw = { ...storage.getState().settings };
        const { sync } = await import('@/sync/sync');
        await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
        expect(storage.getState().settings.actionsSettingsV1.actions['usage.prices.refresh'])
            .toMatchObject({ approvalRequiredSurfaces: ['ui'] });
        const { slice } = priceSlice();
        const screen = await renderScreen(<UsageModelPricesEditor slice={slice} serverId={serverId} testID="prices" />);
        const refreshId = 'prices.provenance.refresh';
        const approvals = () => harness.artifacts(serverId).list().filter(artifact => {
            const request = ApprovalRequestV2Schema.safeParse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
            return request.success && request.data.actionId === 'usage.prices.refresh';
        });
        await act(async () => { screen.pressByTestId(refreshId); });
        await waitForHomeGovernance(() => expect(approvals()).toHaveLength(1));
        expect(refreshes).toBe(0);
        expect(screen.findByTestId(refreshId)?.props.disabled).toBe(true);
        const rejectedId = approvals()[0]!.id;
        expect(await decideApprovalAsInbox(serverId, rejectedId, 'reject')).toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(screen.findByTestId(refreshId)?.props.disabled).toBe(false));
        expect(screen.getTextContent()).not.toContain(t('usage.board.page.pricesFetchFailed'));
        await act(async () => { screen.pressByTestId(refreshId); });
        await waitForHomeGovernance(() => expect(approvals()).toHaveLength(2));
        expect(await decideApprovalAsInbox(serverId, approvals().find(artifact => artifact.id !== rejectedId)!.id, 'approve'))
            .toMatchObject({ ok: true });
        await waitForHomeGovernance(() => {
            expect(refreshes).toBe(1);
            expect(screen.findByTestId(refreshId)?.props.disabled).toBe(false);
        });
        const retiredPress = screen.findByTestId(refreshId)!.props.onPress;
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        const beforeRetiredPress = harness.artifacts(serverId).list().map(artifact => artifact.id);
        await act(async () => { retiredPress(); });
        expect(refreshes).toBe(1);
        expect(harness.artifacts(serverId).list().map(artifact => artifact.id)).toEqual(beforeRetiredPress);
        await screen.unmount();
    });
    it.each([false, true])('sets and resets a model price through its Account owner (explicit Ask: %s)', async requireApproval => {
        if (!requireApproval) {
            raw.actionsSettingsV1 = { v: 1, actions: {} };
            storage.getState().applySettings(settingsParse(raw), ++version);
        }
        const { slice } = priceSlice();
        const screen = await renderScreen(<UsageModelPricesEditor slice={slice} serverId={serverId} testID="prices" />);
        await screen.pressByTestIdAsync('prices.model.qa-private-model.set');
        const field = (name: string) => screen.findAllByType(FieldTextInput).find(input => input.props.testID === `prices.model.qa-private-model.${name}`)!;
        await act(async () => { field('input').props.onChangeText('3'); field('output').props.onChangeText('15'); });
        await screen.pressByTestIdAsync('prices.model.qa-private-model.save');
        if (requireApproval) {
            expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({});
            await waitForHomeGovernance(() => expect(approvalFor('usage.modelPrices')).toBeTruthy());
            await decideApprovalAsInbox(serverId, approvalFor('usage.modelPrices')!.id, 'approve');
        } else expect(approvalFor('usage.modelPrices')).toBeUndefined();
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({
            'qa-private-model': { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 15 } }));
        const previous = new Set(harness.artifacts(serverId).list().map(row => row.id));
        // An approved save closes the row; Reset lives in the open row with the other ways to price it.
        if (!screen.findByTestId('prices.model.qa-private-model.reset')) await screen.pressByTestIdAsync('prices.model.qa-private-model.set');
        await waitForHomeGovernance(() => expect(screen.findByTestId('prices.model.qa-private-model.reset')).toBeTruthy());
        await screen.pressByTestIdAsync('prices.model.qa-private-model.reset');
        const next = () => harness.artifacts(serverId).list().find(row => !previous.has(row.id));
        if (requireApproval) {
            await waitForHomeGovernance(() => expect(next()).toBeTruthy());
            await decideApprovalAsInbox(serverId, next()!.id, 'approve');
        } else expect(next()).toBeUndefined();
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageModelPriceOverridesV1).toEqual({}));
        await screen.unmount();
    });

    it('persists Coach check and model choices only after approval, preserving dismissed evidence', async () => {
        raw.usageCoachPreferencesV1 = { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'keep-dismissed' }] };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
        const slice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false, sources: [] };
        const identity = { query, authority: { serverId, accountId: 'usage-account' } };
        const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null,
            freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageCoachWidget id="usage_coach" testID="coach" serverId={serverId} query={query} slice={slice} model={model} />);
        await screen.pressByTestIdAsync('coach.configure-header');
        await screen.pressByTestIdAsync('coach.preferences.check.mcp_overhead');
        expect(storage.getState().settings.usageCoachPreferencesV1.disabledChecks).toEqual([]);
        await waitForHomeGovernance(() => expect(approvalFor('usage.coachPreferences')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.coachPreferences')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageCoachPreferencesV1.disabledChecks).toEqual(['mcp_overhead']));
        const previousArtifacts = new Set(harness.artifacts(serverId).list().map(row => row.id));
        const dropdown = screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'coach.preferences.model')!;
        await act(async () => { dropdown.props.onSelect('complete_only'); });
        const nextApproval = () => harness.artifacts(serverId).list().find(row => !previousArtifacts.has(row.id));
        await waitForHomeGovernance(() => expect(nextApproval()).toBeTruthy());
        expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('suggest_with_estimates');
        await decideApprovalAsInbox(serverId, nextApproval()!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageCoachPreferencesV1.modelSuggestion).toBe('complete_only'));
        expect(raw.usageCoachPreferencesV1).toMatchObject({ disabledChecks: ['mcp_overhead'], modelSuggestion: 'complete_only',
            suppressions: [{ kind: 'dismissed', evidenceKey: 'keep-dismissed' }] });
        await screen.unmount();
    });
    it('does not bypass a disabled settings Action when the routing preference is pressed', async () => {
        raw.actionsSettingsV1 = { v: 1, actions: { 'settings.set': { enabled: false } } };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup />);
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        expect(raw.usageRoutingHintsEnabled).toBe(true);
        expect(approvalFor('session.providerLimits.routingHints')).toBeUndefined();
        await screen.unmount();
    });

    it('keeps the pace target and individual alert choices unchanged until their declared Actions are approved', async () => {
        const screen = await renderScreen(<UsageCapacityAlertsSettingsGroup />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-usage-alerts-pace')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-usage-alerts-pace');
        expect(storage.getState().settings.usageQuotaNotificationsV1.pace).toBe(false);
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.alertPace')).toBeTruthy());
        expect(raw.usageQuotaNotificationsV1).toMatchObject({ pace: false });
        const artifact = approvalFor('session.providerLimits.alertPace')!;
        await decideApprovalAsInbox(serverId, artifact.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageQuotaNotificationsV1.pace).toBe(true));
        expect(storage.getState().settings.usageQuotaNotificationsV1.depletion).toBe(false);
        await screen.pressByTestIdAsync('settings-usage-pace-target:75');
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.personalPaceTarget')).toBeTruthy());
        expect(storage.getState().settings.usagePacingTargetsV1).toEqual([]);
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.personalPaceTarget')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usagePacingTargetsV1).toEqual([expect.objectContaining({ scope: { kind: 'personal' }, utilizationFraction: 0.75 })]));
        await screen.unmount();
    });

    it('shows custom alert thresholds and lead times from the persisted preference as the chosen option, not Off', async () => {
        raw.usageQuotaNotificationsV1 = { pace: true, almostOutRemainingFraction: 0.15, endingBeforeMs: 36 * 60 * 60 * 1000, creditExpiryBeforeMs: 3 * 24 * 60 * 60 * 1000 };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderScreen(<UsageCapacityAlertsSettingsGroup />);
        const checked = (testID: string) => screen.findByTestId(testID)?.props.accessibilityState?.checked;
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-usage-alerts-almostOut:off')).toBeTruthy());
        expect(checked('settings-usage-alerts-almostOut:0.15')).toBe(true);
        expect(checked('settings-usage-alerts-almostOut:off')).toBe(false);
        expect(checked(`settings-usage-alerts-ending:${36 * 60 * 60 * 1000}`)).toBe(true);
        expect(checked(`settings-usage-alerts-creditExpiry:${3 * 24 * 60 * 60 * 1000}`)).toBe(true);
        expect(checked('settings-usage-alerts-ending:off')).toBe(false);
        await screen.pressByTestIdAsync('settings-usage-alerts-almostOut:off');
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.alertAlmostOut')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.alertAlmostOut')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageQuotaNotificationsV1.almostOutRemainingFraction).toBeNull());
        await screen.unmount();
    });

    it('keeps the routing hint enabled when approval is rejected', async () => {
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-session-providerUsageGauge-routingHints')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.routingHints')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.routingHints')!.id, 'reject');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        await screen.unmount();
    });

    it('applies routing hint, notification and pacing edits directly by default through the settings owner', async () => {
        raw.actionsSettingsV1 = { v: 1, actions: {} };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderScreen(<ProviderUsageGaugeSettingsGroup />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-session-providerUsageGauge-routingHints')).toBeTruthy());
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        await waitForHomeGovernance(() => expect(raw.usageRoutingHintsEnabled).toBe(false));
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(false);
        await screen.pressByTestIdAsync('settings-session-providerUsageGauge-routingHints');
        await waitForHomeGovernance(() => expect(raw.usageRoutingHintsEnabled).toBe(true));
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        expect(approvalFor('session.providerLimits.routingHints')).toBeUndefined();
        await screen.unmount();
        const alerts = await renderScreen(<UsageCapacityAlertsSettingsGroup />);
        await alerts.pressByTestIdAsync('settings-usage-alerts-pace');
        await waitForHomeGovernance(() => expect(raw.usageQuotaNotificationsV1).toMatchObject({ pace: true }));
        await alerts.pressByTestIdAsync('settings-usage-pace-target:75');
        await waitForHomeGovernance(() => expect(raw.usagePacingTargetsV1).toEqual([expect.objectContaining({ utilizationFraction: 0.75 })]));
        expect(approvalFor('session.providerLimits.alertPace')).toBeUndefined();
        expect(approvalFor('session.providerLimits.personalPaceTarget')).toBeUndefined();
        await alerts.unmount();
    });

    it('keeps the picker hint visible while its hide Action awaits approval', async () => {
        const entry = createResolvedAgentCatalogEntryFixture({ agentId: 'claude' });
        const declaration = entry.connectedAccounts[0]!;
        expect(entry.identity).toBeTruthy();
        expect(declaration).toBeTruthy();
        applyConnectedAccountCatalogSnapshot({ serverId, accountId: 'usage-account' }, 'purposes', {
            status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [{
                purpose: { consumer: entry.identity!, purpose: declaration.purpose },
                target: { kind: 'group', service: declaration.service, groupId: 'fallbacks' },
            }] } },
        }, true);
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-settings.test');
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><SessionModelRoutingHint entry={entry} machineId={null} /></InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-model-routing-hint.hide')).toBeTruthy());
        await screen.pressByTestIdAsync('session-model-routing-hint.hide');
        expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(true);
        expect(screen.findByTestId('session-model-routing-hint.hide')).toBeTruthy();
        await waitForHomeGovernance(() => expect(approvalFor('session.providerLimits.routingHints')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('session.providerLimits.routingHints')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageRoutingHintsEnabled).toBe(false));
        expect(screen.findAllByTestId('session-model-routing-hint.hide')).toHaveLength(0);
        await screen.unmount();
    });

    it.each(['transport', 'connected_account_daemon_owner_unavailable', 'connected_account_daemon_runtime_unavailable'] as const)(
        'distinguishes a failed routing read (%s) and recovers when the picker closes and reopens', async failure => {
        const entry = createResolvedAgentCatalogEntryFixture({ agentId: 'claude' });
        const declaration = entry.connectedAccounts[0]!;
        const group = { service: declaration.service, groupId: 'fallbacks' };
        applyConnectedAccountCatalogSnapshot({ serverId, accountId: 'usage-account' }, 'purposes', {
            status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [{
                purpose: { consumer: entry.identity!, purpose: declaration.purpose },
                target: { kind: 'group', ...group },
            }] } },
        }, true);
        const selected = { profileId: 'preferred', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: null };
        const response = ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group, observedAtMs: 1,
            selection: { selected, reason: 'selected', excluded: [], decisionTrace: {
                activeProfileId: selected.profileId, reason: 'selected', strategy: 'priority', selectionBasis: 'preference', sticky: false,
                orderedEligibleCandidates: [selected], candidates: [{ profileId: selected.profileId, decision: 'selected',
                    quotaEvidence: { status: 'fresh', remainingPercent: 75 } }],
            } },
        });
        let requests = 0;
        // Machine RPC is the network boundary; routing reads, Action admission and U3 validation stay real.
        const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(input: ServerScopedMachineRpcParams<A>) => {
            expect(input.method).toBe(CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD);
            input.onIssued?.();
            if (++requests === 1) {
                if (failure === 'transport') throw new Error('RPC discovery temporarily unavailable');
                return ConnectedServicePoolSelectionGetResponseV1Schema.parse({ status: 'unavailable', code: failure }) as R;
            }
            return response as R;
        });
        try {
            const credentials = await TokenStorage.getCredentialsForServerUrl('https://usage-settings.test');
            const content = <InjectedAuthProvider credentials={credentials}><SessionModelRoutingHint entry={entry} machineId="routing-machine" /></InjectedAuthProvider>;
            const screen = await renderScreen(content);
            await waitForHomeGovernance(() => expect(screen.findAllByProps({ children: t('usage.board.plans.hintReadFailed') }).length).toBeGreaterThan(0));
            expect(screen.findAllByProps({ children: t('usage.board.plans.hintUnavailable') })).toHaveLength(0);
            expect(requests).toBe(1);
            await screen.unmount();
            const reopened = await renderScreen(content);
            await waitForHomeGovernance(() => expect(reopened.findAllByProps({ children: t('usage.board.plans.cellLeft', { percent: '75%' }) }).length).toBeGreaterThan(0));
            expect(reopened.findAllByProps({ children: t('usage.board.plans.hintReadFailed') })).toHaveLength(0);
            expect(requests).toBe(2);
            await reopened.unmount();
        } finally { rpc.mockRestore(); }
    });

    it('does not persist partial night hours and withholds a complete range until approval', async () => {
        const screen = await renderNight();
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('23'); });
        expect(approvalFor('usage.nightHours')).toBeUndefined();
        expect(storage.getState().settings.usageNightHoursV1).toBeNull();
        await act(async () => { screen.findAllByType(DropdownMenu)[1]!.props.onSelect('7'); });
        expect(storage.getState().settings.usageNightHoursV1).toBeNull();
        await waitForHomeGovernance(() => expect(approvalFor('usage.nightHours')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.nightHours')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 }));
        const retiredPress = screen.findAllByType(DropdownMenu)[0]!.props.onSelect;
        await act(async () => { await harness.switchAccount(serverId, 'other-account'); });
        await act(async () => { retiredPress('clear'); });
        expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 });
        await screen.unmount();
    });

    it('clears chosen night hours only after approval and discards a partial draft when the Account changes', async () => {
        raw.usageNightHoursV1 = { startHour: 23, endHour: 7 };
        storage.getState().applySettings(settingsParse(raw), ++version);
        const screen = await renderNight();
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('clear'); });
        expect(storage.getState().settings.usageNightHoursV1).toEqual({ startHour: 23, endHour: 7 });
        expect(screen.findAllByType(DropdownMenu).map(control => control.props.selectedId)).toEqual(['23', '7']);
        await waitForHomeGovernance(() => expect(approvalFor('usage.nightHours')).toBeTruthy());
        await decideApprovalAsInbox(serverId, approvalFor('usage.nightHours')!.id, 'approve');
        await waitForHomeGovernance(() => expect(storage.getState().settings.usageNightHoursV1).toBeNull());
        await act(async () => { screen.findAllByType(DropdownMenu)[0]!.props.onSelect('23'); });
        await act(async () => {
            await harness.switchAccount(serverId, 'other-account');
            storage.setState({ settingsScope: { serverId, accountId: 'other-account' } });
        });
        expect(screen.findAllByType(DropdownMenu).map(control => control.props.selectedId)).toEqual([null, null]);
        await screen.unmount();
    });
});
