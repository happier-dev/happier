import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { UsageWidgetBodyModel } from './useUsageWidgetResource';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { UsageCapacityAlertsSettingsGroup } = await import('../session/UsageCapacityAlertsSettingsGroup');
const { ProviderUsageGaugeSettingsGroup } = await import('../connectedServices/ProviderUsageGaugeSettingsGroup');
const { UsageNightShiftWidget } = await import('./widgets/UsageNightShiftWidget');
const { SessionModelRoutingHint } = await import('@/components/sessions/modelPicker/SessionModelRoutingHint');
const { createResolvedAgentCatalogEntryFixture } = await import('@/dev/testkit/fixtures/agentCatalogFixtures');
const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { normalizeUsageQuery, getUsageQueryKey } = await import('@happier-dev/protocol/inputs/usageQuery');
const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol');
const { z } = await import('zod');

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
    await harness.requireUiApproval(serverId, 'settings.set');
    raw = { ...storage.getState().settings };
    harness.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
    // Persisted settings and its CAS are the genuine HTTP boundary. All declaration, Action and
    // approval logic above it stays real, including the store projection after acknowledgement.
    harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const parsed = settingsInput.parse(input);
        expect(parsed.expectedVersion).toBe(version);
        raw = parsed.content.v;
        return { body: { success: true, version: ++version } };
    } });
});
afterEach(() => standardCleanup());

function approvalFor(anchor: string) {
    return harness.artifacts(serverId).list().find(artifact => {
        const request = ApprovalRequestV2Schema.safeParse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
        return request.success && request.data.actionId === 'settings.set'
            && request.data.actionArgs && typeof request.data.actionArgs === 'object'
            && 'anchor' in request.data.actionArgs && request.data.actionArgs.anchor === anchor;
    });
}

describe('Usage settings UI Action admission', () => {
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

    it('turns the routing hint off and on through the admitted settings owner when no approval is requested', async () => {
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
        await screen.unmount();
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
        const screen = await renderScreen(<SessionModelRoutingHint entry={entry} machineId={null} />);
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

    it('does not persist partial night hours and withholds a complete range until approval', async () => {
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, metric: 'tokens', granularity: 'day' });
        const slice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false, sources: [] };
        const identity = { query, authority: { serverId, accountId: 'usage-account' } };
        const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
        const screen = await renderScreen(<UsageNightShiftWidget id="usage_night_shift" testID="night" serverId={serverId} query={query} slice={slice} model={model} />);
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
});
