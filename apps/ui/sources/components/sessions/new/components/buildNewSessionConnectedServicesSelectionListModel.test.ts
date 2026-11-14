import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { presentDirectDeliveryDisclosure } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import { describe, expect, it, vi } from 'vitest';
import type { GestureResponderEvent } from 'react-native';
import { buildConnectedServiceAccountGroupOptionsByServiceId } from '../modules/connectedServicesNewSessionBindings';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

import {
    buildNewSessionConnectedServicesSelectionListModel,
    createConnectedServiceGroupOptionId,
    createConnectedServiceOptionId,
    createNativeServiceOptionId,
    createReauthServiceOptionId,
    createTeamResourceServiceOptionId,
    foldUnavailableSelectionRows,
    type NewSessionConnectedServicesSelectionListModel,
} from './buildNewSessionConnectedServicesSelectionListModel';
import { presentConnectedAccountSignedOut } from '@/components/settings/connectedServices/account/connectedAccountCredentialStatusLabel';
import { t } from '@/text';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { getBundledAgentDeclaration } from '@/agents/catalog/catalog';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { applyProjectedCredentialKindRestrictions, buildQualifiedConnectedAccountProfileOptionsByServiceId,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';

function firstStaticSection(model: NewSessionConnectedServicesSelectionListModel) {
    const section = model.rootStep.sections[0];
    if (!section || section.kind !== 'static') {
        throw new Error('Expected a static connected service section');
    }
    return section;
}

/** A service's current choice is a fact of its row (the list draws its check), never a leading radio. */
function isSelectedRow(row: { selected?: boolean }): boolean {
    return row.selected === true;
}

function buildModel(overrides: Partial<Parameters<typeof buildNewSessionConnectedServicesSelectionListModel>[0]> = {}) {
    return buildNewSessionConnectedServicesSelectionListModel({
        supportedServiceIds: ['anthropic'],
        profileOptionsByServiceId: {
            anthropic: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
        },
        groupOptionsByServiceId: {},
        bindingsByServiceId: { anthropic: { source: 'native' } },
        setBindingForService: vi.fn(),
        onOpenSettings: vi.fn(),
        translate: ((key: string, params?: { profileId?: string }) =>
            key === 'connectedServices.detail.groups.activeMember' && params?.profileId
                ? `Active ${params.profileId}`
                : key) as Parameters<typeof buildNewSessionConnectedServicesSelectionListModel>[0]['translate'],
        resolveServiceTitle: (serviceId) => `service:${serviceId}`,
        renderRowIcon: ({ kind }) => `icon:${kind}`,
        renderBrowseMark: () => 'browse-mark',
        renderSettingsIcon: () => 'settings-icon',
        ...overrides,
    });
}

describe('buildNewSessionConnectedServicesSelectionListModel', () => {
    it.each(['muse', 'pi', 'opencode', 'codex'])('filters brokered Team sources using %s provider declarations while retaining personal login', agentId => {
        const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
        const key = `${service.pluginId}/${service.localId}`;
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'shared-muse', teamId: 'team-1', displayName: { content: { t: 'plain' as const, v: 'Shared Muse' }, recipientEnvelope: null, legacyPlaintext: true }, resourceRevision: 1,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
            sourcePresentation: { kind: 'connected_service', service },
            connectedServiceSelections: [{ source: 'team_resource', resourceId: 'shared-muse', deliveryMode: 'brokered' }],
        });
        const model = buildModel({ supportedServiceIds: [key],
            profileOptionsByServiceId: { [key]: [{ profileId: 'own-muse', status: 'connected' }] },
            nativeRoute: { agentTargetKey: `agent:happier.agent.${agentId}/${agentId}`, active: true },
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Shared Muse' },
        });
        const options = model.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(options.some(option => option.id === createTeamResourceServiceOptionId(resource.connectedServiceSelections[0]!))).toBe(agentId !== 'muse');
        expect(options.some(option => option.id === createConnectedServiceOptionId(key, 'own-muse'))).toBe(true);
    });
    it.each([
        { agentId: 'codex', pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        { agentId: 'opencode', pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        { agentId: 'opencode', pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    ] as const)('selects recorded null-kind $localId accounts and their pool for $agentId without reconnecting', ({ agentId, pluginId, localId }) => {
        const service = { pluginId, localId };
        const serviceKey = `${service.pluginId}/${service.localId}`;
        const profile = AccountProfileSchema.parse({ id: 'recorded-null-kind-owner', connectedAccountsV4: [{
            ref: { service, accountId: 'primary' }, status: 'connected', kind: null, authenticationModeId: 'oauth',
            configurationReady: false, configurationRevision: null, revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
        }], connectedAccountGroupsV4: [{ v: 1, ref: { service, groupId: 'work' }, displayName: 'Work',
            incarnation: 'work:1', generation: 2, runtimeStateRevision: 3, policy: { autoSwitch: true },
            activeConnectedAccountId: 'primary', state: {}, createdAt: 0, updatedAt: 0,
            members: [{ v: 1, connectedAccountId: 'primary', priority: 0, enabled: true, state: {}, createdAt: 0, updatedAt: 0 }],
        }] });
        const declaration = getBundledAgentDeclaration(agentId);
        if (!declaration) throw new Error(`Missing bundled ${agentId} declaration`);
        const connectedAccounts = (declaration.connectedAccounts ?? []).map(purpose => ({ ...purpose,
            service: qualifyPluginContributionReferenceV1(purpose.service, declaration.identity.pluginId) }));
        const supportedServiceIds = resolveProjectedConnectedAccountServiceKeys(connectedAccounts)
            .filter(key => key === serviceKey);
        const profileOptionsByServiceId = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({ accounts: profile.connectedAccountsV4,
                supportedServiceIds, labelsByKey: {} }),
            connectedAccounts,
        });
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({ supportedServiceIds, profileOptionsByServiceId,
            groupOptionsByServiceId: buildQualifiedConnectedAccountGroupOptionsByServiceId({
                groups: profile.connectedAccountGroupsV4, supportedServiceIds }),
            bindingsByServiceId: {}, setBindingForService, onOpenSettings });
        const rows = firstStaticSection(model).options;
        const account = rows.find(row => row.id === createConnectedServiceOptionId(serviceKey, 'primary'));
        const pool = rows.find(row => row.id === createConnectedServiceGroupOptionId(serviceKey, 'work'));
        expect(account).toBeDefined();
        expect(pool).toBeDefined();
        account?.onSelect?.();
        pool?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith(serviceKey, { source: 'connected', selection: 'profile', profileId: 'primary' });
        expect(setBindingForService).toHaveBeenCalledWith(serviceKey, { source: 'connected', selection: 'group', groupId: 'work' });
        expect(onOpenSettings).not.toHaveBeenCalled();
    });
    it('creates freshness visuals only for mounted pool rows in a thousand-pool chooser', () => {
        const renderPoolFreshness = vi.fn(() => 'reading-age');
        const model = buildModel({ renderPoolFreshness,
            quotaSnapshotsByKey: { 'anthropic/work': { meters: [], fetchedAt: Date.now(), staleAfterMs: 60_000 } },
            groupOptionsByServiceId: { anthropic: Array.from({ length: 1000 }, (_, index) => ({
                groupId: `pool-${index}`, label: `Pool ${index}`, status: 'ready' as const, activeProfileId: 'work',
                memberProfileIds: ['work'], enabledMemberCount: 1, autoSwitch: true,
            })) } });
        expect(firstStaticSection(model).options.filter(row => row.id.includes(':group:'))).toHaveLength(1000);
        expect(renderPoolFreshness).toHaveBeenCalledTimes(0);
        const pool = firstStaticSection(model).options.find(row => row.id === createConnectedServiceGroupOptionId('anthropic', 'pool-999'))!;
        expect(typeof pool.subtitleContent).toBe('function');
        if (typeof pool.subtitleContent === 'function') pool.subtitleContent();
        expect(renderPoolFreshness).toHaveBeenCalledTimes(1);
    });
    it('shows only the pool selected limits, retains raw account limits and passes the reading age to the row', () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({ v: 1, serviceId: 'anthropic', profileId: 'work',
            fetchedAt: now - 120_000, staleAfterMs: 60_000, planLabel: null, accountLabel: null,
            meters: [
                { meterId: 'session', label: 'Session', remainingPct: 0, status: 'ok', unit: 'requests', used: 100, limit: 100, utilizationPct: 100, resetsAt: now + 60_000, details: {} },
                { meterId: 'weekly', label: 'Weekly', remainingPct: 75, status: 'ok', unit: 'requests', used: 25, limit: 100, utilizationPct: 25, resetsAt: now + 600_000, details: {} },
            ] });
        const renderPoolFreshness = vi.fn(() => 'reading-age');
        const model = buildModel({ quotaSnapshotsByKey: { 'anthropic/work': snapshot },
            quotaErrorsByKey: { 'anthropic/work': 'quota_unavailable' }, renderPoolFreshness,
            groupOptionsByServiceId: { anthropic: [{ groupId: 'pool', label: 'Pool', status: 'ready', activeProfileId: 'work',
                memberProfileIds: ['work'], enabledMemberCount: 1, autoSwitch: true,
                quotaLimitSelection: { mode: 'selected', providerLimitIds: ['weekly'] } }] } });
        const rows = firstStaticSection(model).options;
        const pool = rows.find(row => row.id === createConnectedServiceGroupOptionId('anthropic', 'pool'))!;
        expect(pool.subtitle).toContain('75%');
        expect(pool.subtitle).not.toContain('Session');
        expect(rows.find(row => row.id === createConnectedServiceOptionId('anthropic', 'work'))?.subtitle).toContain('Session');
        expect(typeof pool.subtitleContent).toBe('function');
        if (typeof pool.subtitleContent === 'function') pool.subtitleContent();
        expect(renderPoolFreshness).toHaveBeenCalledWith(expect.objectContaining({ asOf: snapshot.fetchedAt, isStale: true, notAnswering: true }), expect.any(String), expect.any(String));
        vi.restoreAllMocks();
    });
    it('keeps ready accounts visible with their switch restriction instead of calling their credentials unavailable', () => {
        const model = buildModel({ includeNativeAuthOption: false,
            resolveOptionAvailability: () => ({ disabled: true, availability: 'available' as const,
                subtitle: 'Finish or stop the current turn' }),
        });
        const sections = foldUnavailableSelectionRows(model.rootStep.sections, model.optionAvailabilityById, 'Unavailable');
        expect(sections.some(section => section.id === 'unavailable')).toBe(false);
        expect(firstStaticSection(model).options[0]).toMatchObject({ disabled: true, subtitle: 'Finish or stop the current turn' });
    });

    it('keeps usable accounts before unavailable credentials even when recovery remains actionable', () => {
        const unavailableId = createConnectedServiceOptionId('anthropic', 'blocked');
        const signedOutId = createReauthServiceOptionId('anthropic', 'signed-out');
        const model = buildModel({ includeNativeAuthOption: false,
            profileOptionsByServiceId: {
                anthropic: [
                    { profileId: 'blocked', status: 'connected' }, { profileId: 'ready', status: 'connected' },
                    { profileId: 'signed-out', status: 'needs_reauth' },
                ],
                'another-service': [{ profileId: 'other-agent', status: 'connected' }],
            },
            resolveOptionAvailability: ({ optionId }) => optionId === unavailableId
                ? { disabled: true, subtitle: 'Not usable on this Machine' } : {},
        });
        expect(firstStaticSection(model).options.map(option => option.id)).toEqual([
            createConnectedServiceOptionId('anthropic', 'ready'), unavailableId, signedOutId,
        ]);
        expect(model.optionAvailabilityById.get(unavailableId)).toEqual({
            availability: 'unavailable', unavailableReason: 'Not usable on this Machine',
        });
        expect(model.optionAvailabilityById.get(signedOutId)?.availability).toBe('unavailable');
        expect(firstStaticSection(model).options.at(-1)?.onSelect).toEqual(expect.any(Function));
    });
    it('shows the same exhausted weekly quota and reset for a connected account and its pool without changing selection', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1, serviceId: 'anthropic', profileId: 'work', fetchedAt: Date.now(), staleAfterMs: 60_000,
            planLabel: null, accountLabel: null, meters: [{ meterId: 'weekly', label: 'Weekly',
                used: 100, limit: 100, remainingPct: 0, unit: 'requests', utilizationPct: 100,
                resetsAt: Date.now() + 3600_000, status: 'ok', details: {}, windowDurationMs: 604800_000 }],
        });
        const model = buildModel({ quotaSnapshotsByKey: { 'anthropic/work': snapshot,
            'anthropic/signed-out': { ...snapshot, meters: snapshot.meters.map(meter => ({ ...meter, remainingPct: 100 })) } },
            profileOptionsByServiceId: { anthropic: [{ profileId: 'work', status: 'connected' }, { profileId: 'signed-out', status: 'needs_reauth' }] },
            groupOptionsByServiceId: { anthropic: [{ groupId: 'pool', label: 'Pool', status: 'ready',
                activeProfileId: 'work', memberProfileIds: ['work', 'signed-out'], enabledMemberCount: 2, autoSwitch: true }] },
        });
        const rows = firstStaticSection(model).options;
        const account = rows.find(row => row.id === createConnectedServiceOptionId('anthropic', 'work'))!;
        const pool = rows.find(row => row.id === createConnectedServiceGroupOptionId('anthropic', 'pool'))!;
        expect(account.subtitle).toContain('0%');
        expect(pool.subtitle).toContain('0%');
        expect(account.subtitle).toContain('1h');
        expect(pool.subtitle).toContain('1h');
        expect(account.disabled).toBe(false);
        expect(pool.disabled).toBe(false);
        vi.restoreAllMocks();
    });
    it('opens Connect from the control used for an empty or signed-out service', () => {
        const onOpenSettings = vi.fn();
        const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
        // Only currentTarget crosses this platform press boundary; domain selection does not read other fields.
        const event = { currentTarget: trigger } as unknown as GestureResponderEvent;
        const model = buildModel({ profileOptionsByServiceId: { anthropic: [{ profileId: 'work', status: 'needs_reauth' }] }, onOpenSettings });
        const rows = firstStaticSection(model).options;
        for (const id of [createReauthServiceOptionId('anthropic', 'work'), 'connected-service:anthropic:connect']) {
            const row = rows.find(candidate => candidate.id === id);
            expect(row).toBeDefined();
            row?.onSelect?.(event);
            expect(onOpenSettings).toHaveBeenLastCalledWith('anthropic', { kind: 'view', ref: { current: trigger } });
        }
    });

    it('leads each row with what it is and marks the current choice with a trailing check (RT1)', () => {
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'bot', status: 'connected', providerEmail: 'bot@example.com' },
                ],
            },
            groupOptionsByServiceId: buildConnectedServiceAccountGroupOptionsByServiceId({
                accountGroupsFeatureEnabled: true,
                supportedConnectedServiceIds: ['anthropic'],
                accountProfileConnectedServicesV2: [{ serviceId: 'anthropic', groups: [{
                    groupId: 'pool', label: 'Work pool', status: 'ready', activeProfileId: 'work',
                    enabledMemberCount: 1, autoSwitch: false,
                }] }],
            }),
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'group', groupId: 'pool' } },
        });
        const rows = firstStaticSection(model).options;
        const byId = new Map(rows.map(row => [row.id, row]));
        const pool = byId.get(createConnectedServiceGroupOptionId('anthropic', 'pool'));
        const work = byId.get(createConnectedServiceOptionId('anthropic', 'work'));
        const native = byId.get(createNativeServiceOptionId('anthropic'));
        // Identity stays on the left whatever is chosen; the choice never replaces the mark.
        expect(pool?.icon).toBe('icon:group');
        expect(work?.icon).toBe('icon:account');
        expect(native?.icon).toBe('icon:native');
        // Exactly the chosen row is current; usage is the row's one subtitle line, never a second chip.
        expect(rows.filter(isSelectedRow).map(row => row.id)).toEqual([pool?.id]);
        expect(work?.rightAccessory).toBeUndefined();
    });

    it('projects one Agent-native browse row across services without authoring credentials', () => {
        const onBrowse = vi.fn();
        const setBindingForService = vi.fn();
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'anthropic-api-key'],
            bindingsByServiceId: { anthropic: { source: 'native' }, 'anthropic-api-key': { source: 'native' } },
            nativeRoute: { agentTargetKey: 'agent:happier.agent.claude/claude', active: true, onBrowse },
            setBindingForService,
        });
        const rows = model.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        const nativeRows = rows.filter(row => row.label === 'connectedServices.authModal.nativeAuthTitle');
        expect(nativeRows).toHaveLength(1);
        expect(rows.filter(isSelectedRow)).toEqual(nativeRows);
        expect(model.selectedOptionId).toBe(nativeRows[0]?.id);
        nativeRows[0]?.onSelect?.();
        expect(onBrowse).toHaveBeenCalledOnce();
        expect(setBindingForService).not.toHaveBeenCalled();
    });

    it('keeps a native source choice disabled when its auth owner refuses a service change', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'anthropic-api-key'],
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' } },
            nativeRoute: { agentTargetKey: 'agent:happier.agent.claude/claude', active: false, onBrowse: vi.fn() },
            resolveOptionAvailability: ({ serviceId, binding }) => serviceId === 'anthropic' && binding.source === 'native'
                ? { disabled: true } : {},
        });
        expect(firstStaticSection(model).options[0].disabled).toBe(true);
    });

    it('does not check dormant native credentials while a Provider route is applied', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'anthropic-api-key'],
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' }, 'anthropic-api-key': { source: 'native' } },
            nativeRoute: { agentTargetKey: 'agent:happier.agent.claude/claude', active: false, onBrowse: vi.fn() },
        });
        const rows = model.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(rows.filter(isSelectedRow)).toEqual([]);
        expect(model.selectedOptionId).toBeNull();
    });

    it('checks the connected native account without checking an unused service fallback', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'anthropic-api-key'],
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' }, 'anthropic-api-key': { source: 'native' } },
            nativeRoute: { agentTargetKey: 'agent:happier.agent.claude/claude', active: true, onBrowse: vi.fn() },
        });
        const rows = model.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(rows.filter(isSelectedRow).map(row => row.id)).toEqual([
            createConnectedServiceOptionId('anthropic', 'work'),
        ]);
    });

    it('does not check Native for unread inherited bindings while retaining explicit Native recovery', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ bindingsByServiceId: {}, bindingsKnown: false, setBindingForService });
        expect(model.selectedOptionId).toBeNull();
        const native = firstStaticSection(model).options.find(option => option.id === createNativeServiceOptionId('anthropic'));
        expect(native && isSelectedRow(native)).toBe(false);
        native?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'native' });
    });
    it('keeps routing identity out of an account row after device identity presentation', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: { anthropic: [{
                profileId: 'opaque-route-42', status: 'connected', label: 'Work', providerEmail: 'wo•••@e•••.com',
            }, { profileId: 'unnamed-route-43', status: 'connected' }] },
            setBindingForService,
        });
        const row = firstStaticSection(model).options.find((option) => option.id === createConnectedServiceOptionId('anthropic', 'opaque-route-42'));
        expect(row).toMatchObject({ label: 'Work', subtitle: 'wo•••@e•••.com' });
        expect(row?.accessibilityLabel).toContain('wo•••@e•••.com');
        expect(row?.accessibilityLabel).not.toContain('opaque-route-42');
        expect(firstStaticSection(model).options.find((option) => option.id === createConnectedServiceOptionId('anthropic', 'unnamed-route-43')))
            .toMatchObject({ label: t('connectedServicesCollection.accountLabel', { service: 'service:anthropic' }) });
        row?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'connected', selection: 'profile', profileId: 'opaque-route-42' });
    });

    it('offers each brokered Connected Account and Pool resource exactly once', () => {
        const setBindingForService = vi.fn();
        const service = { pluginId: 'service.plugin', localId: 'mail' } as const;
        const resources = [
            { id: 'account-resource', displayName: 'Brokered account' },
            { id: 'pool-resource', displayName: 'Brokered pool' },
        ].map(({ id, displayName }) => ({
            id,
            teamId: 'team-1',
            displayName: { content: { t: 'plain' as const, v: displayName }, recipientEnvelope: null, legacyPlaintext: true },
            sourceOwnerDisplayName: null, resourceRevision: 7,
            readiness: { kind: 'available' as const },
            recoveryAction: null,
            deliveryMode: 'brokered' as const,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: { kind: 'connected_service' as const, service },
            connectedServiceSelections: [{
                source: 'team_resource' as const,
                resourceId: id,
                deliveryMode: 'brokered' as const,
            }],
        }));
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            setBindingForService,
            teamCredentialResources: resources, teamCredentialDisplayNames: { 'account-resource': 'Brokered account', 'pool-resource': 'Brokered pool' },
            teamNameById: { 'team-1': 'Acme' },
        });

        const options = firstStaticSection(model).options;
        expect(options.filter((option) => option.label === 'Brokered account')).toHaveLength(1);
        expect(options.filter((option) => option.label === 'Brokered pool')).toHaveLength(1);
        options.find((option) => option.label === 'Brokered pool')?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('service.plugin/mail', {
            source: 'team_resource',
            resourceId: 'pool-resource',
            deliveryMode: 'brokered',
        });
        const providerRoute = buildModel({
            supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {},
            bindingsByServiceId: { 'service.plugin/mail': resources[1]!.connectedServiceSelections[0] },
            teamCredentialResources: resources, teamCredentialDisplayNames: { 'account-resource': 'Brokered account', 'pool-resource': 'Brokered pool' },
            nativeRoute: { agentTargetKey: 'agent:acme.agent/reviewer', active: false, onBrowse: vi.fn() },
        });
        const providerRouteRows = providerRoute.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(providerRouteRows.filter(option => option.label === 'Brokered pool')).toHaveLength(1);
        expect(providerRouteRows.filter(isSelectedRow)).toEqual([]);

        // Applied route identity remains authoritative even before the Agent's
        // native browse descriptor is available, including a retained missing binding.
        for (const resourceId of ['account-resource', 'resource-gone']) {
            const applied = buildModel({
                supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {},
                bindingsByServiceId: { 'service.plugin/mail': { source: 'team_resource', resourceId, deliveryMode: 'brokered' } },
                teamCredentialResources: resources, teamCredentialDisplayNames: { 'account-resource': 'Brokered account', 'pool-resource': 'Brokered pool' },
                appliedTeamRoute: { teamId: 'team-1', resourceId: 'pool-resource', deliveryMode: 'brokered' },
            });
            const appliedRows = firstStaticSection(applied).options;
            const expectedId = createTeamResourceServiceOptionId(resources[1]!.connectedServiceSelections[0]!);
            expect(appliedRows.filter(isSelectedRow).map(row => row.id)).toEqual([expectedId]);
            expect(applied.selectedOptionId).toBe(expectedId);
        }
        const missingApplied = buildModel({
            supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {}, bindingsByServiceId: {},
            teamCredentialResources: resources, teamCredentialDisplayNames: { 'account-resource': 'Brokered account', 'pool-resource': 'Brokered pool' },
            appliedTeamRoute: { teamId: 'team-1', resourceId: 'resource-gone', deliveryMode: 'brokered' },
        });
        expect(firstStaticSection(missingApplied).options.filter(isSelectedRow)).toEqual([]);
        expect(missingApplied.selectedOptionId).toBeNull();
    });

    it('writes the exact recipient-safe Team resource witness selected in New Session', () => {
        const setBindingForService = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'service.plugin', localId: 'mail' },
                accountId: 'shared-account',
            },
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            setBindingForService,
            teamCredentialDisplayNames: { 'resource-1': 'Shared mail' },
            teamCredentialResources: [{
                id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain' as const, v: 'Shared mail' }, recipientEnvelope: null, legacyPlaintext: true },
                sourceOwnerDisplayName: null, resourceRevision: 7, readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: false, mayReceiveDirect: true,
                directMaterialState: 'current', directDeliveryRecorded: true, sessionUsePolicy: 'personal_allowed',
                providerModels: [],
                sourcePresentation: {
                    kind: 'connected_service',
                    service: selection.disclosedMember.service,
                },
                connectedServiceSelections: [selection],
            }],
            teamNameById: { 'team-1': 'Acme' },
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({ label: 'Shared mail' });
        // Disclosure stays on the choice even when first delivery was already recorded.
        expect(option?.subtitle).toContain('teams.credentials.directUse.ownerVisibility');
        expect(option?.subtitle).toContain('teams.credentials.directUse.sharedUserVisibility');
        expect(setBindingForService).not.toHaveBeenCalled();
        option?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('service.plugin/mail', selection);
    });

    it('says where agents run on the selected target now: their own user once separate users are effective', () => {
        const selection = { source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'direct' as const,
            disclosedMember: { service: { pluginId: 'service.plugin', localId: 'mail' }, accountId: 'shared-account' } };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {}, bindingsByServiceId: {},
            includeNativeAuthOption: false, setBindingForService: vi.fn(),
            teamCredentialDisplayNames: { 'resource-1': 'Shared mail' },
            teamCredentialResources: [{
                id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain' as const, v: 'Shared mail' }, recipientEnvelope: null, legacyPlaintext: true }, sourceOwnerDisplayName: null, resourceRevision: 7,
                readiness: { kind: 'available' }, recoveryAction: null, mayBroker: false, mayReceiveDirect: true,
                directMaterialState: 'current', directDeliveryRecorded: true, sessionUsePolicy: 'personal_allowed',
                providerModels: [], sourcePresentation: { kind: 'connected_service', service: selection.disclosedMember.service },
                connectedServiceSelections: [selection],
            }],
            directDelivery: presentDirectDeliveryDisclosure({ platform: 'linux',
                isolationPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
                isolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }),
        });
        const subtitle = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)))?.subtitle;
        expect(subtitle).toContain('teams.credentials.directUse.separatePlacement');
        expect(subtitle).toContain('teams.credentials.directUse.sharedBeforeSeparation');
        expect(subtitle).not.toContain('teams.credentials.directUse.sharedUserVisibility');
    });

    it.each([false, true])('keeps Team recovery actionable without changing the binding while switching is blocked: %s', (switchBlocked) => {
        const recover = vi.fn();
        const setBindingForService = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'service.plugin', localId: 'mail' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain' as const, v: 'Shared mail' }, recipientEnvelope: null, legacyPlaintext: true }, sourceOwnerDisplayName: null, resourceRevision: 7,
            readiness: { kind: 'source_unavailable' as const }, recoveryAction: 'source_owner_action' as const,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'stale' as const, sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: { kind: 'connected_service' as const, service: selection.disclosedMember.service },
            connectedServiceSelections: [selection],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {},
            bindingsByServiceId: {}, includeNativeAuthOption: false,
            setBindingForService, teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Shared mail' },
            onRecoverTeamCredentialResource: recover,
            resolveOptionAvailability: () => switchBlocked
                ? { disabled: true, availability: 'available', subtitle: 'Finish the current turn' } : {},
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({ disabled: false });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
        expect(setBindingForService).not.toHaveBeenCalled();
    });

    it('retains a stale catalog resource with recovery instead of silently removing it', () => {
        const recover = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'stale-resource',
            deliveryMode: 'brokered' as const,
        };
        const resource = {
            id: selection.resourceId,
            teamId: 'team-1',
            displayName: { content: { t: 'plain' as const, v: 'Shared build account' }, recipientEnvelope: null, legacyPlaintext: true },
            sourceOwnerDisplayName: null, resourceRevision: 8,
            readiness: { kind: 'available' as const },
            recoveryAction: null,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'service.plugin', localId: 'mail' },
            },
            connectedServiceSelections: [selection],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Shared build account' },
            teamCredentialResourceStatusByKey: new Map(),
            teamNameById: { 'team-1': 'Acme' },
            onRecoverTeamCredentialResource: recover,
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({
            disabled: false,
            subtitle: 'Acme · Unavailable · Try again',
        });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('keeps a missing retained Team resource selected and unavailable instead of selecting native', () => {
        const binding = {
            source: 'team_resource' as const,
            resourceId: 'revoked-resource',
            deliveryMode: 'brokered' as const,
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: { 'service.plugin/mail': binding },
            includeNativeAuthOption: true,
            teamCredentialResources: [],
        });

        expect(model.selectedOptionId).toBe(createTeamResourceServiceOptionId(binding));
        expect(firstStaticSection(model).options.find((option) => (
            option.id === createTeamResourceServiceOptionId(binding)
        ))).toMatchObject({ disabled: true, subtitle: 'common.unavailable' });
        expect(model.selectedOptionId).not.toBe(createNativeServiceOptionId('service.plugin/mail'));
    });

    it('keeps the Home presentation and recovery action for a retained unavailable Team resource', () => {
        const recover = vi.fn();
        const binding = {
            source: 'team_resource' as const,
            resourceId: 'unavailable-resource',
            deliveryMode: 'brokered' as const,
        };
        const resource = {
            id: binding.resourceId,
            teamId: 'team-1',
            displayName: { content: { t: 'plain' as const, v: 'Shared build account' }, recipientEnvelope: null, legacyPlaintext: true },
            sourceOwnerDisplayName: null, resourceRevision: 8,
            readiness: { kind: 'source_unavailable' as const },
            recoveryAction: 'source_owner_action' as const,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'service.plugin', localId: 'mail' },
            },
            // The resource is retained for presentation/recovery, but the Home
            // correctly publishes no currently selectable binding.
            connectedServiceSelections: [],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: { 'service.plugin/mail': binding },
            includeNativeAuthOption: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Shared build account' },
            teamNameById: { 'team-1': 'Acme' },
            onRecoverTeamCredentialResource: recover,
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(binding)
        ));
        expect(option).toMatchObject({
            label: 'Shared build account',
            subtitle: 'Acme · Source removed · Ask the owner',
            disabled: false,
        });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
        expect(model.selectedOptionId).toBe(createTeamResourceServiceOptionId(binding));
        expect(model.selectedOptionId).not.toBe(createNativeServiceOptionId('service.plugin/mail'));
    });

    it('leaves connected-account-only selection empty instead of presenting native auth as persisted', () => {
        const model = buildModel({
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
        });

        expect(model.selectedOptionId).toBeNull();
        expect(firstStaticSection(model).options.some((option) =>
            option.id === createNativeServiceOptionId('anthropic')
        )).toBe(false);
    });

    it('does not visually replace an unavailable exact binding with the general default profile', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'unavailable-exact-account',
                },
            },
            defaultProfileIdByServiceId: { anthropic: 'work' },
            includeNativeAuthOption: false,
            allowDefaultProfileFallback: false,
        });

        expect(model.selectedOptionId).toBeNull();
    });

    it('puts connected account rows first and binds the selected account directly', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ setBindingForService });

        const accountOption = firstStaticSection(model).options[0];
        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'work'),
            label: 'work@example.com',
            subtitle: undefined,
        }));

        accountOption?.onSelect?.();

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        });
    });

    it('offers connected account groups as a distinct explicit selection', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            groupOptionsByServiceId: {
                anthropic: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'work',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'ready',
                    },
                ],
            },
        });

        const groupOption = firstStaticSection(model).options[0];
        expect(groupOption).toEqual(expect.objectContaining({
            id: createConnectedServiceGroupOptionId('anthropic', 'team'),
            label: 'Team',
            subtitle: 'Active work@example.com',
        }));

        groupOption?.onSelect?.();

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
        });
    });

    it('omits unavailable account groups from selectable session auth options', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            groupOptionsByServiceId: {
                anthropic: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'work',
                        enabledMemberCount: 0,
                        autoSwitch: true,
                        status: 'needs_members',
                    },
                    {
                        groupId: 'quota-exhausted',
                        label: 'Quota exhausted',
                        activeProfileId: 'work',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'exhausted',
                    },
                ],
            },
        });

        const section = firstStaticSection(model);

        expect(section.options.some((option) =>
            option.id === createConnectedServiceGroupOptionId('anthropic', 'team')
        )).toBe(false);
        expect(section.options.some((option) =>
            option.id === createConnectedServiceGroupOptionId('anthropic', 'quota-exhausted')
        )).toBe(false);
        expect(model.selectedOptionId).toBe(createNativeServiceOptionId('anthropic'));
        expect(setBindingForService).not.toHaveBeenCalled();
    });

    it('selects native auth when a group binding is no longer available', () => {
        const model = buildModel({
            defaultProfileIdByServiceId: { anthropic: 'work' },
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-team',
                },
            },
        });

        const section = firstStaticSection(model);
        const accountOption = section.options.find((option) =>
            option.id === createConnectedServiceOptionId('anthropic', 'work')
        );
        const nativeOption = section.options.find((option) =>
            option.id === createNativeServiceOptionId('anthropic')
        );

        expect(model.selectedOptionId).toBe(createNativeServiceOptionId('anthropic'));
        expect(accountOption && isSelectedRow(accountOption)).toBe(false);
        expect(nativeOption && isSelectedRow(nativeOption)).toBe(true);
    });

    it('keeps local CLI auth as the fallback row for each supported service', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' } },
            setBindingForService,
        });

        const nativeOption = firstStaticSection(model).options.find((option) => option.id === createNativeServiceOptionId('anthropic'));
        nativeOption?.onSelect?.();

        expect(nativeOption).toEqual(expect.objectContaining({
            label: 'connectedServices.authModal.nativeAuthTitle',
            subtitle: 'connectedServices.authModal.nativeAuthSubtitle',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'native' });
    });

    it('routes unavailable connected accounts to settings instead of selecting an invalid profile', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const reauthOption = firstStaticSection(model).options.find((option) => option.id === createReauthServiceOptionId('anthropic', 'work'));
        reauthOption?.onSelect?.();

        // One vocabulary for a signed-out account, as a row line rather than a rose pill.
        expect(reauthOption?.subtitle).toBe(presentConnectedAccountSignedOut().phrase);
        expect(reauthOption?.rightAccessory).toBeUndefined();
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic', undefined);
    });

    it('keeps retryable refresh-failure profiles selectable instead of routing them to reconnect', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'retryable', status: 'refresh_failed_retryable', providerEmail: 'retryable@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const accountOption = firstStaticSection(model).options.find((option) =>
            option.id === createConnectedServiceOptionId('anthropic', 'retryable')
        );
        accountOption?.onSelect?.();

        expect(accountOption).toEqual(expect.objectContaining({
            label: 'retryable@example.com',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'retryable',
        });
        expect(onOpenSettings).not.toHaveBeenCalled();
    });

    it('routes connected accounts that need reauth through the reconnect callback when available', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const onReconnectProfile = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
            onReconnectProfile,
        });

        const reauthOption = firstStaticSection(model).options.find((option) => option.id === createReauthServiceOptionId('anthropic', 'work'));
        reauthOption?.onSelect?.();

        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).not.toHaveBeenCalled();
        expect(onReconnectProfile).toHaveBeenCalledWith('anthropic', 'work', undefined);
    });

    it('shows unsupported connected account kinds as action-required setup guidance rows', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{
                    profileId: 'oauth-work',
                    status: 'unsupported_kind',
                    kind: 'oauth',
                    providerEmail: 'oauth@example.com',
                    unsupportedSubtitleKey: 'connectedServices.detail.connectSetupTokenSubtitle',
                }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const unsupportedOption = firstStaticSection(model).options.find((option) =>
            option.id === createReauthServiceOptionId('anthropic', 'oauth-work'));
        unsupportedOption?.onSelect?.();

        expect(unsupportedOption).toEqual(expect.objectContaining({
            id: createReauthServiceOptionId('anthropic', 'oauth-work'),
            subtitle: 'connectedServices.detail.connectSetupTokenSubtitle',
        }));
        expect(unsupportedOption?.rightAccessory).toBeUndefined();
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic', undefined);
    });

    it('folds signed-out accounts and unusable Team resources into one trailing Unavailable section', () => {
        const selection = { source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'brokered' as const };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain' as const, v: 'Shared Codex' }, recipientEnvelope: null, legacyPlaintext: true }, sourceOwnerDisplayName: null, resourceRevision: 1,
            readiness: { kind: 'broker_unavailable' as const }, recoveryAction: 'source_owner_action' as const,
            deliveryMode: 'brokered' as const, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const, sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: { kind: 'connected_service' as const, service: { pluginId: 'service.plugin', localId: 'mail' } },
            connectedServiceSelections: [selection],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: { 'service.plugin/mail': [
                { profileId: 'old', status: 'needs_reauth', providerEmail: 'old@example.com' },
                { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
            ] },
            bindingsByServiceId: {}, teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Shared Codex' },
            onRecoverTeamCredentialResource: vi.fn(),
        });
        const browse = { kind: 'static' as const, id: 'route-sources:providers', title: 'Providers', options: [
            { id: 'route-source:ready', label: 'Ready' },
            { id: 'route-source:other', label: 'Other agent', disabled: true },
        ] };

        const sections = foldUnavailableSelectionRows([...model.rootStep.sections, browse], model.optionAvailabilityById, 'Unavailable');
        const last = sections[sections.length - 1];
        expect(last?.kind === 'static' && last.title).toBe('Unavailable (3)');
        expect(last?.kind === 'static' && last.options.map(option => option.id)).toEqual([
            createTeamResourceServiceOptionId(selection),
            createReauthServiceOptionId('service.plugin/mail', 'old'),
            'route-source:other',
        ]);
        // Every row above the group is usable, in its own section.
        expect(sections.slice(0, -1).flatMap(section => section.kind === 'static' ? section.options.map(option => option.id) : []))
            .toEqual([createConnectedServiceOptionId('service.plugin/mail', 'work'), createNativeServiceOptionId('service.plugin/mail'), 'route-source:ready']);
        // A short reason with the step the viewer can take, not the Home's long sentence.
        const team = last?.kind === 'static' ? last.options[0] : undefined;
        expect(team?.subtitle).toBe('Broker offline · Ask the owner');
        expect(model.optionAvailabilityById.get(createReauthServiceOptionId('service.plugin/mail', 'old')))
            .toEqual({ availability: 'unavailable', unavailableReason: presentConnectedAccountSignedOut().state });
        expect(model.optionAvailabilityById.get(createConnectedServiceOptionId('service.plugin/mail', 'work')))
            .toEqual({ availability: 'available', unavailableReason: null });
    });

    it('qualifies repeated service fallback rows for assistive technology', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'openai-codex'],
            profileOptionsByServiceId: {
                anthropic: [],
                'openai-codex': [],
            },
            groupOptionsByServiceId: {},
            bindingsByServiceId: {
                anthropic: { source: 'native' },
                'openai-codex': { source: 'native' },
            },
        });

        const nativeRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':native'))
            .map((option) => option as unknown as { accessibilityLabel?: string });
        const connectRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':connect'))
            .map((option) => option as unknown as { accessibilityLabel?: string });

        expect(nativeRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.nativeAuthTitle',
            'service:openai-codex · connectedServices.authModal.nativeAuthTitle',
        ]);
        expect(connectRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.notConnectedTitle',
            'service:openai-codex · connectedServices.authModal.notConnectedTitle',
        ]);
    });
});
