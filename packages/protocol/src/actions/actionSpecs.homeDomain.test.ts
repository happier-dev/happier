import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  HOME_DOMAIN_ACTION_IDS_V1,
  HomeDomainActionIdV1Schema,
  homeDomainActionInputSchemaV1,
  homeDomainActionOutputSchemaV1,
  homeDomainActionTransportV1,
  readHomeDomainActionErrorV1,
  type HomeDomainActionErrorCodeV1,
} from './homeDomainActionFamily.js';
import { serializeActionSpec } from './actionCatalog.js';
import { getActionSpec, listActionSpecs, PublicActionIdSchema } from './actionSpecs.js';
import { PluginInvocableActionIdSchema } from './pluginActionSurface.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('Home runtime Action parity', () => {
  it('admits local runtime, access and Personal Home intents through the answering client', () => {
    const reads = ['relay.access.status', 'relay.runtime.status', 'relay.runtime.personal_home.inspect',
      'relay.runtime.personal_home.verify_backup', 'home.runtime.get'];
    const writes = ['relay.access.configure', 'relay.access.disable', 'relay.runtime.install_or_update',
      'relay.runtime.start', 'relay.runtime.stop', 'relay.runtime.restart', 'relay.runtime.uninstall',
      'relay.runtime.personal_home.backup', 'relay.runtime.personal_home.restore',
      'relay.runtime.personal_home.recover_restore', 'relay.runtime.personal_home.erase',
      'relay.runtime.personal_home.claim', 'relay.runtime.personal_home.relocate'];
    const specs = listActionSpecs();
    for (const id of [...reads, ...writes]) {
      const spec = specs.find(row => String(row.id) === id);
      expect(spec, id).toBeDefined();
      expect(spec?.executionPlacement, id).toBe('client');
      expect(spec?.surfaces.agent, id).toBe(true);
      expect(spec?.surfaces.mcp, id).toBe(true);
      expect(spec?.surfaces.cli, id).toBe(true);
      expect(spec?.safety, id).toBe(writes.includes(id) ? 'danger' : 'safe');
    }
  });

  it('keeps destructive consent and rejects credentials or other runtime targets in local input', () => {
    const spec = listActionSpecs().find(row => String(row.id) === 'relay.runtime.personal_home.erase');
    expect(spec).toBeDefined();
    if (!spec) return;
    const input = { purpose: { kind: 'personal-home', canonicalServerUrl: 'http://localhost:3010' } };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, target: { kind: 'ssh', password: 'secret' } }).success).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    expect(spec.outputSchema.safeParse({ status: 'task_started', taskId: 'erase-task' }).success).toBe(true);
  });

  it('makes search repair a present-user Home mutation and connected restart a Machine operation', () => {
    const specs = listActionSpecs();
    const rebuild = specs.find(row => String(row.id) === 'home.search.rebuild');
    const restart = specs.find(row => String(row.id) === 'home.runtime.restart');
    expect(rebuild).toBeDefined();
    expect(rebuild?.requiredAuthority).toBe('present_user');
    expect(rebuild?.serverTransport).toEqual({ method: 'POST', path: '/v1/home/search/rebuild' });
    expect(restart?.executionPlacement).toBe('machine');
    expect(restart?.inputSchema.safeParse({ machineId: 'machine-a', channel: 'stable', mode: 'user' }).success).toBe(true);
    expect(restart?.outputSchema.safeParse({ status: 'completed', taskId: 'restart-task', result: {
      protocolVersion: 1, taskId: 'restart-task', ok: false, error: { code: 'restart_failed', message: 'Failed' },
    } }).success).toBe(true);
  });
});

/**
 * The Home family is one consumed Action dependency over one exact Home. These
 * tests hold the contract that makes that possible: every declared intent has a
 * real domain schema pair and a declared transport. Lane 01's governance and
 * Team intents retain the Account authority floor the Home transaction rechecks.
 */
/**
 * The complete Lane 01 catalog. Enumerating it here rather than deriving it from
 * the family keeps the test honest: a family that quietly dropped an approved
 * intent would otherwise pass by enumerating only what it happens to contain.
 * Team identity rows contributed by other owners are intentionally absent — this
 * list is Lane 01's obligation, not the family's full membership.
 */
