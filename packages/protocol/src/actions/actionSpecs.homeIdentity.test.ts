import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';
import { bindHomeDomainActionHttpRequestV1, isHomeDomainActionIdV1 } from './homeDomainActionFamily.js';
import { HomeIdentityConnectionV1Schema, HomeIdentityEligibleProviderV1Schema, HomeIdentityConnectionRemovalPreflightV1Schema } from '../home/identity.js';
import { TeamIdentityConnectionV1Schema, TeamIdentityEligibleProviderAvailabilityV1Schema } from '../teams/identity/connection.js';

const homeIdentityIds = [
  'home.identity.connections.list',
  'home.identity.connections.create',
  'home.identity.connections.settings.update',
  'home.identity.connections.enable',
  'home.identity.connections.disable',
  'home.identity.connections.remove.preview',
  'home.identity.connections.remove',
  'home.identity.connections.test.start',
  'home.identity.connections.test.consume',
  'home.identity.workos.connection.create',
  'home.identity.workos.adminPortalLink.create',
  'home.identity.workos.reconcile',
  'home.identity.workos.connection.set',
] as const;

describe('Home identity Action contracts', () => {
  it('keeps scoped projection authority and provider setup actions exact', () => {
    const connection = {
      v: 1, id: 'connection', teamId: null,
      provider: { id: 'provider', kind: 'workos_sso', displayName: 'Company' },
      externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
      settings: { v: 1, kind: 'workos_sso' }, enabled: false, firstEnabledAt: null,
      revision: 1, state: 'not_configured', allowedActions: ['home.identity.connections.remove'],
      lastObservation: null, lastSuccessfulTest: null, createdAt: 0, updatedAt: 0,
    };
    expect(HomeIdentityConnectionV1Schema.safeParse(connection).success).toBe(true);
    expect(TeamIdentityConnectionV1Schema.safeParse(connection).success).toBe(false);
    expect(HomeIdentityConnectionV1Schema.safeParse({ ...connection, teamId: 'team' }).success).toBe(false);
    expect(HomeIdentityConnectionV1Schema.safeParse({ ...connection, allowedActions: ['teams.identity.connections.remove'] }).success).toBe(false);
    expect(HomeIdentityConnectionV1Schema.safeParse({ ...connection, provider: { ...connection.provider, secret: 'secret' } }).success).toBe(false);
    const availability = { status: 'available', setupChoice: { kind: 'create_managed', actionId: 'home.identity.workos.connection.create' } };
    expect(HomeIdentityEligibleProviderV1Schema.safeParse({ v: 1, providerId: null, providerKind: 'workos_sso', owner: 'home', displayName: 'Company', availability }).success).toBe(true);
    expect(TeamIdentityEligibleProviderAvailabilityV1Schema.safeParse(availability).success).toBe(false);
    expect(HomeIdentityConnectionRemovalPreflightV1Schema.safeParse({
      v: 1, canRemove: false, connection,
      impact: { linkedAccounts: 0, accountsRequiringAlternateLogin: 0, directorySources: 0, externalGroupBindings: 0, managedMemberships: 0 },
      blockers: ['identity_connection_in_use'],
    }).success).toBe(true);
  });
  it('publishes strict Home-scoped operations without admitting caller-selected Team authority', () => {
    for (const id of homeIdentityIds) {
      const parsed = ActionIdSchema.safeParse(id);
      expect(parsed.success, id).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      expect(spec.serverTransport?.method).toBe('POST');
      expect(spec.serverTransport?.path).toMatch(/^\/v1\/home\/identity\//);
      expect(spec.executionPlacement).toBe('account');
      expect(spec.approval).toEqual({ result: 'required' });
      expect(getActionRequiredServerFeatureId(id)).toBeNull();
      const input = id.endsWith('connections.list') ? { v: 1 }
        : id.endsWith('connections.create') ? { v: 1, providerInstanceId: 'provider', externalReference: { v: 1, kind: 'oidc' }, settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] } }
        : id.endsWith('settings.update') ? { v: 1, connectionId: 'connection', expectedRevision: 1, settings: { v: 1, kind: 'workos_sso' } }
        : id.endsWith('workos.connection.create') ? { v: 1, displayName: 'Company SSO' }
        : id.endsWith('test.start') ? { v: 1, connectionId: 'connection', expectedRevision: 1 }
        : id.endsWith('test.consume') ? { v: 1, connectionId: 'connection', resultHandle: 'result' }
        : id.endsWith('adminPortalLink.create') ? { v: 1, connectionId: 'connection', intent: 'sso' }
        : id.endsWith('workos.connection.set') ? { v: 1, connectionId: 'connection', expectedRevision: 1, workosConnectionId: 'conn_exact' }
        : { v: 1, connectionId: 'connection', expectedRevision: 1 };
      expect(spec.inputSchema.safeParse(input).success, id).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, teamId: 'other-team' }).success, id).toBe(false);
      expect(isHomeDomainActionIdV1(parsed.data), id).toBe(true);
      if (isHomeDomainActionIdV1(parsed.data)) {
        expect(bindHomeDomainActionHttpRequestV1(parsed.data, input)).toMatchObject({
          method: 'POST', path: spec.serverTransport?.path,
        });
      }
    }
  });

  it('preserves the shared identity authority floor for Home owner mutations', () => {
    const automation = new Set([
      'home.identity.connections.list', 'home.identity.connections.remove.preview',
      'home.identity.connections.test.start', 'home.identity.connections.test.consume',
      'home.identity.workos.adminPortalLink.create',
    ]);
    for (const id of homeIdentityIds) {
      const parsed = ActionIdSchema.safeParse(id);
      expect(parsed.success, id).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      expect(spec.requiredAuthority, id).toBe(automation.has(id) ? 'account_automation' : 'present_user');
      const team = getActionSpec(id.replace('home.', 'teams.') as Parameters<typeof getActionSpec>[0]);
      expect(spec.surfaces).toEqual(team.surfaces);
    }
  });

  it('keeps one-time Test and Portal credentials out of Action observations', () => {
    for (const id of ['home.identity.connections.test.start', 'home.identity.workos.adminPortalLink.create']) {
      const parsed = ActionIdSchema.safeParse(id);
      expect(parsed.success, id).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      if (id.endsWith('adminPortalLink.create')) expect(spec.approvalResultCustody).toBe('live_only');
      expect(spec.projectObservationOutput?.({ url: 'https://example.test/secret', attemptId: 'secret' })).toEqual({ redacted: true });
    }
  });
});
