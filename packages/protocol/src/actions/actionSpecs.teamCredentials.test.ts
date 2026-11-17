import { describe, expect, it, vi } from 'vitest';

import {
  TEAM_CREDENTIAL_ACTION_IDS_V1,
  TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_METHODS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_PATHS_V1,
} from '../teams/credentials/actionsV1.js';
import { TEAM_CREDENTIAL_HOST_ACTION_IDS_V1 } from '../teams/credentials/actionIdsV1.js';
import { TEAM_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { bindHomeDomainActionHttpRequestV1 } from './homeDomainActionFamily.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { serializeActionSpec } from './actionCatalog.js';
import { isActionDiscoverableOnToolSurface } from './actionToolExposure.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('Team credential Action contracts', () => {
  it('discovers credential metadata reads on MCP without asking', () => {
    for (const id of ['teams.credentials.list', 'teams.credentials.get'] as const) {
      const spec = getActionSpec(id);
      expect.soft(isActionDiscoverableOnToolSurface(spec, 'mcp'), id).toBe(true);
      expect.soft(serializeActionSpec(spec).surfaces.mcp, id).toBe(true);
      expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation' });
      expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { surface: 'mcp', authority: 'account_automation' } }).required, id).toBe(false);
    }
  });
  it('makes credential edits discoverable through the real MCP catalog without bypassing approval or authority', () => {
    for (const id of ['teams.credentials.update', 'teams.credentials.audience.set', 'teams.credentials.test',
      'teams.credentials.limits.upsert', 'teams.credentials.externalKeys.create', 'teams.credentials.externalKeys.authorize'] as const) {
      const spec = getActionSpec(id);
      expect(isActionDiscoverableOnToolSurface(spec, 'mcp'), id).toBe(true);
      expect(serializeActionSpec(spec).surfaces.mcp, id).toBe(true);
      expect(spec.approval.result, id).toBe('required');
      expect(spec.requiredAuthority, id).toBe(id === 'teams.credentials.test' ? 'present_user' : 'account_automation');
      expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { surface: 'mcp', authority: 'account_automation' } }).required, id).toBe(true);
    }
    const createKey = getActionSpec('teams.credentials.externalKeys.create');
    expect(createKey.approvalResultCustody).toBe('live_only');
  });
  const externalKeyActionIds = [
    'teams.credentials.externalKeys.create',
    'teams.credentials.externalKeys.authorize',
    'teams.credentials.externalKeys.list',
    'teams.credentials.externalKeys.revoke',
    'teams.credentials.externalKeys.revokeAll',
  ] as const;

  it('registers the real external-key lifecycle through the canonical Home transport', () => {
    for (const id of externalKeyActionIds) {
      const spec = getActionSpec(id);
      expect(spec.serverTransport).toEqual({
        method: 'POST',
        path: TEAM_CREDENTIAL_ACTION_PATHS_V1[id],
      });
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true,
        mcp: id !== 'teams.credentials.externalKeys.list' });
    }
  });
  it('registers each live resource operation through the canonical Home transport', () => {
    for (const id of TEAM_CREDENTIAL_HOME_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(id)).toBe(id);
      const spec = getActionSpec(id);
      expect(spec.serverTransport).toEqual({
        method: TEAM_CREDENTIAL_ACTION_METHODS_V1[id],
        path: TEAM_CREDENTIAL_ACTION_PATHS_V1[id],
      });
      expect(spec.inputSchema).toBe(TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[id]);
      expect(spec.outputSchema).toBe(TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1[id]);
      expect(spec.requiredAuthority).toBe(id === 'teams.credentials.test' ? 'present_user' : 'account_automation');
      expect(spec.executionPlacement).toBe('account');
      expect(spec.surfaces).toMatchObject({
        ui: true,
        cli: true,
        agent: true,
        api: id !== 'teams.credentials.test',
        plugin: true,
      });
      expect(spec.title).toEqual(expect.any(String));
      expect(spec.description).toEqual(expect.any(String));
    }
  });

  it('keeps direct-material lifecycle operations out of the user Action catalog', () => {
    const actionIds = listActionSpecs().map((spec) => spec.id);
    for (const id of [
      'teams.credentials.directMaterial.preparation.list',
      'teams.credentials.directMaterial.refresh',
    ]) {
      expect(TEAM_CREDENTIAL_ACTION_IDS_V1).not.toContain(id);
      expect(actionIds).not.toContain(id);
    }
  });

  it('registers the produced detail and recipient-catalog reads', () => {
    expect(TEAM_CREDENTIAL_ACTION_IDS_V1).toEqual(expect.arrayContaining([
      'teams.credentials.get',
      'teams.credentials.entitled.list',
      'teams.credentials.sourceResources.list',
    ]));
  });

  it('keeps source-authorized mutation results value-free beyond identity and revision', () => {
    for (const id of ['teams.credentials.update', 'teams.credentials.audience.set'] as const) {
      const schema = TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1[id];
      expect(schema.parse({ resourceId: 'resource-1', revision: 4 })).toEqual({
        resourceId: 'resource-1', revision: 4,
      });
      expect(schema.safeParse({
        resourceId: 'resource-1', revision: 4, teamId: 'team-private',
      }).success).toBe(false);
    }
  });

  it('projects every credential intent exactly once through the Team family and Action catalog', () => {
    for (const id of TEAM_CREDENTIAL_ACTION_IDS_V1) {
      expect(TEAM_ACTION_IDS_V1.filter((candidate) => candidate === id)).toHaveLength(1);
      expect(listActionSpecs().filter((spec) => spec.id === id)).toHaveLength(1);
      expect(getActionSpec(id).executionPlacement).toBe(
        TEAM_CREDENTIAL_HOST_ACTION_IDS_V1.includes(id as typeof TEAM_CREDENTIAL_HOST_ACTION_IDS_V1[number])
          ? 'client' : 'account',
      );
    }
  });

  it('keeps sealed credential labels out of the usage-export Action contract', () => {
    const spec = getActionSpec('teams.credentials.usage.export');
    expect(spec.executionPlacement).toBe('client');
    const paths = spec.inputHints?.fields.map(field => field.path) ?? [];
    expect(paths).toEqual(expect.arrayContaining(['query', 'breakdownRowCount']));
    expect(paths).not.toContain('resourceName');
    expect(spec.inputSchema.safeParse({
      query: { resourceId: 'resource-1', startMs: 0, endMs: 1, granularity: 'day', costMode: 'auto' },
      resourceName: 'never disclose this',
    }).success).toBe(false);
  });

  it('binds the existing route body without introducing a second transport table', () => {
    expect(bindHomeDomainActionHttpRequestV1('teams.credentials.list', { teamId: 'team/one' })).toEqual({
      method: 'POST',
      path: '/v1/teams/credential-resources/list',
      body: { teamId: 'team/one', filter: 'all', limit: 50 },
    });
    expect(bindHomeDomainActionHttpRequestV1('teams.credentials.list', { scope: 'custodian', filter: 'direct' })).toEqual({
      method: 'POST', path: '/v1/teams/credential-resources/list',
      body: { scope: 'custodian', filter: 'direct', limit: 50 },
    });
    expect(bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team/one', resourceId: 'selected' })).toEqual({
      method: 'POST', path: '/v1/teams/credential-resources/entitled/list',
      body: { teamId: 'team/one', resourceId: 'selected', limit: 50 },
    });
    expect(TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1['teams.credentials.list'].safeParse({
      scope: 'custodian', filter: 'direct', custodianAccountId: 'someone-else',
    }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1('teams.credentials.delete', {
      resourceId: 'resource-1',
      expectedRevision: 2,
    })).toEqual({
      method: 'POST',
      path: '/v1/teams/credential-resources/delete',
      body: { resourceId: 'resource-1', expectedRevision: 2 },
    });
  });

  it('dispatches through the existing Home family dependency', async () => {
    const homeDomainAction = vi.fn(async () => ({
      resources: [],
      viewer: { manageCredentials: true, offerOwnCredential: true },
    }));
    const executor = createActionExecutor({
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.credentials.list', { teamId: 'team-1' }, {
      surface: 'ui',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: true,
      result: {
        resources: [],
        nextCursor: null,
        viewer: { manageCredentials: true, offerOwnCredential: true },
      },
    });
    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'teams.credentials.list',
      input: { teamId: 'team-1', filter: 'all', limit: 50 },
    }));
  });

  it('registers the effectful connection test as a human-approved agent request', () => {
    expect(ActionIdSchema.parse('teams.credentials.test')).toBe('teams.credentials.test');
    const spec = getActionSpec('teams.credentials.test');
    expect(spec.serverTransport).toEqual({
      method: 'POST',
      path: '/v1/teams/credential-resources/test',
    });
    expect(spec.safety).toBe('danger');
    expect(spec.sideEffectClass).toBe('external');
    expect(spec.requiredAuthority).toBe('present_user');
    expect(spec.executionPlacement).toBe('account');
    expect(spec.surfaces).toMatchObject({
      ui: true,
      cli: true,
      agent: true,
      mcp: true,
      api: false,
      plugin: true,
    });
    expect(spec.inputSchema.parse({ teamId: 'team-1', resourceId: 'resource-1' })).toEqual({
      teamId: 'team-1',
      resourceId: 'resource-1',
    });
    expect(spec.outputSchema.parse({
      result: 'needs_attention',
      readiness: { kind: 'broker_unavailable' },
      recovery: 'Reconnect the broker Machine and try again.',
    })).toEqual({
      result: 'needs_attention',
      readiness: { kind: 'broker_unavailable' },
      recovery: 'Reconnect the broker Machine and try again.',
    });
  });

  it('exposes preparation as a strict aggregate readiness read without material or recipient identity', () => {
    const spec = listActionSpecs().find(row => String(row.id) === 'teams.credentials.preparation.get');
    expect(spec).toBeDefined();
    if (!spec) throw new Error('Missing preparation Action');
    expect(spec).toMatchObject({ requiredAuthority: 'account_automation', sideEffectClass: 'read',
      surfaces: { agent: true, mcp: true, ui: true, cli: true } });
    expect(spec.inputSchema.parse({ teamId: 'team/one', resourceId: 'resource-1' })).toEqual({
      teamId: 'team/one', resourceId: 'resource-1', view: 'readiness',
    });
    const output = { status: 'not_ready', reason: 'preparation_pending', counts: { pending: 1 } };
    expect(spec.outputSchema.parse(output)).toEqual(output);
    expect(spec.outputSchema.safeParse({ ...output, counts: { ...output.counts, ready: 2 } }).success).toBe(false);
    for (const field of ['recipients', 'encryptedDataKey', 'storedContent', 'ciphertext']) {
      expect(spec.outputSchema.safeParse({ ...output, [field]: 'private-material' }).success).toBe(false);
    }
    expect(spec.outputSchema.safeParse({ ...output, status: 'ready' }).success).toBe(false);
  });

  it('keeps non-refreshable credential results blocking while ordinary mutations may defer', () => {
    expect(getActionSpec('teams.credentials.test').approval).toEqual({
      result: 'required',
    });
    expect(getActionSpec('teams.credentials.externalKeys.create').approval).toEqual({
      result: 'required',
    });
    expect(getActionSpec('teams.credentials.externalKeys.revoke').approval).toEqual({
      result: 'required',
      flow: 'deferred',
    });
  });

  it('keeps one-time external API key material in live caller custody only', () => {
    const spec = getActionSpec('teams.credentials.externalKeys.create');
    const key = {
      keyId: '123e4567-e89b-42d3-a456-426614174000',
      resourceId: 'resource-1',
      teamMembershipId: 'membership-1',
      label: { content: { t: 'plain', v: 'CI runner' }, recipientEnvelope: null },
      displayPrefix: 'hapek_v1_123e4567',
      createdAt: '2026-09-14T10:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      authenticationStatus: 'satisfied',
      canAuthorize: false,
    };
    const result = {
      token: `hapek_v1_${key.keyId}_${'a'.repeat(43)}`,
      key,
    };

    expect(spec.outputSchema?.safeParse(result).success).toBe(true);
    expect(spec.approvalResultCustody).toBe('live_only');
    expect(serializeActionSpec(spec)).not.toHaveProperty('approvalResultCustody');
    expect(spec.projectObservationOutput?.(result)).toEqual({ key });
    expect(JSON.stringify(spec.projectObservationOutput?.(result))).not.toContain(result.token);
    expect(spec.projectObservationOutput?.({ token: 'malformed' })).toEqual({ redacted: true });
  });
});