const LANE_01_ACTION_IDS = [
  'home.governance.get',
  'home.governance.eligibility.get',
  'home.accounts.list',
  'home.accounts.search',
  'home.accounts.role.set',
  'home.accounts.disable',
  'home.accounts.enable',
  'home.accounts.delete',
  'home.policy.set',
  'teams.list',
  'teams.get',
  'teams.create',
  'teams.update',
  'teams.logo.set',
  'teams.logo.remove',
  'teams.policy.set',
  'teams.archive',
  'teams.restore',
  'teams.members.list',
  'teams.members.get',
  'teams.members.groups.list',
  'teams.members.add',
  'teams.members.role.set',
  'teams.members.suspend',
  'teams.members.reactivate',
  'teams.members.remove',
  'teams.members.leave',
  'teams.members.management.set',
  'teams.groups.list',
  'teams.groups.get',
  'teams.groups.create',
  'teams.groups.update',
  'teams.groups.archive',
  'teams.groups.restore',
  'teams.groups.members.list',
  'teams.groups.members.add',
  'teams.groups.members.remove',
  'teams.invitations.list',
  'teams.invitations.create',
  'teams.invitations.revoke',
  'teams.invitations.reissue',
  'teams.invitations.preview',
  'teams.invitations.accept',
] as const;

const LANE_01_SAFE_INPUT_HINT_PATHS = {
  'home.governance.get': [],
  'home.governance.eligibility.get': [],
  'home.accounts.list': [],
  'home.accounts.search': ['query', 'scope.kind', 'scope.teamId'],
  'home.accounts.role.set': ['accountId', 'homeRole'],
  'home.accounts.disable': ['accountId'],
  'home.accounts.enable': ['accountId'],
  'home.accounts.delete': ['accountId'],
  'home.policy.set': [
    'expectedRevision',
    'teamCreationPolicy',
    'teamsVisibleToMembers',
    'authenticationPolicy.enabledMethodIds',
    'authenticationPolicy.permittedAccountModes',
    'authenticationPolicy.recommendedProvisioningMode',
    'authenticationPolicy.admission',
    'authenticationPolicy.signInService.mode',
    'teamProviderPolicy.allowedTeamProviderKinds',
    'teamProviderPolicy.teamJitAllowed',
    'teamProviderPolicy.approvedGitHubEnterpriseOrigins',
    'identityNetworkPolicy.mode',
    'identityNetworkPolicy.hostnames',
    'identityNetworkPolicy.cidrs',
    'identityNetworkPolicy.ports',
    'authenticationPolicy.anonymousSignup',
    'authenticationPolicy.storagePolicy',
    'confirmWidening',
  ],
  'teams.list': ['scope', 'archived'],
  'teams.get': ['teamId'],
  'teams.create': ['name', 'description', 'initialOwnerAccountId'],
  'teams.update': ['teamId', 'name', 'description'],
  'teams.logo.set': ['teamId', 'image.mimeType'],
  'teams.logo.remove': ['teamId'],
  'teams.policy.set': [
    'teamId',
    'sessionCreationPolicy',
    'externalSharingPolicy',
    'defaultSessionHistoryAccess',
    'admissionMode',
    'authenticationPolicy.mode',
  ],
  'teams.archive': ['teamId'],
  'teams.restore': ['teamId'],
  'teams.members.list': ['teamId', 'filter'],
  'teams.members.get': ['teamId', 'membershipId'],
  'teams.members.groups.list': ['teamId', 'membershipId'],
  'teams.members.add': ['teamId', 'accountId', 'role', 'historyAccess'],
  'teams.members.role.set': ['teamId', 'membershipId', 'role'],
  'teams.members.suspend': ['teamId', 'membershipId'],
  'teams.members.reactivate': ['teamId', 'membershipId'],
  'teams.members.remove': ['teamId', 'membershipId'],
  'teams.members.leave': ['teamId'],
  'teams.members.management.set': [
    'teamId',
    'membershipId',
    'management.kind',
    'management.directorySourceId',
  ],
  'teams.groups.list': ['teamId', 'archived'],
  'teams.groups.get': ['teamId', 'groupId'],
  'teams.groups.create': ['teamId', 'name', 'description'],
  'teams.groups.update': ['teamId', 'groupId', 'name', 'description'],
  'teams.groups.archive': ['teamId', 'groupId'],
  'teams.groups.restore': ['teamId', 'groupId'],
  'teams.groups.members.list': ['teamId', 'groupId'],
  'teams.groups.members.add': ['teamId', 'groupId', 'accountId', 'historyAccess'],
  'teams.groups.members.remove': ['teamId', 'groupId', 'accountId'],
  'teams.invitations.list': ['teamId', 'state'],
  'teams.invitations.create': ['teamId', 'recipientEmail', 'role', 'historyAccess'],
  'teams.invitations.revoke': ['teamId', 'invitationId'],
  'teams.invitations.reissue': ['teamId', 'invitationId', 'recipientEmail'],
  'teams.invitations.preview': [],
  'teams.invitations.accept': [
    'homeServerId',
    'continuation.teamId',
    'teamName',
    'role',
    'historyAccess',
    'state',
    'expiresAt',
    'recipientEmailMask',
  ],
} as const satisfies Readonly<Record<typeof LANE_01_ACTION_IDS[number], readonly string[]>>;

