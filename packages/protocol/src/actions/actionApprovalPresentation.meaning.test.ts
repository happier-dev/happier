import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields, type ApprovalActionFieldRow } from './actionApprovalPresentation.js';

function visible(rows: readonly ApprovalActionFieldRow[]) {
  return rows.filter((row) => !(row.kind === 'value' && row.technical));
}

describe('Action arguments read by meaning', () => {
  const createSession = describeApprovalActionFields({
    actionId: 'session.spawn_new',
    actionArgs: {
      creationKey: 'fix-r45-auth-helper-20261021-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/home/happier' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' }, updatedAt: 0 },
      title: 'Authorization check helper',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1792557232467 },
        options: {},
      },
    },
  });

  it('names the Machine, Agent and model it creates the session with, and reads the folder as its path', () => {
    const rows = visible(createSession.rows);
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
    expect(byPath['executionTarget.machineId']).toMatchObject({ reference: { kind: 'machine', id: 'machine-1' } });
    expect(byPath.agentTarget).toMatchObject({ reference: { kind: 'agent', id: 'codex' } });
    expect(byPath.agentTarget).not.toHaveProperty('entries');
    expect(byPath.modelSelection).toMatchObject({
      reference: { kind: 'agentModel', id: 'gpt-6-luna', agentTargetKey: 'agent:happier.agent.codex/codex' },
    });
    expect(byPath.directory).toMatchObject({ value: '/home/happier' });
    expect(byPath.directory).not.toHaveProperty('entries');
  });

  it('moves the creation key and empty or sentinel configuration out of view, keeping what was set', () => {
    const rows = visible(createSession.rows);
    expect(rows.map((row) => row.path)).not.toContain('creationKey');
    expect(createSession.rows.find((row) => row.path === 'creationKey')).toMatchObject({ technical: true });
    const configuration = rows.find((row) => row.path === 'configuration');
    const readable = configuration?.kind === 'value'
      ? configuration.entries?.filter((entry) => entry.value !== null && !entry.technical) : [];
    expect(readable).toEqual([{ label: 'Permission intent', value: 'read-only', depth: 0 }]);
  });

  it('keeps a configuration that sets nothing in Technical details', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'session.spawn_new',
      actionArgs: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        configuration: { mode: { value: null, updatedAtMs: 0 }, options: {} },
      },
    });
    expect(presentation.rows.find((row) => row.path === 'configuration')).toMatchObject({ technical: true });
    expect(presentation.rows.find((row) => row.path === 'directory')).toMatchObject({ value: 'Managed' });
  });
  it('reads connected services as one account line per service, keeping ids and selection mechanics in Technical details', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'session.spawn_new',
      actionArgs: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'beee2181-b6ad-463c-8c96-5922f24555cd' },
          },
        },
      },
    });
    const row = visible(presentation.rows).find((candidate) => candidate.path === 'connectedServices');
    const readable = row?.kind === 'value' ? row.entries?.filter((entry) => entry.value !== null && !entry.technical) : [];
    expect(readable).toEqual([{
      label: 'Connected account', value: 'beee2181-b6ad-463c-8c96-5922f24555cd', depth: 0,
      reference: { kind: 'connectedAccount', id: 'beee2181-b6ad-463c-8c96-5922f24555cd', service: 'happier.agent.claude/claude-subscription' },
    }]);
  });

  it('reads configuration options as flat "Label  Value" lines', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'session.spawn_new',
      actionArgs: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        configuration: { options: { reasoning_effort: { value: 'low', updatedAtMs: 1792557232467 } } },
      },
    });
    const row = visible(presentation.rows).find((candidate) => candidate.path === 'configuration');
    const readable = row?.kind === 'value' ? row.entries?.filter((entry) => entry.value !== null && !entry.technical) : [];
    expect(readable).toEqual([{ label: 'Reasoning effort', value: 'Low', depth: 0 }]);
  });

  it('keeps a deploy\'s retry key, target link and content pins under Technical details', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'deployments.deploy',
      actionArgs: {
        serverId: 'server-1', environmentId: 'env-1', expectedRevision: 3, requestKey: 'deploy-1',
        targetLinkId: 'link-1', expectedTargetLinkRevision: 2, contentArtifactId: 'content-1',
        contentHeaderVersion: 1, contentBodyVersion: 1,
      },
    });
    expect(visible(presentation.rows).map((row) => row.path)).toEqual(['serverId', 'environmentId']);
    expect(presentation.rows.filter((row) => row.kind === 'value' && row.technical).map((row) => row.path))
      .toEqual(expect.arrayContaining(['requestKey', 'targetLinkId', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion']));
  });
});
