import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceBindingsV2IngressSchema,
  ConnectedServiceBindingsV2Schema,
  TeamResourceBrokeredConnectedServiceSelectionV2Schema,
  resolveConnectedServiceBindingsForChild,
} from './connectedServiceBindings.js';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from './sessionConnectedServiceAuthSwitch.js';

const serviceKey = 'plugin.acme/service';

describe('ConnectedServiceBindingsV2', () => {
  it('retains explicit applied-account evidence while child inheritance keeps only the Pool selection', () => {
    const binding = { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'fallback', appliedProfileId: 'observed' };
    const input = { v: 2, bindingsByServiceId: { [serviceKey]: binding } };
    expect(ConnectedServiceBindingsV2Schema.parse(input)).toEqual(input);
    expect(resolveConnectedServiceBindingsForChild({ explicitSelection: undefined, resolvedTargetKey: 'agent',
      originTargetKey: 'agent', originBindings: ConnectedServiceBindingsV2Schema.parse(input) }))
      .toEqual({ v: 2, bindingsByServiceId: { [serviceKey]: { source: 'connected', selection: 'group', groupId: 'pool' } } });
    expect(ConnectedServiceBindingsV2Schema.safeParse({ ...input, bindingsByServiceId: {
      [serviceKey]: { ...binding, appliedProfileId: 42 },
    } }).success).toBe(false);
  });

  it('keeps brokered selections strict JSON without an undefined disclosed member', () => {
    const selection = { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' };
    expect(TeamResourceBrokeredConnectedServiceSelectionV2Schema.parse(selection)).toEqual(selection);
    expect(TeamResourceBrokeredConnectedServiceSelectionV2Schema.safeParse({
      ...selection, disclosedMember: undefined,
    }).success).toBe(false);
  });

  it('inherits only an omitted same-Agent choice and reuses Pool identity without its active member', () => {
    const originBindings = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
      [serviceKey]: { source: 'connected', selection: 'group', groupId: 'origin-pool', profileId: 'active-member' },
    } });
    const input = { explicitSelection: undefined, resolvedTargetKey: 'agent:plugin.acme/reviewer',
      originTargetKey: 'agent:plugin.acme/reviewer', originBindings };
    const before = structuredClone(originBindings);
    expect(resolveConnectedServiceBindingsForChild(input)).toEqual({ v: 2, bindingsByServiceId: {
      [serviceKey]: { source: 'connected', selection: 'group', groupId: 'origin-pool' },
    } });
    expect(resolveConnectedServiceBindingsForChild({ ...input, resolvedTargetKey: 'agent:plugin.acme/other' })).toBeUndefined();
    expect(resolveConnectedServiceBindingsForChild({ ...input, resolvedTargetKey: undefined, originTargetKey: undefined })).toBeUndefined();
    expect(resolveConnectedServiceBindingsForChild({ ...input, originBindings: undefined })).toBeUndefined();
    expect(resolveConnectedServiceBindingsForChild({ ...input, originBindings: null })).toBeNull();
    const native = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: { [serviceKey]: { source: 'native' } } });
    const empty = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {} });
    for (const explicitSelection of [null, native, empty, originBindings]) {
      expect(resolveConnectedServiceBindingsForChild({ ...input, explicitSelection })).toBe(explicitSelection);
    }
    expect(originBindings).toEqual(before);
  });

  it('admits one strict team-resource selection with an exact disclosed member', () => {
    expect(ConnectedServiceBindingsV2Schema.parse({
      v: 2,
      bindingsByServiceId: {
        [serviceKey]: {
          source: 'team_resource',
          resourceId: 'resource-1',
          deliveryMode: 'direct',
          disclosedMember: {
            service: { pluginId: 'plugin.acme', localId: 'service' },
            accountId: 'TheAccount1',
          },
        },
      },
    })).toEqual(expect.objectContaining({ v: 2 }));
  });

  it('keeps v1 readable while current v2 writes reject unknown authority fields', () => {
    expect(ConnectedServiceBindingsV2IngressSchema.parse({
      v: 1,
      bindingsByServiceId: { [serviceKey]: { source: 'native' } },
    })).toEqual({
      v: 2,
      bindingsByServiceId: { [serviceKey]: { source: 'native' } },
    });
    // The control is an otherwise-valid brokered Team selection: it must parse,
    // so the rejection below is attributable to the unknown field alone and not
    // to a missing required member such as `deliveryMode`.
    const brokeredTeamSelection = {
      source: 'team_resource',
      resourceId: 'resource-1',
      deliveryMode: 'brokered',
    };
    expect(ConnectedServiceBindingsV2Schema.parse({
      v: 2,
      bindingsByServiceId: { [serviceKey]: brokeredTeamSelection },
    })).toEqual({
      v: 2,
      bindingsByServiceId: { [serviceKey]: brokeredTeamSelection },
    });
    expect(ConnectedServiceBindingsV2Schema.safeParse({
      v: 2,
      bindingsByServiceId: { [serviceKey]: { ...brokeredTeamSelection, extra: true } },
    }).success).toBe(false);
  });

  it('normalizes released scalar-key v1 persistence directly into the canonical v2 shape', () => {
    expect(ConnectedServiceBindingsV2IngressSchema.parse({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          profileId: 'released-profile',
        },
      },
    })).toEqual({
      v: 2,
      bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'released-profile',
        },
      },
    });
  });

  it('preserves the exact team-resource authority through switch RPC admission', () => {
    const bindings = {
      v: 2 as const,
      bindingsByServiceId: {
        [serviceKey]: {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'brokered' as const,
        },
      },
    };
    const teamCredentialBindings = [{
      v: 1 as const,
      slot: {
        kind: 'connected_service_purpose' as const,
        purpose: {
          consumer: { pluginId: 'plugin.acme', localId: 'agent' },
          purpose: 'search',
        },
      },
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered' as const,
    }];
    const parsed = SessionConnectedServiceAuthSwitchRpcParamsSchema.parse({
      sessionId: 'session-1',
      agentId: 'external-agent',
      bindings,
      teamCredentialBindings,
      teamVisibilityGrantConsent: { teamId: 'team-1' },
    });
    expect(parsed.bindings).toEqual(bindings);
    expect(parsed.teamCredentialBindings).toEqual(teamCredentialBindings);
  });
});