type ParsedHomeDomainActionErrorCodeV1 = NonNullable<
  ReturnType<typeof readHomeDomainActionErrorV1>
>['code'];

describe('Home and Teams Action family', () => {
  it('carries every approved Lane 01 governance and Team intent', () => {
    const registered = new Set(listActionSpecs().map((spec) => spec.id));
    const missing = LANE_01_ACTION_IDS.filter((actionId) => !registered.has(actionId));
    expect(missing).toEqual([]);
    expect(LANE_01_ACTION_IDS.length).toBe(43);
  });

  it('declares useful observation-safe input fields for every Lane 01 intent', () => {
    for (const actionId of LANE_01_ACTION_IDS) {
      expect(
        getActionSpec(actionId).inputHints?.fields.map((field) => field.path),
        actionId,
      ).toEqual(LANE_01_SAFE_INPUT_HINT_PATHS[actionId]);
    }

    const serializedHints = JSON.stringify(
      LANE_01_ACTION_IDS.map((actionId) => getActionSpec(actionId).inputHints),
    );
    expect(serializedHints).not.toContain('token');
    expect(serializedHints).not.toContain('continuation.reference');
    expect(serializedHints).not.toContain('joinUrl');
    expect(serializedHints).not.toContain('dataBase64');
    expect(serializedHints).not.toContain('requestKey');
  });

  it('registers every declared family row in the shared Action catalog', () => {
    const registered = new Set(listActionSpecs().map((spec) => spec.id));
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      expect(registered.has(actionId)).toBe(true);
    }
  });

  it('keeps invitation approval preparation host-internal while retaining public token acceptance', () => {
    const preparation = getActionSpec('teams.invitations.accept.prepareApproval');
    expect(preparation.serverTransport).toEqual({
      method: 'POST',
      path: '/v1/team-invitations/accept/prepare-approval',
    });
    expect(preparation.surfaces).toEqual({
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      api: false,
      plugin: false,
    });
    expect(PublicActionIdSchema.safeParse('teams.invitations.accept.prepareApproval').success).toBe(false);
    expect(PluginInvocableActionIdSchema.safeParse('teams.invitations.accept.prepareApproval').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('teams.invitations.accept').success).toBe(true);
    expect(PluginInvocableActionIdSchema.safeParse('teams.invitations.accept').success).toBe(true);
  });

  it('includes managed GitHub administration in the one exact-Home family', () => {
    expect(HOME_DOMAIN_ACTION_IDS_V1).toContain('identity.githubApps.list');
    expect(HOME_DOMAIN_ACTION_IDS_V1).toContain('identity.githubApps.create');
  });

  /**
   * The row is the single declaration of its transport, so the host lookup must
   * be derived from it rather than from a second table that could drift.
   */
  it('derives every host transport lookup from the row that declared it', () => {
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      const declared = getActionSpec(actionId).serverTransport;
      expect(declared?.path, actionId).toMatch(/^\/v[12]\//);
      expect(homeDomainActionTransportV1(actionId), actionId).toEqual(declared);
    }
  });

  /**
   * Lane 01's intent-shaped routes identify their operation by method and path.
   * Other families may share an addressed command route that carries the intent
   * in the request, so route uniqueness is not a transport-family invariant.
   */
  it('gives each Lane 01 intent its own V1 method and path', () => {
    const addresses = LANE_01_ACTION_IDS.map((actionId) => {
      const transport = homeDomainActionTransportV1(actionId);
      expect(transport.path.startsWith('/v1/'), actionId).toBe(true);
      return `${transport.method} ${transport.path}`;
    });
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('shares method and path only for the existing Session organization snapshot and upserts', () => {
    const byAddress = new Map<string, string[]>();
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      const transport = homeDomainActionTransportV1(actionId);
      const address = `${transport.method} ${transport.path}`;
      const ids = byAddress.get(address) ?? [];
      ids.push(actionId);
      byAddress.set(address, ids);
    }
    expect(Object.fromEntries([...byAddress].filter(([, ids]) => ids.length > 1))).toEqual({
      'GET /v2/session-organization': ['session.folders.list', 'session.tags.list'],
      'POST /v2/session-organization/folders': ['session.folders.create', 'session.folders.rename'],
      'POST /v2/session-organization/tags': ['session.tags.create', 'session.tags.rename'],
    });
  });

  it('carries every Lane 01 governance and Team intent over POST', () => {
    for (const actionId of LANE_01_ACTION_IDS) {
      expect(getActionSpec(actionId).serverTransport?.method).toBe('POST');
    }
  });

  it('keeps the declared transport out of the serialized cross-version wire shape', () => {
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      expect(
        serializeActionSpec(getActionSpec(actionId)),
        `serialized Action spec for ${actionId}`,
      ).not.toHaveProperty('serverTransport');
    }
  });

  /**
   * Strictness is asserted through observable parse behavior, not through codec
   * object identity: what matters is that a client Home identity, a wrong role,
   * or a fabricated result cannot travel, whichever schema object carries it.
   */
  it('refuses a client Home identity on a Home-local governance input', () => {
    expect(homeDomainActionInputSchemaV1('home.accounts.role.set').safeParse({
      accountId: 'account-1',
      homeRole: 'admin',
      serverId: 'home-a',
    }).success).toBe(false);

    expect(homeDomainActionInputSchemaV1('teams.archive').safeParse({
      v: 1,
      teamId: 'team-1',
      serverId: 'home-a',
    }).success).toBe(false);
  });

  it('leaves only the acting membership with the same approval and surfaces as removal', () => {
    const leave = getActionSpec('teams.members.leave');
    const remove = getActionSpec('teams.members.remove');
    expect(leave.surfaces).toEqual(remove.surfaces);
    expect(leave.approval).toEqual(remove.approval);
    expect(leave.requiredAuthority).toBe(remove.requiredAuthority);
    expect(leave.sideEffectClass).toBe(remove.sideEffectClass);
    expect(homeDomainActionTransportV1('teams.members.leave')).toEqual({ method: 'POST', path: '/v1/teams/members/leave' });
    const input = homeDomainActionInputSchemaV1('teams.members.leave');
    expect(input.safeParse({ v: 1, teamId: 'team' }).success).toBe(true);
    expect(input.safeParse({ v: 1, teamId: 'team', membershipId: 'other' }).success).toBe(false);
    expect(homeDomainActionOutputSchemaV1('teams.members.leave').safeParse({ status: 'removed', membershipId: 'self' }).success).toBe(true);
  });

  it('refuses a role the Home does not define and accepts one it does', () => {
    const roleSet = homeDomainActionInputSchemaV1('home.accounts.role.set');
    expect(roleSet.safeParse({ accountId: 'account-1', homeRole: 'admin' }).success).toBe(true);
    expect(roleSet.safeParse({ accountId: 'account-1', homeRole: 'superuser' }).success).toBe(false);
  });

  it('refuses a Team result carrying a field the Home never publishes', () => {
    const removal = homeDomainActionOutputSchemaV1('teams.members.remove');
    expect(removal.safeParse({ status: 'unchanged' }).success).toBe(true);
    expect(removal.safeParse({ status: 'unchanged', sessionAccessStartsAt: 12 }).success).toBe(false);
  });

  it('publishes a usable strict codec pair for every family row', () => {
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      // A row that reached the registry without real codecs would surface here
      // as an accessor throw rather than as an unvalidated call at runtime.
      expect(homeDomainActionInputSchemaV1(actionId).safeParse(undefined).success).toBe(false);
      expect(homeDomainActionOutputSchemaV1(actionId).safeParse(undefined).success).toBe(false);
    }
  });

  it('preserves existing Home-family domain codes without inventing a new vocabulary', () => {
    expect(readHomeDomainActionErrorV1({ error: 'home_governance_forbidden' }))
      .toEqual({ code: 'home_governance_forbidden', details: { error: 'home_governance_forbidden' } });
    expect(readHomeDomainActionErrorV1({ error: 'team_forbidden' }))
      .toEqual({ code: 'team_forbidden', details: { error: 'team_forbidden' } });
    expect(readHomeDomainActionErrorV1({ error: 'identity_connection_conflict' }))
      .toEqual({ code: 'identity_connection_conflict', details: { error: 'identity_connection_conflict' } });
    expect(readHomeDomainActionErrorV1({ error: 'directory_source_permission_lost' }))
      .toEqual({ code: 'directory_source_permission_lost', details: { error: 'directory_source_permission_lost' } });
    expect(readHomeDomainActionErrorV1({ error: 'identity_provider_disabled' }))
      .toEqual({ code: 'identity_provider_disabled', details: { error: 'identity_provider_disabled' } });
    expect(readHomeDomainActionErrorV1({
      v: 1,
      code: 'provider_endpoint_unavailable',
      retryable: true,
      action: 'retry',
    })).toEqual({
      code: 'provider_endpoint_unavailable',
      details: {
        v: 1,
        code: 'provider_endpoint_unavailable',
        retryable: true,
        action: 'retry',
      },
    });
    expect(readHomeDomainActionErrorV1({ error: 'not-a-domain-code' })).toBeNull();
  });

  it('retains representative contributed-family codes in the parser return type', () => {
    expectTypeOf<ParsedHomeDomainActionErrorCodeV1>()
      .toEqualTypeOf<HomeDomainActionErrorCodeV1>();
    expectTypeOf<Extract<ParsedHomeDomainActionErrorCodeV1, 'identity_connection_conflict'>>()
      .toEqualTypeOf<'identity_connection_conflict'>();
    expectTypeOf<Extract<ParsedHomeDomainActionErrorCodeV1, 'directory_source_permission_lost'>>()
      .toEqualTypeOf<'directory_source_permission_lost'>();
    expectTypeOf<Extract<ParsedHomeDomainActionErrorCodeV1, 'directory_unavailable'>>()
      .toEqualTypeOf<'directory_unavailable'>();
    expectTypeOf<Extract<ParsedHomeDomainActionErrorCodeV1, 'recipient_key_unavailable'>>()
      .toEqualTypeOf<'recipient_key_unavailable'>();
  });

  it('classifies governance and Team access changes as dangerous automation', () => {
    for (const actionId of [
      'home.accounts.role.set',
      'home.accounts.disable',
      'home.accounts.enable',
      'home.accounts.delete',
      'home.policy.set',
      'teams.policy.set',
      'teams.archive',
      'teams.restore',
      'teams.invitations.create',
      'teams.invitations.accept',
    ] as const) {
      expect(getActionSpec(actionId).safety).toBe('danger');
    }
  });

  /**
   * Placement and authority belong to each domain owner. Lane 01's governance
   * and Team transactions are Account-placed; the shared transport family also
   * carries intents answered by Session or client owners.
   */
  it('retains Session placement for exact Session mutations and Account placement for Home resources', () => {
    const sessionMutations = new Set(['session.delete', 'session.folder.set', 'session.tags.set']);
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      expect(getActionSpec(actionId).executionPlacement, actionId)
        .toBe(sessionMutations.has(actionId) ? 'session' : 'account');
    }
  });

  it('admits Lane 01 governance and Team intents as Account automation', () => {
    for (const actionId of LANE_01_ACTION_IDS) {
      expect(getActionSpec(actionId).requiredAuthority).toBe(
        actionId === 'teams.invitations.create' || actionId === 'teams.invitations.reissue'
          ? 'present_user' : 'account_automation',
      );
    }
  });

  it('keeps Lane 01 Account-automation rows off the MCP tool surface', () => {
    for (const actionId of LANE_01_ACTION_IDS) {
      expect(getActionSpec(actionId).surfaces.mcp).toBe(
        actionId === 'teams.invitations.create' || actionId === 'teams.invitations.reissue',
      );
    }
  });

  /**
   * Every public family row is reachable from the two human hosts. The one
   * host-internal invitation preparation row is asserted separately above.
   * Agent exposure is asserted over Lane 01's public rows only: a contributed
   * row may deliberately withhold it, and forcing agent exposure family-wide
   * would overrule that owner's narrower admission.
   */
  it('reaches UI, CLI and trusted plugins, with invitation minting requestable under human approval', () => {
    for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
      if (actionId === 'teams.invitations.accept.prepareApproval') continue;
      const surfaces = getActionSpec(actionId).surfaces;
      expect({ ui: surfaces.ui, cli: surfaces.cli, plugin: surfaces.plugin }).toEqual({
        ui: true,
        cli: true,
        plugin: true,
      });
    }
    for (const actionId of LANE_01_ACTION_IDS) {
      const surfaces = getActionSpec(actionId).surfaces;
      const humanMint = actionId === 'teams.invitations.create' || actionId === 'teams.invitations.reissue';
      expect(surfaces.api, actionId).toBe(!humanMint);
      expect(PublicActionIdSchema.safeParse(actionId).success, actionId).toBe(!humanMint);
      expect(PluginInvocableActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
      expect(surfaces.agent, actionId).toBe(true);
    }
  });

  it('keeps invitation bearer URLs out of Action observations without changing caller result schemas', () => {
    const create = getActionSpec('teams.invitations.create');
    const invitation = {
      id: 'invitation-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const createResult = {
      invitation,
      joinUrl: 'https://home.example/join/create-bearer',
    };
    expect(create.outputSchema?.safeParse(createResult).success).toBe(true);
    expect(create.approvalResultCustody).toBe('live_only');
    expect(serializeActionSpec(create)).not.toHaveProperty('approvalResultCustody');
    expect(create.projectObservationOutput?.(createResult)).toEqual({
      invitation,
      joinUrl: null,
    });

    const reissue = getActionSpec('teams.invitations.reissue');
    const reissueResult = {
      previous: { ...invitation, state: 'revoked' as const },
      replacement: { ...invitation, id: 'invitation-2' },
      joinUrl: 'https://home.example/join/reissue-bearer',
    };
    expect(reissue.outputSchema?.safeParse(reissueResult).success).toBe(true);
    expect(reissue.approvalResultCustody).toBe('live_only');
    expect(serializeActionSpec(reissue)).not.toHaveProperty('approvalResultCustody');
    expect(reissue.projectObservationOutput?.(reissueResult)).toEqual({
      previous: reissueResult.previous,
      replacement: reissueResult.replacement,
      joinUrl: null,
    });
    expect(JSON.stringify(create.projectObservationOutput?.(createResult))).not.toContain('create-bearer');
    expect(JSON.stringify(reissue.projectObservationOutput?.(reissueResult))).not.toContain('reissue-bearer');
  });

  it('keeps invitation bearers and continuation references out of input observations', () => {
    const token = 'a'.repeat(43);
    expect(getActionSpec('teams.invitations.preview').projectObservationInput?.({ v: 1, token }))
      .toEqual({ v: 1 });
    expect(getActionSpec('teams.invitations.accept').projectObservationInput?.({ v: 1, token }))
      .toEqual({ v: 1 });

    const continuationReference = 'opaque-continuation-reference';
    const observedContinuation = getActionSpec('teams.invitations.accept').projectObservationInput?.({
      v: 1,
      continuation: {
        v: 1,
        kind: 'post_auth_invitation',
        reference: continuationReference,
        teamId: 'team-acme',
      },
    });
    expect(observedContinuation).toEqual({
      v: 1,
      continuation: { v: 1, kind: 'post_auth_invitation', teamId: 'team-acme' },
    });
    expect(JSON.stringify(observedContinuation)).not.toContain(continuationReference);
  });

  /**
   * `approval.result` says whether the caller must consume this Action's result,
   * not whether a human must approve it. Pin Lane 01's own rows here while
   * contributed family rows retain their domain-owned approval flow.
   */
  it('defers replay-safe Team updates without stranding immediate Action results', () => {
    const immediateTeamResults = new Set([
      'teams.invitations.create',
      'teams.invitations.reissue',
    ]);
    for (const actionId of LANE_01_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.approval, actionId).toEqual(
        ((actionId.startsWith('teams.') && spec.safety === 'danger')
          || actionId === 'teams.update')
          && !immediateTeamResults.has(actionId)
          ? { result: 'required', flow: 'deferred' }
          : { result: 'required' },
      );
    }

    // These write-class Actions return one-time continuations to their caller.
    // Side-effect classification alone must never move them to deferred replay.
    expect(getActionSpec('teams.identity.connections.test.start').approval).toEqual({
      result: 'required',
    });
    expect(getActionSpec('teams.identity.connections.test.consume').approval).toEqual({
      result: 'required',
    });
    expect(getActionSpec('teams.identity.workos.adminPortalLink.create').approval).toEqual({
      result: 'required',
    });
  });

  it('accepts only its own ids', () => {
    expect(HomeDomainActionIdV1Schema.safeParse('home.accounts.role.set').success).toBe(true);
    expect(HomeDomainActionIdV1Schema.safeParse('session.access.grant.set').success).toBe(false);
  });
});
