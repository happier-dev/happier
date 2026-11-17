import { describe, expect, it } from 'vitest';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';

import { teamCredentialDisplayNameFixture, teamCredentialResourceFixture } from '@/dev/testkit';
import { t } from '@/text';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialUsageQueryInputV1Schema, resolveConnectedAccountNativeLoginConstraintsV1 } from '@happier-dev/protocol/teams';

import {
    audienceSummary,
    brokerPlacementLabel,
    teamCredentialBrokerPlacementAction,
    orderTeamCredentialResources,
    resourceAccessibilityLabel,
    resourceAdministrationSummaryLines,
    resourceDeliverySummary,
    resourceState,
    resourceStateLabel,
    credentialFailureMessage,
    credentialApprovalFailureMessage,
    credentialBrokeredSourceUseMessage,
    recoveryDestinationIsNavigable,
    teamCredentialRecoveryPresentation,
    resourceConnectedServiceMarkId,
    resolveTeamCredentialUsageStartTimeSeconds,
    teamCredentialListSharedState,
} from './teamCredentialPresentation';

describe('teamCredentialPresentation', () => {
    it.each(['approval_canceled', 'approval_rejected'])('keeps %s silent for immediate and deferred credential mutations', (code) => {
        expect(credentialFailureMessage({ kind: 'forbidden', retryable: false, code })).toBeNull();
        expect(credentialApprovalFailureMessage(code)).toBeNull();
        expect(credentialFailureMessage({ kind: 'forbidden', retryable: false, code: 'resource_forbidden' }))
            .toBe(t('teams.credentials.forbidden'));
    });

    it('explains the declared native-login constraint without a hardcoded compatible Agent roster', () => {
        const message = credentialBrokeredSourceUseMessage({ pluginId: 'happier.agent.muse', localId: 'muse-account' });
        expect(message).toContain('Muse');
        expect(credentialBrokeredSourceUseMessage({ pluginId: 'acme', localId: 'muse-account' })).toBeUndefined();
    });
    it('explains an installed plugin constraint and does not borrow its same-local-id neighbor', () => {
        const service = { pluginId: 'acme.login', localId: 'subscription' };
        const descriptor = projectConnectedAccountDescriptorV1({ descriptor: { id: service.localId, title: 'Acme Login',
            authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } },
            serviceId: service.localId, pluginId: service.pluginId, provenance: 'external', sourceKind: 'installed',
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
            nativeLoginRequiredBy: resolveConnectedAccountNativeLoginConstraintsV1(service, [{ identity: { pluginId: 'acme.agent', localId: 'native' }, title: 'Acme Native',
                connectedAccounts: [{ service }] }]),
        });
        const registry = { entries: [{ serviceId: service.localId, service, connectCommand: '', supportsOauth: false, projectedDescriptor: descriptor }] };
        expect(credentialBrokeredSourceUseMessage(service, registry))
            .toBe(t('teams.credentials.edit.brokeredNativeLoginUse', { agentNames: 'Acme Native' }));
        expect(credentialBrokeredSourceUseMessage({ ...service, pluginId: 'other.login' }, registry)).toBeUndefined();
        expect(credentialBrokeredSourceUseMessage(service, { entries: [] })).toBeUndefined();
    });
    it('names a saved broker from the same Home-qualified machine presentation as its editor', () => {
        const picker = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a', serverIdentityId: 'identity-a',
            machines: [
                { machineId: 'broker', displayName: 'Wrong Home', serverId: 'profile-b', serverIdentityId: 'identity-b' },
                { machineId: 'broker', displayName: 'Studio · e298', serverId: 'profile-a', serverIdentityId: 'identity-a' },
            ],
        });
        const resource = teamCredentialResourceFixture({ brokerPlacement: { kind: 'machine', machineId: 'broker' } });
        expect(brokerPlacementLabel(resource, { serverId: 'profile-a', pickerRows: picker.pickerRows })).toBe('Studio · e298');
        expect(brokerPlacementLabel({ ...resource, capabilities: { ...resource.capabilities, updateBrokerPlacement: false } }, {
            serverId: 'profile-a', pickerRows: picker.pickerRows,
        })).toBe(t('teams.credentials.detail.brokerChosen'));
    });
    it('offers broker selection only to the source owner instead of handing the owner to themselves', () => {
        const owner = teamCredentialResourceFixture({
            brokerPlacement: { kind: 'machine', machineId: 'private-machine' },
        });
        const member = teamCredentialResourceFixture({
            ...owner,
            capabilities: { ...owner.capabilities, updateBrokerPlacement: false },
        });
        expect(brokerPlacementLabel(owner)).not.toBe(brokerPlacementLabel(member));
        expect(teamCredentialBrokerPlacementAction(owner)).toEqual({
            destination: 'broker_selection', labelKey: 'teams.credentials.recovery.selectBroker',
        });
        expect(teamCredentialBrokerPlacementAction(member)).toBeNull();
    });

    it('never reads a broker the Home did not name as unavailable', () => {
        const placement = { kind: 'machine', machineId: 'machine-3ca2' } as const;
        const base = teamCredentialResourceFixture({ brokerPlacement: placement });
        // An online broker without a display name, and a placement the Home did not present to this viewer:
        // neither is an availability fact, so neither may say "Unavailable".
        const unnamedOnline = teamCredentialResourceFixture({ brokerPlacement: placement, brokerPresentation: {
            ...base.brokerPresentation,
            selectedTarget: { machineId: 'machine-3ca2', displayName: null, availability: 'available' },
        } });
        const unpresented = teamCredentialResourceFixture({ brokerPlacement: placement, brokerPresentation: {
            ...base.brokerPresentation, selectedTarget: null,
        } });
        expect(brokerPlacementLabel(unnamedOnline)).toBe(t('teams.credentials.detail.brokerUnnamedMachine'));
        expect(brokerPlacementLabel(unpresented)).toBe(t('teams.credentials.detail.brokerUnnamedMachine'));
    });
    it('presents recipient-only reconnect readiness without requiring manager-private fields or models', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'shared-resource', teamId: 'team-1', displayName: teamCredentialDisplayNameFixture('Shared Codex'), resourceRevision: 1,
            sourcePresentation: teamCredentialResourceFixture().sourcePresentation,
            readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' },
            recoveryAction: 'source_owner_action', allowedRoutes: ['brokered'], mayBroker: true,
            mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [], connectedServiceSelections: [],
        });
        expect(resourceAdministrationSummaryLines(resource)).toContain(resourceStateLabel(resource.readiness));
        expect(resourceAccessibilityLabel(resource, 'Shared Codex')).toContain(resourceStateLabel(resource.readiness));
    });

    it('preserves the explicit Team All epoch and host-local Today bounds', () => {
        const nowMs = new Date(2026, 10, 4, 13, 30).getTime();
        const all = TeamCredentialUsageQueryInputV1Schema.parse({ resourceId: 'resource',
            startMs: resolveTeamCredentialUsageStartTimeSeconds('all', nowMs) * 1000, endMs: nowMs });
        expect(all.startMs).toBe(0);
        expect(resolveTeamCredentialUsageStartTimeSeconds('today', nowMs)).toBe(new Date(2026, 10, 4).getTime() / 1000);
    });

    it('resolves a recipient-safe service presentation through the connected-service mark owner', () => {
        expect(resourceConnectedServiceMarkId({
            sourcePresentation: { kind: 'connected_service', service: {
                pluginId: 'happier.agent.claude', localId: 'claude-subscription',
            } },
        }, { entries: [] })).toBe('claude-subscription');
        expect(resourceConnectedServiceMarkId({
            sourcePresentation: { kind: 'connected_service', service: {
                pluginId: 'external.plugin', localId: 'claude-subscription',
            } },
        }, { entries: [] })).toBeNull();
        expect(resourceConnectedServiceMarkId({ sourcePresentation: null }, { entries: [] })).toBeNull();
    });

    it('reports mixed delivery rather than flattening disagreeing grants', () => {
        const brokeredOnly = teamCredentialResourceFixture({
            groupGrants: [{ teamGroupId: 'group-1', allowedRoutes: ['brokered'] }],
        });
        expect(resourceDeliverySummary(brokeredOnly)).toBe('Brokered');

        const mixed = teamCredentialResourceFixture({
            allMembersAllowedRoutes: ['brokered'],
            memberGrants: [{ teamMembershipId: 'membership-1', allowedRoutes: ['direct'] }],
        });
        // Flattening this to either mode would tell an administrator that the
        // resource is entirely safe or entirely disclosing, and neither is true.
        expect(resourceDeliverySummary(mixed)).toBe('Mixed delivery');
    });

    it('says nothing about delivery when nobody holds access', () => {
        expect(resourceDeliverySummary(teamCredentialResourceFixture())).toBeNull();
    });

    it('reports the Team-wide grant separately from the grant counts', () => {
        expect(audienceSummary(teamCredentialResourceFixture())).toBe('No one yet');
        expect(audienceSummary(teamCredentialResourceFixture({
            allMembersAllowedRoutes: ['brokered'],
            groupGrants: [{ teamGroupId: 'group-1', allowedRoutes: ['brokered'] }],
        }))).toBe('Everyone in the Team · 1 Group');
        // A Team-wide grant is not one more counted audience: collapsing it into
        // the counts would hide the broadest grant behind the narrowest ones.
        expect(audienceSummary(teamCredentialResourceFixture({
            memberGrants: [{ teamMembershipId: 'membership-1', allowedRoutes: ['brokered'] }],
        }))).toBe('1 person');
    });

    it('says one cause shared by several rows once, above the list, and keeps a lone or different cause on its row', () => {
        const unreachable = (id: string) => teamCredentialResourceFixture({ id, readiness: { kind: 'broker_unavailable' } });
        const first = unreachable('resource-1');
        const second = unreachable('resource-2');
        const healthy = teamCredentialResourceFixture({ id: 'resource-3', readiness: { kind: 'available' } });
        const cause = resourceStateLabel(first.readiness);

        const shared = teamCredentialListSharedState([first, healthy, second]);
        expect(shared).not.toBeNull();
        expect(shared).toContain(cause);
        // The rows that share it no longer repeat it; their identity line stays.
        expect(resourceAdministrationSummaryLines(first, shared)).toEqual(resourceAdministrationSummaryLines(healthy, shared));
        expect(resourceAdministrationSummaryLines(first, shared).join('\n')).not.toContain(shared!);
        // A screen reader still hears each row's state in the row itself.
        expect(resourceAccessibilityLabel(first, 'Harbor')).toContain(shared!);

        // One affected row keeps its own cause; two different causes are not one.
        expect(teamCredentialListSharedState([first, healthy])).toBeNull();
        const other = teamCredentialResourceFixture({ id: 'resource-4', readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' } });
        expect(teamCredentialListSharedState([first, second, other])).toBeNull();
    });

    it('renders the Home-owned readiness instead of inferring it from audience or enabled state', () => {
        const known = { audienceKnown: true };
        expect(resourceState(teamCredentialResourceFixture({
            readiness: { kind: 'broker_unavailable' },
            enabled: true,
            allMembersAllowedRoutes: ['brokered'],
        }), known)).toBe('broker_unavailable');
        expect(resourceState(teamCredentialResourceFixture({
            readiness: { kind: 'available' },
            enabled: false,
        }), known)).toBe('available');
    });

    it('presents a reached limit as the admission state, not as an invalid editor form', () => {
        expect(resourceStateLabel('limit_reached')).toBe('Limit reached');
    });

    it('retains source reconnect readiness in the resource accessible description', () => {
        const readiness = { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' } as const;
        const owner = teamCredentialResourceFixture({ sourceOwnerDisplayName: 'Alice', readiness, recoveryAction: 'source_owner_action' });
        const manager = teamCredentialResourceFixture({
            sourceOwnerDisplayName: 'Alice', readiness, recoveryAction: 'source_owner_action',
            capabilities: { updateBrokerPlacement: false, narrowDisclosure: false, refreshDirectMaterial: false },
        });
        expect(resourceAccessibilityLabel(owner, 'Claude Enterprise')).toContain('Connected account needs reconnect');
        // Only someone who cannot reconnect it is told whom to ask; the owner is not told to ask themselves.
        expect(resourceAccessibilityLabel(owner, 'Claude Enterprise')).not.toContain('Alice');
        expect(resourceAccessibilityLabel(manager, 'Claude Enterprise')).toContain('Alice');
        expect(credentialFailureMessage({ kind: 'invalid', retryable: false,
            code: 'connected_service_credential_reconnect_required',
        })).toContain(t('teams.credentials.recovery.ownerHandoff'));
    });

    it('never derives a state from an audience the Home did not disclose', () => {
        // A member is shown empty grant lists because the audience is not
        // theirs to see. Reading that as "nobody has access" would tell them
        // the resource they are entitled to use needs attention.
        expect(resourceState(teamCredentialResourceFixture())).toBe('available');
        expect(resourceAccessibilityLabel(teamCredentialResourceFixture(), 'Claude Enterprise'))
            .toBe('Claude Enterprise, Connected service pool, Available');
    });

    it('puts source, delivery and state in the accessible name rather than the layout', () => {
        const label = resourceAccessibilityLabel(teamCredentialResourceFixture({
            allMembersAllowedRoutes: ['brokered'],
        }), 'Claude Enterprise', { audienceKnown: true });
        expect(label).toBe('Claude Enterprise, Connected service pool, Brokered, Available');
    });

    it('shows the Home-projected broker display identity without exposing its opaque Machine id', () => {
        const resource = teamCredentialResourceFixture({
            brokerPlacement: { kind: 'machine', machineId: 'machine-private-identifier' },
            brokerPresentation: {
                selectedTarget: {
                    machineId: 'machine-private-identifier',
                    displayName: "Alice's Mac mini",
                    availability: 'available',
                },
                eligibleTargets: [],
                selectedPool: null,
                eligiblePools: [],
            },
        });

        expect(brokerPlacementLabel(resource)).toBe("Alice's Mac mini");
        expect(brokerPlacementLabel(resource)).not.toContain('machine-private-identifier');
    });

    it('shows the Home-projected Machine Pool name without exposing its opaque Pool id', () => {
        const resource = teamCredentialResourceFixture({
            brokerPlacement: { kind: 'machine_pool', poolId: 'pool-private-identifier' },
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [],
                selectedPool: {
                    poolId: 'pool-private-identifier',
                    displayName: {
                        kind: 'available',
                        label: teamCredentialDisplayNameFixture('Build machines'),
                    },
                    availability: 'not_verified',
                    availableMachineCount: null,
                },
                eligiblePools: [],
            },
        });

        // A Pool is named as one, so the detail line cannot be mistaken for a Machine.
        expect(brokerPlacementLabel(resource, {
            poolDisplayNames: { 'pool-private-identifier': 'Build machines' },
        })).toBe('Machine pools · Build machines');
        expect(brokerPlacementLabel(resource, {
            poolDisplayNames: { 'pool-private-identifier': 'Build machines' },
        })).not.toContain('pool-private-identifier');
    });

    it('orders by display name so a status change never moves a row', () => {
        const ordered = orderTeamCredentialResources([
            teamCredentialResourceFixture({ id: 'b', displayName: 'Zeta', updatedAt: '2026-09-01T00:00:00.000Z' }),
            teamCredentialResourceFixture({ id: 'c', displayName: 'Alpha' }),
            teamCredentialResourceFixture({ id: 'a', displayName: 'Alpha' }),
        ], { a: 'Alpha', b: 'Zeta', c: 'Alpha' });
        expect(ordered.map((row) => row.id)).toEqual(['a', 'c', 'b']);
    });

    it('uses the canonical Team outcome-unknown recovery instead of claiming the mutation failed', () => {
        expect(credentialFailureMessage({ kind: 'outcome_unknown', retryable: true, code: null }))
            .toBe('The Home may have completed this change. Refresh the Team before trying again.');
    });

    it('names every Home refusal a credential surface can receive instead of a generic failure', () => {
        const refusal = (code: string) => credentialFailureMessage({ kind: 'invalid', retryable: false, code });
        expect(refusal('team_credential_usage_limit')).toBe('Limit reached');
        expect(refusal('feature_disabled')).toBe('This Home does not offer shared credentials.');
        expect(refusal('team_authentication_required')).toBe('Sign in to this Team before continuing.');
        expect(refusal('team_authentication_policy_unavailable')).toBe(
            'This Team\u2019s sign-in policy could not be read, so nothing changed.',
        );
        expect(refusal('member_not_eligible')).toBe('This person cannot use this credential.');
        expect(refusal('session_policy_incompatible')).toBe(
            'This credential cannot be used in this session under its sharing policy.',
        );
    });

    it('turns cost-limit capability refusal into the supported recovery choice', () => {
        expect(credentialFailureMessage({
            kind: 'invalid', retryable: false, code: 'cost_limit_unavailable',
        })).toBe(
            'A cost limit needs a price for every model this credential allows, and some are missing one. Limit requests or tokens instead.',
        );
    });

    it('maps every Home recovery action once and hands source-only repairs back to the custodian', () => {
        expect(teamCredentialRecoveryPresentation('retry')).toEqual({
            destination: 'retry', labelKey: 'teams.unavailable.retry',
        });
        expect(teamCredentialRecoveryPresentation('source_owner_action', { isSourceCustodian: true })).toEqual({
            destination: 'resource_settings', labelKey: 'teams.credentials.recovery.openSettings',
        });
        expect(teamCredentialRecoveryPresentation('source_owner_action', { isSourceCustodian: false })).toEqual({
            destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff',
        });
        expect(teamCredentialRecoveryPresentation('select_broker', { isSourceCustodian: true })).toEqual({
            destination: 'broker_selection', labelKey: 'teams.credentials.recovery.selectBroker',
        });
        expect(teamCredentialRecoveryPresentation('select_broker', { isSourceCustodian: false })).toEqual({
            destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff',
        });
        expect(teamCredentialRecoveryPresentation('update_required')).toEqual({
            destination: 'app_update', labelKey: 'teams.credentials.recovery.updateApp',
        });
        expect(teamCredentialRecoveryPresentation('choose_another_resource')).toEqual({
            destination: 'choose_another_resource', labelKey: 'teams.credentials.recovery.chooseAnother',
        });
    });

    it('treats alternate selection as a real destination while source-owner handoff remains guidance', () => {
        expect(recoveryDestinationIsNavigable('choose_another_resource')).toBe(true);
        expect(recoveryDestinationIsNavigable('source_owner_handoff')).toBe(false);
    });
});
