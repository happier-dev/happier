import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isActionDirectToolExposedOn } from '@happier-dev/protocol/actions/actionToolExposure';

/**
 * The CLI reaches the Home it is already bound to. It never chooses a Home from
 * Action input, so these tests pin the two facts that make that safe: the intent
 * lands on the path its Action row declares, and a refusal the Home names is
 * carried through as a typed failure rather than a thrown transport error the
 * caller would have to guess about.
 */
describe('Home family CLI adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
  });
  afterEach(async () => { restore(); await app.close(); });

  it.each(['secrets.shared.promote', 'secrets.shared.grants.set'] as const)(
    'keeps %s MCP approval bound to its Home and settles without secret disclosure', async actionId => {
      const cipher = Buffer.alloc(40, 7).toString('base64');
      const audience = { accountGrants: ['account-2'], teamGrants: ['team-1'], groupGrants: ['group-1'] };
      const input = actionId === 'secrets.shared.promote'
        ? { resourceId: 'secret-1', displayName: 'CI token', kind: 'token', encryptionMode: 'e2ee',
            storedContent: { t: 'encrypted', c: cipher }, ...audience, expectedSettingsVersion: 7,
            nextSettings: { t: 'encrypted', c: cipher },
            referenceCensus: { accountMode: 'e2ee', profiles: { referenceGuardRevision: 0, rows: [] } },
            profileMutations: [] }
        : { resourceId: 'secret-1', expectedRevision: 2, ...audience };
      const output = actionId === 'secrets.shared.promote'
        ? { resourceId: 'secret-1', settingsVersion: 8 }
        : { resourceId: 'secret-1', revision: 3 };
      let returned: unknown = output;
      const requests: unknown[] = [];
      app.post(getActionSpec(actionId).serverTransport!.path, async request => {
        expect(request.headers.authorization).toBe('Bearer bound');
        requests.push(request.body);
        return returned;
      });
      let stored: ApprovalRequest | null = null;
      const observations: unknown[] = [];
      // HTTP and Artifact persistence are the only substituted system boundaries.
      const { executor } = createCliActionExecutorHarness({ token: 'bound', sessionId: 'cli-global',
        serverId: 'home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
      }, {
        ...createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' }),
        approvalsCreate: async ({ request }) => {
          stored = ApprovalRequestV2Schema.parse(request);
          return { artifactId: 'secret-approval' };
        },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
          if (!stored) return { ok: false, errorCode: 'not_found', error: 'not_found' };
          const transition = decideApprovalRequestTransition(stored, request);
          if (!transition.ok) return transition;
          stored = ApprovalRequestV2Schema.parse(request);
          return { ok: true };
        },
        isApprovalExecutionOriginCurrent: async () => true,
        observeActionExecution: async observation => { observations.push(observation); },
      });
      const context = { surface: 'mcp', authority: 'account_automation', serverId: 'home',
        runtimeAccountId: 'account-1', actionRequestId: 'secret-request', actionCaller: { kind: 'host' } } as const;
      const requested = await executor.execute(actionId, input, context);
      expect(requested.ok ? null : requested.errorCode).toBeNull();
      expect(requested).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', artifactId: 'secret-approval' } });
      expect(isActionDirectToolExposedOn(getActionSpec(actionId), 'mcp')).toBe(true);
      expect(requests).toEqual([]);
      expect(stored).toMatchObject({ status: 'open', actionArgs: input,
        executionOriginV1: { surface: 'mcp', serverId: 'home', accountId: 'account-1' } });
      const pending = ApprovalRequestV2Schema.parse(stored);
      expect(JSON.stringify(pending.preview)).not.toContain(cipher);
      expect(await executor.execute('approval.request.decide', { artifactId: 'secret-approval', decision: 'approve' },
        context)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      const result = await executor.execute('approval.request.decide', { artifactId: 'secret-approval', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account-1', actionCaller: { kind: 'host' } });
      expect(result).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(requests).toEqual([getActionSpec(actionId).inputSchema.parse(input)]);
      expect(JSON.stringify(result)).not.toContain(cipher);
      expect(JSON.stringify(stored)).not.toContain(cipher);
      expect(JSON.stringify(observations)).not.toContain(cipher);
      const decided = ApprovalRequestV2Schema.parse(stored);
      expect(decided.execution).toMatchObject({ ok: true, result: output });
      expect(await executor.execute(actionId, input, { ...context, serverId: 'another-home', bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
      expect(requests).toHaveLength(1);
      returned = { ...output, value: 'unexpected-secret-plaintext' };
      const malformed = await executor.execute(actionId, input, { ...context, bypassApprovals: true });
      expect(malformed).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      expect(JSON.stringify(malformed)).not.toContain('unexpected-secret-plaintext');
      expect(JSON.stringify(observations)).not.toContain('unexpected-secret-plaintext');
    },
  );

  it('rebuilds only the bound Personal Home index through Action admission and retains server refusals', async () => {
    let rebuilt = false;
    app.post('/v1/home/search/rebuild', async () => { rebuilt = true; return { ok: true }; });
    const { executor } = createCliActionExecutorHarness({ token: 'bound', sessionId: '',
      serverId: 'home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
    }, createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' }));
    expect(await executor.execute('home.search.rebuild', {}, { surface: 'cli', authority: 'present_user',
      serverId: 'home', presentUserConfirmation: { actionId: 'home.search.rebuild' },
    })).toEqual({ ok: true, result: { ok: true } });
    expect(rebuilt).toBe(true);
    rebuilt = false;
    expect(await executor.execute('home.search.rebuild', {}, { surface: 'cli', authority: 'account_automation',
      serverId: 'home',
    })).toMatchObject({ ok: false });
    expect(rebuilt).toBe(false);
  });

  const summary = {
    id: 'team-1',
    name: 'Platform',
    description: null,
    logo: null,
    archivedAt: null,
    recovery: null,
    policy: {
      v: 1,
      sessionCreationPolicy: 'private_default',
      externalSharingPolicy: 'allowed',
      defaultSessionHistoryAccess: 'from_membership',
      admissionMode: 'invite_only',
      authenticationPolicy: null,
      authenticationPolicyStatus: 'available',
    },
    viewerRole: 'owner',
    capabilities: NO_TEAM_CAPABILITIES_V1,
    admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
    counts: null,
  };

  it('reads and writes headless declared Home and Team settings through their canonical domain Actions', async () => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    let homeValue = 600;
    let revision = 3;
    const projection = () => ({ revision, startedAt: null, entries: [{ key, value: homeValue,
      fixed: false, source: 'default', editable: 'home', apply: 'restart',
      declaration: { type: 'int', section: 'server', bounds: { min: 0 } } }] });
    app.post('/v1/home/settings/get', async () => projection());
    app.post('/v1/home/settings/set', async request => {
      expect(request.body).toEqual({ expectedRevision: revision, values: { [key]: 700 } });
      homeValue = 700; revision += 1;
      return projection();
    });
    let admissionMode: 'invite_only' | 'jit' = 'invite_only';
    app.post('/v1/teams/get', async () => ({ ...summary, policy: { ...summary.policy, admissionMode } }));
    app.post('/v1/teams/policy/set', async request => {
      expect(request.body).toEqual({ v: 1, teamId: 'team-1', admissionMode: 'jit' });
      admissionMode = 'jit';
      return { ...summary, policy: { ...summary.policy, admissionMode } };
    });
    const credentials = { token: 'bound', encryption: null } as const;
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
      sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
    }, createAccountServerActionDeps({ token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://home.test' }));
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.set': { enabled: true } },
        approvalWaivedSurfaces: { 'home.settings.set': ['cli'], 'teams.policy.set': ['cli'] } }),
      presentUserConfirmation: { actionId: 'settings.set' },
    } as const;
    expect(await executor.execute('settings.get', { anchor, target: { kind: 'home', serverId: 'home' } }, context))
      .toMatchObject({ ok: true, result: { anchor, value: 600 } });
    expect(await executor.execute('settings.set', { anchor, value: 700, target: { kind: 'home', serverId: 'home' } }, context))
      .toMatchObject({ ok: true, result: { anchor, value: 700 } });
    const teamAnchor = 'teams.authentication.admissionJit';
    const target = { kind: 'team', serverId: 'home', teamId: 'team-1' };
    expect(await executor.execute('settings.get', { anchor: teamAnchor, target }, context))
      .toMatchObject({ ok: true, result: { anchor: teamAnchor, value: false } });
    expect(await executor.execute('settings.set', { anchor: teamAnchor, target, value: true }, context))
      .toMatchObject({ ok: true, result: { anchor: teamAnchor, value: true } });
    expect(await executor.execute('settings.get', { anchor: teamAnchor, target }, context))
      .toMatchObject({ ok: true, result: { value: true } });
    expect(await executor.execute('settings.get', { anchor: teamAnchor, target: { ...target, serverId: 'other-home' } }, context))
      .toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
    // Root Settings admission cannot widen a narrow caller grant into domain authority.
    expect(await executor.execute('settings.get', { anchor: teamAnchor, target }, { ...context,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: ['settings.get'] } },
    })).toMatchObject({ ok: false, errorCode: 'token_scope_denied' });
  });

  it('posts a Team intent to the path its Action row declares with the bound Account bearer', async () => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    app.post('/v1/teams/archive', async (request) => {
      seen.push({
        url: request.url,
        body: request.body,
        authorization: request.headers.authorization,
      });
      return summary;
    });

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    const result = await deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli' } as never,
    });

    expect(result).toMatchObject({ id: 'team-1', archivedAt: null });
    expect(seen).toEqual([{
      url: '/v1/teams/archive',
      body: { v: 1, teamId: 'team-1' },
      authorization: 'Bearer bound',
    }]);
  });

  it('uses the real CLI executor and Home transport to exchange a token before persisting deferred approval', async () => {
    const token = 'a'.repeat(43);
    const seen: Array<{ url: string; body: unknown }> = [];
    app.post('/v1/team-invitations/accept/prepare-approval', async (request) => {
      seen.push({ url: request.url, body: request.body });
      return {
        outcome: 'ok',
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'prepared-continuation-reference',
          teamId: 'team-1',
        },
        preview: {
          home: { serverId: 'srv-home', displayName: 'Home', storageMode: 'encrypted' },
          team: { teamId: 'team-1', name: 'Platform', logo: null, accentSeed: 'team-1' },
          role: 'member',
          historyAccess: 'from_membership',
          state: 'active',
          expiresAt: 20,
          recipientEmailMask: null,
        },
      };
    });
    const accountServerActionDeps = createAccountServerActionDeps({
      token: 'bound',
      serverId: 'home',
      serverHttpBaseUrl: 'http://home.test',
    });
    let storedRequest: ApprovalRequest | null = null;
    const { executor } = createCliActionExecutorHarness({
      token: 'bound',
      sessionId: 'cli-global',
      serverId: 'home',
      serverHttpBaseUrl: 'http://home.test',
      mode: 'plain',
      ctx: null,
    }, {
      ...accountServerActionDeps,
      isActionApprovalRequired: (actionId) => actionId === 'teams.invitations.accept',
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'approval-team-invitation' };
      },
    });

    await expect(executor.execute('teams.invitations.accept', { v: 1, token }, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'home',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-team-invitation',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-team-invitation' },
    });
    expect(seen).toEqual([{
      url: '/v1/team-invitations/accept/prepare-approval',
      body: { v: 1, token },
    }]);
    expect(storedRequest).toMatchObject({
      actionArgs: {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'prepared-continuation-reference',
          teamId: 'team-1',
        },
      },
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: expect.objectContaining({
          homeServerId: 'srv-home',
          continuation: { teamId: 'team-1' },
          teamName: 'Platform',
          role: 'member',
          historyAccess: 'from_membership',
        }),
      },
    });
    expect(JSON.stringify(storedRequest)).not.toContain(token);
  });

  it('carries the Home\'s typed refusal instead of throwing a transport error', async () => {
    app.post('/v1/home/accounts/role/set', async (_request, reply) =>
      reply.code(403).send({ error: 'home_governance_forbidden' }));

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'home.accounts.role.set',
      input: { accountId: 'account-2', homeRole: 'admin' },
      context: { surface: 'cli' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'home_governance_forbidden',
      error: 'home_governance_forbidden',
      details: { error: 'home_governance_forbidden' },
    });
  });

  it('preserves a named Team refusal before classifying a 404 as unsupported', async () => {
    app.post('/v1/teams/archive', async (_request, reply) =>
      reply.code(404).send({ error: 'team_not_found' }));

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'team_not_found',
      error: 'team_not_found',
      details: { error: 'team_not_found' },
    });
  });

  it('binds directory reads to exact path parameters and query fields', async () => {
    const seen: string[] = [];
    app.get('/v1/teams/:teamId/directory-sources/:sourceId/groups', async (request) => {
      seen.push(request.url);
      return { items: [], nextCursor: null };
    });

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.directory.groups.list',
      input: { v: 1, teamId: 'team/a', sourceId: 'source b', limit: 25, query: 'R&D' },
      context: { surface: 'cli' } as never,
    })).resolves.toEqual({ items: [], nextCursor: null });
    expect(seen).toEqual(['/v1/teams/team%2Fa/directory-sources/source%20b/groups?limit=25&query=R%26D']);
  });

  it('binds directory removal impact to its exact GET preflight path with the bound Account bearer', async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    app.get('/v1/teams/:teamId/directory-sources/:sourceId/removal-impact', async (request) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      return {
        v: 1,
        status: 'allowed',
        sourceId: 'source-1',
        sourceLabel: 'Corporate directory',
        impact: {
          teamMembershipsRemoved: 0,
          groupMembershipsRemoved: 0,
          groupContributionsRemoved: 0,
          directoryCreatedGroupsRetained: 0,
          nativeMembershipsPreserved: 0,
          nativeGroupContributionsPreserved: 0,
        },
      };
    });

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.directory.sources.remove.preview',
      input: { v: 1, teamId: 'team-1', sourceId: 'source-1' },
      context: { surface: 'cli' } as never,
    })).resolves.toMatchObject({ status: 'allowed', sourceId: 'source-1' });
    expect(seen).toEqual([{
      url: '/v1/teams/team-1/directory-sources/source-1/removal-impact',
      authorization: 'Bearer bound',
    }]);

    await expect(deps.homeDomainAction!({
      actionId: 'teams.directory.sources.remove.preview',
      input: { v: 1, teamId: 'team-1', sourceId: 'source-1', token: 'secret' },
      context: { surface: 'cli' } as never,
    })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('reports a Home without the operation as unsupported rather than as a denial', async () => {
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.restore',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:teams.restore',
    });
  });

  it('rejects an input the strict domain schema refuses before reaching the Home', async () => {
    let reached = 0;
    app.post('/v1/teams/archive', async () => { reached++; return summary; });

    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://home.test' });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1', serverId: 'home-a' },
      context: { surface: 'cli' } as never,
    })).rejects.toThrow();
    expect(reached).toBe(0);
  });

  it('refuses a context for another Home before issuing the bound request', async () => {
    let reached = 0;
    app.post('/v1/home/governance/get', async () => { reached++; return {}; });
    const deps = createAccountServerActionDeps({
      token: 'bound',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://home.test',
    });

    await expect(deps.homeDomainAction!({
      actionId: 'home.governance.get',
      input: {},
      context: { surface: 'cli', serverId: 'home-b' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    expect(reached).toBe(0);
  });

  it('signs external Home requests against the observed server identity rather than the local profile id', async () => {
    const installationIdentity = tweetnacl.sign.keyPair();
    const authorization = {
      v: 1 as const,
      token: 'external-authorization',
      binding: {
        serverIdentityId: 'srv-cryptographic-home',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1',
        actionId: 'teams.archive',
        requestId: 'request-1',
        requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine' as const, machineId: 'machine-1' },
      },
    };
    let reached = 0;
    app.post('/v1/teams/archive', async (request) => {
      reached += 1;
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      return summary;
    });
    const deps = createAccountServerActionDeps({
      token: 'daemon-bearer-must-not-cross',
      serverId: 'local-profile-id',
      serverIdentityId: 'srv-cryptographic-home',
      serverHttpBaseUrl: 'http://home.test',
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });

    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: {
        surface: 'api',
        authority: 'account_automation',
        serverId: 'local-profile-id',
        externalActionTarget: authorization.binding.target,
        externalActionExecutionAuthorization: authorization,
      },
    })).resolves.toMatchObject({ id: 'team-1' });
    expect(reached).toBe(1);
  });

  it('distinguishes proven pre-dispatch failure from ambiguous mutation response loss', async () => {
    const deps = createAccountServerActionDeps({
      token: 'bound',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://home.test',
    });

    const reset = Object.assign(new Error('connection reset after dispatch'), { code: 'ECONNRESET' });
    const resetRequest = vi.spyOn(axios, 'request').mockRejectedValue(reset);
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli', serverId: 'home-a' } as never,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.homeDomainAction!({
      actionId: 'home.governance.get',
      input: {},
      context: { surface: 'cli', serverId: 'home-a' } as never,
    })).resolves.toEqual({ ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' });
    resetRequest.mockRestore();

    const refused = Object.assign(new Error('connection refused before dispatch'), { code: 'ECONNREFUSED' });
    const refusedRequest = vi.spyOn(axios, 'request').mockRejectedValue(refused);
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli', serverId: 'home-a' } as never,
    })).resolves.toEqual({ ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' });
    refusedRequest.mockRestore();
  });

  it('distinguishes cancellation before dispatch from cancellation after a mutation was issued', async () => {
    const deps = createAccountServerActionDeps({
      token: 'bound',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://home.test',
    });

    const preDispatch = new AbortController();
    preDispatch.abort();
    const request = vi.spyOn(axios, 'request');
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli', serverId: 'home-a' } as never,
      signal: preDispatch.signal,
    })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(request).not.toHaveBeenCalled();

    const afterDispatch = new AbortController();
    request.mockImplementation(async () => {
      afterDispatch.abort();
      throw new axios.CanceledError('cancelled after dispatch');
    });
    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: { surface: 'cli', serverId: 'home-a' } as never,
      signal: afterDispatch.signal,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    request.mockRestore();
  });
});
