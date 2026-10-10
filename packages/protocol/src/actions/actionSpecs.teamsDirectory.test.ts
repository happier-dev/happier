import { describe, expect, it } from 'vitest';

import {
  TEAM_DIRECTORY_ACTION_IDS_V1,
  TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1,
  TEAM_DIRECTORY_ACTION_METHODS_V1,
  TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_DIRECTORY_ACTION_PATHS_V1,
} from '../teams/directory/v1.js';
import {
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1,
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1,
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1,
} from '../teams/externalGroupBindings/v1.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, PUBLIC_ACTION_IDS, SIGNED_ROOT_ACTION_IDS } from './actionSpecs.js';
import { bindHomeDomainActionHttpRequestV1 } from './homeDomainActionFamily.js';

describe('Team directory Action contracts', () => {
  it('registers each operation through its exact REST transport and domain codecs', () => {
    for (const id of TEAM_DIRECTORY_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(id)).toBe(id);
      const spec = getActionSpec(id);
      expect(spec.serverTransport).toEqual({
        method: TEAM_DIRECTORY_ACTION_METHODS_V1[id],
        path: TEAM_DIRECTORY_ACTION_PATHS_V1[id],
      });
      expect(spec.inputSchema).toBe(TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1[id]);
      expect(spec.outputSchema).toBe(TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1[id]);
      const isRead = spec.sideEffectClass === 'read';
      const isRemoval = id === 'teams.directory.sources.remove' || id === 'teams.directory.sources.remove.preview';
      expect(spec.requiredAuthority).toBe(isRead && !isRemoval ? 'account_automation' : 'present_user');
      expect(spec.surfaces).toMatchObject({
        ui: true,
        cli: true,
        agent: true,
        mcp: !isRead || isRemoval,
        api: isRead && !isRemoval,
      });
    }
  });

  it('classifies access-changing directory controls as dangerous', () => {
    const danger = new Set([
      'teams.directory.sources.create',
      'teams.directory.sources.sync',
      'teams.directory.sources.pause',
      'teams.directory.sources.resume',
      'teams.directory.sources.remove',
    ]);
    for (const id of TEAM_DIRECTORY_ACTION_IDS_V1) {
      expect(getActionSpec(id).safety).toBe(danger.has(id) ? 'danger' : 'safe');
    }
  });

  it('makes removal preview and mutation requestable under the same present-user Action contract', () => {
    expect(PUBLIC_ACTION_IDS).not.toContain('teams.directory.sources.remove');
    expect(SIGNED_ROOT_ACTION_IDS).not.toContain('teams.directory.sources.remove');
    expect(PUBLIC_ACTION_IDS).not.toContain('teams.directory.sources.remove.preview');
    expect(getActionSpec('teams.directory.sources.remove.preview').surfaces)
      .toMatchObject({ ui: true, cli: true, agent: true, mcp: true, api: false, plugin: true });
    expect(getActionSpec('teams.directory.sources.remove').bindings?.sdkMethod)
      .toBe('teams.directory.sources.remove.execute');
    expect(getActionSpec('teams.directory.sources.remove')).toMatchObject({
      requiredAuthority: 'present_user',
      safety: 'danger',
      sideEffectClass: 'danger',
      approval: { result: 'required', flow: 'deferred' },
      surfaces: {
        ui: true,
        cli: true,
        agent: true,
        mcp: true,
        api: false,
        plugin: true,
      },
    });
  });

  it('binds Action inputs to the REST path, query, and body once', () => {
    expect(bindHomeDomainActionHttpRequestV1('teams.directory.groups.list', {
      v: 1,
      teamId: 'team/a',
      sourceId: 'source b',
      limit: 25,
      query: 'Engineering',
    })).toEqual({
      method: 'GET',
      path: '/v1/teams/team%2Fa/directory-sources/source%20b/groups?limit=25&query=Engineering',
      body: undefined,
    });
    expect(bindHomeDomainActionHttpRequestV1('teams.directory.sources.pause', {
      v: 1,
      teamId: 'team_1',
      sourceId: 'source_1',
    })).toEqual({
      method: 'POST',
      path: '/v1/teams/team_1/directory-sources/source_1/pause',
      body: { v: 1 },
    });
    expect(bindHomeDomainActionHttpRequestV1('teams.externalGroupBindings.list', {
      v: 1,
      teamId: 'team/a',
      ownerKind: 'directory_source',
      directorySourceId: 'source b',
      limit: 25,
    })).toEqual({
      method: 'GET',
      path: '/v1/teams/team%2Fa/external-group-bindings?limit=25&ownerKind=directory_source&directorySourceId=source+b',
      body: undefined,
    });
  });

  it('registers every external Group binding operation through its resource transport', () => {
    for (const id of TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1) {
      expect(getActionSpec(id).serverTransport).toEqual({
        method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1[id],
        path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1[id],
      });
    }
  });
});
