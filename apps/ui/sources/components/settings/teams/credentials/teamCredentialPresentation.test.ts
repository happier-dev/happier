import { describe, expect, it } from 'vitest';

import { teamCredentialResourceFixture } from '@/dev/testkit';

import {
    audienceSummary,
    brokerPlacementLabel,
    orderTeamCredentialResources,
    resourceAccessibilityLabel,
    resourceDeliverySummary,
    resourceState,
    resourceStateLabel,
    credentialFailureMessage,
    recoveryDestinationIsNavigable,
    teamCredentialRecoveryPresentation,
    resourceConnectedServiceMarkId,
} from './teamCredentialPresentation';

describe('teamCredentialPresentation', () => {
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

    it('never derives a state from an audience the Home did not disclose', () => {
        // A member is shown empty grant lists because the audience is not
        // theirs to see. Reading that as "nobody has access" would tell them
        // the resource they are entitled to use needs attention.
        expect(resourceState(teamCredentialResourceFixture())).toBe('available');
        expect(resourceAccessibilityLabel(teamCredentialResourceFixture()))
            .toBe('Claude Enterprise, Connected service pool, Available');
    });

    it('puts source, delivery and state in the accessible name rather than the layout', () => {
        const label = resourceAccessibilityLabel(teamCredentialResourceFixture({
            allMembersAllowedRoutes: ['brokered'],
        }), { audienceKnown: true });
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
                    displayName: 'Build machines',
                    availability: 'not_verified',
                    availableMachineCount: null,
                },
                eligiblePools: [],
            },
        });

        // A Pool is named as one, so the detail line cannot be mistaken for a Machine.
        expect(brokerPlacementLabel(resource)).toBe('Machine pools · Build machines');
        expect(brokerPlacementLabel(resource)).not.toContain('pool-private-identifier');
    });

    it('orders by display name so a status change never moves a row', () => {
        const ordered = orderTeamCredentialResources([
            teamCredentialResourceFixture({ id: 'b', displayName: 'Zeta', updatedAt: '2026-09-01T00:00:00.000Z' }),
            teamCredentialResourceFixture({ id: 'c', displayName: 'Alpha' }),
            teamCredentialResourceFixture({ id: 'a', displayName: 'Alpha' }),
        ]);
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
