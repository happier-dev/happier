import { describe, expect, it } from 'vitest';

import { TEAM_IDENTITY_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import {
  TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1,
  TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_IDENTITY_ACTION_PATHS_V1,
} from './specs/teamsIdentity.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';

describe('Team identity Action contracts', () => {
  it('publishes every Team identity intent through its exact POST transport and domain schemas', () => {
    for (const id of TEAM_IDENTITY_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(id)).toBe(id);
      const spec = getActionSpec(id);
      expect(spec.serverTransport).toEqual({ method: 'POST', path: TEAM_IDENTITY_ACTION_PATHS_V1[id] });
      expect(spec.inputSchema).toBe(TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1[id]);
      expect(spec.outputSchema).toBe(TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1[id]);
      expect(spec.approval).toMatchObject({ result: 'required' });
    }
  });

  it('distinguishes Team automation execution from human-decided mutation requests', () => {
    const automation = new Set([
      'teams.identity.connections.list',
      'teams.identity.connections.remove.preview',
      'teams.identity.connections.test.start',
      'teams.identity.connections.test.consume',
      'teams.identity.workos.adminPortalLink.create',
    ]);
    for (const id of TEAM_IDENTITY_ACTION_IDS_V1) {
      const spec = getActionSpec(id);
      expect(spec.requiredAuthority).toBe(automation.has(id) ? 'account_automation' : 'present_user');
      expect(spec.surfaces.agent).toBe(true);
      expect(spec.surfaces.api).toBe(automation.has(id));
    }
  });

  it('classifies Team test and Admin Portal automation as dangerous without deferring their one-time results', () => {
    for (const id of [
      'teams.identity.connections.test.start',
      'teams.identity.connections.test.consume',
      'teams.identity.workos.adminPortalLink.create',
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.safety, id).toBe('danger');
      expect(spec.sideEffectClass, id).toBe('danger');
      expect(spec.approval, id).toEqual({ result: 'required' });
    }
  });

  it('redacts one-time browser credentials from Team Action observations', () => {
    const testStart = getActionSpec('teams.identity.connections.test.start');
    const startProjection = testStart.projectObservationOutput?.({
      authorizeUrl: 'https://home.example/authorize?secret=one-time',
      attemptId: 'attempt-secret',
    });
    expect(startProjection).toEqual({ redacted: true });
    expect(JSON.stringify(startProjection)).not.toContain('one-time');
    expect(JSON.stringify(startProjection)).not.toContain('attempt-secret');

    const testConsume = getActionSpec('teams.identity.connections.test.consume');
    const consumeProjection = testConsume.projectObservationInput?.({
      v: 1,
      teamId: 'team-1',
      connectionId: 'connection-1',
      resultHandle: 'result-secret',
    });
    expect(consumeProjection).toEqual({
      v: 1,
      teamId: 'team-1',
      connectionId: 'connection-1',
    });
    expect(JSON.stringify(consumeProjection)).not.toContain('result-secret');

    const portal = getActionSpec('teams.identity.workos.adminPortalLink.create');
    const portalProjection = portal.projectObservationOutput?.({
      url: 'https://workos.example/portal?token=portal-secret',
    });
    expect(portalProjection).toEqual({ redacted: true });
    expect(JSON.stringify(portalProjection)).not.toContain('portal-secret');
  });

  it('requires human authority to execute identity removal while publishing the approved directory removal SDK action', () => {
    const preview = getActionSpec('teams.identity.connections.remove.preview');
    expect(preview.safety).toBe('safe');
    expect(preview.requiredAuthority).toBe('account_automation');
    expect(preview.surfaces.agent).toBe(true);
    expect(preview.approval).toMatchObject({ result: 'required' });

    const remove = getActionSpec('teams.identity.connections.remove');
    expect(remove.safety).toBe('danger');
    expect(remove.requiredAuthority).toBe('present_user');
    expect(remove.surfaces).toMatchObject({ agent: true, mcp: true, api: false });
    expect(remove.surfaces.cli).toBe(true);
    expect(remove.approval).toMatchObject({ result: 'required' });

    const directoryPreview = getActionSpec('teams.directory.sources.remove.preview');
    expect(directoryPreview.safety).toBe('safe');
    expect(directoryPreview.requiredAuthority).toBe('account_automation');
    expect(directoryPreview.surfaces.agent).toBe(true);

    const directoryRemove = getActionSpec('teams.directory.sources.remove');
    expect(directoryRemove.safety).toBe('danger');
    expect(directoryRemove.requiredAuthority).toBe('account_automation');
    expect(directoryRemove.surfaces.agent).toBe(false);
    expect(directoryRemove.surfaces.api).toBe(true);
    expect(directoryRemove.surfaces.plugin).toBe(true);
    expect(directoryRemove.approval).toEqual({ result: 'required', flow: 'deferred' });
  });
});
