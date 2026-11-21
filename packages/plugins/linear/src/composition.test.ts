import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { TriageListScopeUnitsResultV1Schema, TriageScanResultV1Schema, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { runTriageScanPass } from '../../triage/src/projection/scanPass.js';
import { LINEAR_PLUGIN } from './manifest.js';
import { LINEAR_ACTIONS, LINEAR_CREATE_FIELDS } from './contracts.js';
import { host, instance, issue, page } from './fixtures.test-support.js';

describe('public Linear source composition', () => {
  it('advertises only approval facts supported by the Linear create write', () => {
    const declared = LINEAR_PLUGIN.manifest.contributes.actions?.find(action => action.id === LINEAR_ACTIONS.create);
    const facts = declared?.confirmation?.inputFields ?? [];
    expect(facts.map(fact => fact.path)).toEqual([
      'instance.locator.displayLabel', 'kindId', ...LINEAR_CREATE_FIELDS.map(field => `fields.${field}`),
    ]);
    expect(facts.every(fact => Boolean(fact.title))).toBe(true);
  });
  it('lists searchable, paged teams through the safe registered source role and projects configuration without HTTP', async () => {
    const h = host(({ operationName, variables }) => {
      expect(operationName).toBe('LinearTeams');
      expect(variables.filter).toEqual({ or: [{ name: { containsIgnoreCase: 'ops' } }, { key: { containsIgnoreCase: 'ops' } }] });
      return { teams: variables.after ? page([{ id: 'team-3', name: 'Ops Europe', key: 'OPE' }])
        : page([{ id: 'team-2', name: 'Operations', key: 'OPS' }], true, 'teams-next') };
    });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest, module: LINEAR_PLUGIN, services: h.context.services });
    const draft = { v: 1, binding: instance.binding, localInstanceKey: 'linear', keyStability: 'stable',
      configuration: { v: 1, token: JSON.stringify({ v: 1, involvement: 'mine', teams: { kind: 'selected', unitIds: ['team-2'] },
        teamUnits: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS', collisionScope: 'untrusted-team-scope' }] }) }, locator: { v: 1, displayLabel: 'Linear workspace' } };
    try {
      const contribution = LINEAR_PLUGIN.manifest.contributes.targetedPluginContributions[0]!;
      expect(contribution.operations.listScopeUnits).toBeTypeOf('string');
      const action = contribution.operations.listScopeUnits!;
      const configured = TriageListScopeUnitsResultV1Schema.parse(await kit.invokeAction(action, { v: 1, draft, mode: 'configured' }));
      expect(configured).toEqual({ kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['team-2'] },
        units: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }] });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.materializeListedAccount).not.toHaveBeenCalled();
      const first = TriageListScopeUnitsResultV1Schema.parse(await kit.invokeAction(action, { v: 1, draft, query: 'ops' }));
      expect(first).toMatchObject({ kind: 'page', status: 'partial', units: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }],
        nextCursor: { v: 1, token: expect.any(String) } });
      if (first.kind !== 'page' || first.status !== 'partial') throw new Error('expected a continuation');
      expect(await kit.invokeAction(action, { v: 1, draft, query: 'ops', cursor: first.nextCursor }))
        .toMatchObject({ kind: 'page', status: 'complete', units: [{ id: 'team-3', label: 'Ops Europe' }] });
      expect(await kit.invokeAction(action, { v: 1, draft, query: 'engineering', cursor: first.nextCursor }))
        .toMatchObject({ kind: 'failed', failure: { code: 'linear/continuationChanged' } });
      expect(LINEAR_PLUGIN.manifest.contributes.actions.find((entry) => entry.id === action))
        .toMatchObject({ dangerLevel: 'safe', surfaces: expect.arrayContaining(['agent', 'mcp', 'cli', 'ui']) });
    } finally { await kit.dispose(); }
  });

  it('exposes the canonical create role as the registered outward-write Action', async () => {
    let created = false;
    const h = host(({ operationName }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearTeam') return { team: issue.team };
      if (operationName === 'LinearCreate') { created = true; return { issueCreate: { success: true, issue: { id: issue.id } } }; }
      return { issue: { ...issue, title: created ? 'Composed task' : issue.title } };
    });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest, module: LINEAR_PLUGIN, services: h.context.services });
    try {
      const contribution = LINEAR_PLUGIN.manifest.contributes.targetedPluginContributions[0]!;
      const result = TriageTaskWriteResultV1Schema.parse(await kit.invokeAction(contribution.operations.create!,
        { v: 1, instance, kindId: 'issue', fields: { title: 'Composed task' } }));
      expect(result).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Composed task' } } });
      expect(LINEAR_PLUGIN.manifest.contributes.actions.find((action) => action.id === contribution.operations.create)?.dangerLevel).toBe('writesRemote');
    } finally { await kit.dispose(); }
  });
  it('reaches provider HTTP through the declared role and registered Action, then qualifies the row in the real aggregate', async () => {
    assertTriageSourceContributionV1(LINEAR_PLUGIN.manifest);
    const h = host(({ operationName, variables }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : { issues: page([{ ...issue, id: variables.after ? 'issue-2' : issue.id }], !variables.after, variables.after ? null : 'next') });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest, module: LINEAR_PLUGIN, services: h.context.services });
    try {
      const contribution = LINEAR_PLUGIN.manifest.contributes.targetedPluginContributions[0]!;
      const result = await runTriageScanPass({
        lanes: [{ sourceInstanceId: instance.instance.sourceInstanceId, source: instance.instance.source,
          declaredKindIds: ['issue'], configured: instance,
          scan: async (input, options) => TriageScanResultV1Schema.parse(await kit.invokeAction(contribution.operations.scan!, input, { signal: options?.signal })),
        }], pageLimit: 1, observationBudget: 2, nowMs: () => 1000,
      });
      expect(result.lanes[0]?.health).toEqual({ kind: 'walkFinished' });
      expect(result.lanes[0]?.exhausted).toBe(true);
      expect(result.observations.map((observation) => observation.entryRef.entryId)).toEqual(['issue-1', 'issue-2']);
      expect(h.request).toHaveBeenCalled();
    } finally { await kit.dispose(); }
  });
});
