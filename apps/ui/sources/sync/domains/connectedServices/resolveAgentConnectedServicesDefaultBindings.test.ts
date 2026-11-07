import { describe, expect, it } from 'vitest';
import type { ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams';
import { resolveAgentConnectedServicesDefaultBindings } from './resolveAgentConnectedServicesDefaultBindings';

const consumer = { pluginId: 'acme.review', localId: 'reviewer' };
const service = { pluginId: 'acme.review', localId: 'credentials' };
const serviceKey = 'acme.review/credentials';
const agentTargetKey = 'acme.review/reviewer';
const purpose = { consumer, purpose: 'primary' };
const accountDefault = (accountId: string) => ({ purpose, service,
    target: { kind: 'account' as const, account: { service, accountId } }, teamResource: null });
const teamDefaults = (accountId: string): ManagedSessionDefaultsContext => ({ teamDefaults: {
    team: { connectedServicesByAgentTargetKey: { [agentTargetKey]: [accountDefault(accountId)] } }, groups: {},
} });
const base = { settings: {}, purposeBindings: { v: 1 as const, bindings: [] }, agentId: 'reviewer', consumer,
    declarations: [{ purpose: 'primary', service }], agentTargetKey };

describe('resolveAgentConnectedServicesDefaultBindings managed defaults', () => {
    it('keeps absent purposes managed when another purpose has authored intent', () => {
        const secondaryService = { pluginId: 'acme.review', localId: 'secondary' };
        const secondaryPurpose = { consumer, purpose: 'secondary' };
        for (const accountId of ['first', 'pushed']) {
            const input = { ...base, declarations: [...base.declarations, { purpose: 'secondary', service: secondaryService }],
                explicitBindings: { [serviceKey]: { source: 'native' as const } },
                managedSessionDefaults: { teamDefaults: { groups: {}, team: { connectedServicesByAgentTargetKey: {
                    [agentTargetKey]: [{ purpose: secondaryPurpose, service: secondaryService,
                        target: { kind: 'account' as const, account: { service: secondaryService, accountId } }, teamResource: null }],
                } } } },
            };
            expect(resolveAgentConnectedServicesDefaultBindings(input).bindingsByServiceId['acme.review/secondary'])
                .toEqual({ source: 'connected', selection: 'profile', profileId: accountId });
            expect(resolveAgentConnectedServicesDefaultBindings({ ...input, purposeBindings: { v: 1, bindings: [{
                purpose: secondaryPurpose, target: { kind: 'account', account: { service: secondaryService, accountId: 'personal' } },
            }] } }).bindingsByServiceId['acme.review/secondary'])
                .toEqual({ source: 'connected', selection: 'profile', profileId: 'personal' });
        }
    });

    it('derives current Team defaults when no personal or draft choice exists', () => {
        for (const accountId of ['engineering', 'design']) {
            const input = { ...base, managedSessionDefaults: teamDefaults(accountId) };
            expect(resolveAgentConnectedServicesDefaultBindings(input).bindingsByServiceId[serviceKey])
                .toEqual({ source: 'connected', selection: 'profile', profileId: accountId });
        }
        expect(base.purposeBindings).toEqual({ v: 1, bindings: [] });
    });

    it('preserves deliberate Account choices and lets locked policy override draft choices', () => {
        const personal = accountDefault('personal');
        const input = { ...base, purposeBindings: { v: 1 as const, bindings: [{ purpose, target: personal.target }] },
            managedSessionDefaults: teamDefaults('engineering') };
        expect(resolveAgentConnectedServicesDefaultBindings(input).bindingsByServiceId[serviceKey])
            .toEqual({ source: 'connected', selection: 'profile', profileId: 'personal' });
        const locked = { ...input, explicitBindings: { [serviceKey]: { source: 'native' as const } },
            managedSessionDefaults: { ...input.managedSessionDefaults,
                policyDefaults: { locked: true, organization: 'Acme', values: {
                    connectedServicesByAgentTargetKey: { [agentTargetKey]: [accountDefault('required')] },
                } } } };
        expect(resolveAgentConnectedServicesDefaultBindings(locked).bindingsByServiceId[serviceKey])
            .toEqual({ source: 'connected', selection: 'profile', profileId: 'required' });
    });

    it('keeps authored native and retained Team selections when policy is unlocked', () => {
        for (const binding of [{ source: 'native' as const }, {
            source: 'team_resource' as const, resourceId: 'retained-resource', deliveryMode: 'direct' as const,
            disclosedMember: { service, accountId: 'disclosed' },
        }]) {
            const input = { ...base, managedSessionDefaults: teamDefaults('engineering'),
                explicitBindings: { [serviceKey]: binding } };
            expect(resolveAgentConnectedServicesDefaultBindings(input).bindingsByServiceId[serviceKey]).toEqual(binding);
        }
    });

    it('preserves the qualified Team resource selection, including its disclosed member', () => {
        const selection = { source: 'team_resource' as const, resourceId: 'shared-resource', deliveryMode: 'direct' as const,
            disclosedMember: { service, accountId: 'shared-member' } };
        const input = { ...base, managedSessionDefaults: { teamDefaults: { groups: {}, team: {
            connectedServicesByAgentTargetKey: { [agentTargetKey]: [{ purpose, service, target: null,
                teamResource: { teamId: 'team-acme', selection } }] },
        } } } };
        expect(resolveAgentConnectedServicesDefaultBindings(input).bindingsByServiceId[serviceKey]).toEqual(selection);
    });
});
