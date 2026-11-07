import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateAccount } from './accountRuntime.js';
import { LINEAR_PLUGIN } from './manifest.js';
import { LINEAR_ACTIONS } from './contracts.js';
import { createLinearIssue, editLinearIssue, transitionLinearIssue, commentLinearIssue } from './mutations.js';
import { host, instance, issue, localRef, page } from './fixtures.test-support.js';

describe('Linear native writes', () => {
  it('requires a team for workspace creation and authorizes the selected team before dispatch', async () => {
    const scoped = (teams: unknown) => ({ ...instance, localInstanceKey: 'linear',
      configuration: { v: 1 as const, token: JSON.stringify({ v: 1, teams, involvement: 'mine' }) } });
    let returnedTeam = issue.team;
    const h = host(({ operationName, variables }) => {
      if (operationName === 'LinearTeam') return { team: { id: 'team-1' } };
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearCreate') {
        expect(variables.input).toEqual({ teamId: 'team-1', title: 'Workspace task' });
        return { issueCreate: { success: true, issue: { id: issue.id } } };
      }
      return { issue: { ...issue, team: returnedTeam, title: 'Workspace task' } };
    });
    const all = scoped({ kind: 'all' });
    expect(await createLinearIssue({ v: 1, instance: all, kindId: 'issue', fields: { title: 'Workspace task' } }, h.context))
      .toEqual({ kind: 'refused', reason: 'linear/teamRequired' });
    expect(await createLinearIssue({ v: 1, instance: scoped({ kind: 'selected', unitIds: ['team-2'] }), kindId: 'issue',
      fields: { title: 'Workspace task', scopeId: 'team-1' } }, h.context)).toEqual({ kind: 'refused', reason: 'linear/teamMismatch' });
    expect(h.request).not.toHaveBeenCalled();
    expect(await createLinearIssue({ v: 1, instance: all, kindId: 'issue', fields: { title: 'Workspace task', scopeId: 'team-1' } }, h.context))
      .toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Workspace task' } } });
    returnedTeam = { id: 'team-2', name: 'Operations', key: 'OPS' };
    expect(await createLinearIssue({ v: 1, instance: all, kindId: 'issue', fields: { title: 'Workspace task', scopeId: 'team-1' } }, h.context))
      .toMatchObject({ kind: 'uncertain' });
  });

  it('creates once in the configured team and confirms the returned fields by rereading', async () => {
    let created = false;
    const h = host(({ operationName, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearTeam') return { team: { id: 'team-1' } };
      if (operationName === 'LinearCreate') {
        expect(variables.input).toEqual({ teamId: 'team-1', title: 'New work', description: 'Native description', priority: 1 });
        created = true;
        return { issueCreate: { success: true, issue: { id: 'issue-1' } } };
      }
      return { issue: { ...issue, title: created ? 'New work' : issue.title, description: 'Native description', priority: 1 } };
    });
    expect(await createLinearIssue({ v: 1, instance, kindId: 'issue', initialStatusId: 'native-state',
      fields: { title: 'New work', body: 'Native description', priority: 1 } }, h.context))
      .toEqual({ kind: 'refused', reason: 'linear/unsupportedField' });
    expect(h.request).not.toHaveBeenCalled();
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest,
      module: { activate: LINEAR_PLUGIN.activate, activateAccount }, services: h.context.services });
    try {
      expect(await kit.invokeAction(LINEAR_ACTIONS.create, { v: 1, instance, kindId: 'issue', fields: { title: 'New work', body: 'Native description', priority: 1 } }))
        .toMatchObject({ kind: 'applied', observation: { localRef, snapshot: { title: 'New work' } } });
      expect(h.request.mock.calls.filter(([request]) => new TextDecoder().decode(request.body).includes('mutation LinearCreate'))).toHaveLength(1);
      h.request.mockClear();
      h.materializeListedAccount.mockRejectedValue(new Error('selected account unavailable'));
      expect(await kit.invokeAction(LINEAR_ACTIONS.create, { v: 1, instance, kindId: 'issue', fields: { title: 'Another issue' } }))
        .toMatchObject({ kind: 'failed', failure: { class: 'authentication' } });
      expect(h.request).not.toHaveBeenCalled();
    } finally { await kit.dispose(); }
  });

  it('keeps an Account Linear edit cancelled after dispatch uncertain without replay', async () => {
    const controller = new AbortController();
    const h = host(({ operationName }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearUpdate') { controller.abort(); throw new Error('cancelled after send'); }
      return { issue };
    });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest,
      module: { activate: LINEAR_PLUGIN.activate, activateAccount }, services: h.context.services });
    try {
      const handler = kit.registration('actions', LINEAR_ACTIONS.edit);
      if (!handler) throw new Error('Missing Account edit Action');
      // Observe source settlement before the Action RPC discards an aborted reply.
      expect(await handler({ v: 1, instance, localRef, fields: { title: 'Changed title' } }, { ...h.context, signal: controller.signal }))
        .toMatchObject({ kind: 'uncertain' });
      expect(h.request.mock.calls.filter(([request]) => new TextDecoder().decode(request.body).includes('mutation LinearUpdate'))).toHaveLength(1);
    } finally { await kit.dispose(); }
  });

  it('edits through issueUpdate and refuses to claim applied if Linear ignores a requested field', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : operationName === 'LinearUpdate' ? { issueUpdate: { success: true, issue: { id: issue.id } } }
        : { issue: { ...issue, description: 'Existing description' } });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { title: 'Changed title' } }, h.context))
      .toMatchObject({ kind: 'uncertain', observation: { snapshot: { title: issue.title } } });
  });

  it('does not confirm an empty description from a missing provider field', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : operationName === 'LinearUpdate' ? { issueUpdate: { success: true, issue: { id: issue.id } } } : { issue });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { body: '' } }, h.context)).toMatchObject({ kind: 'uncertain' });
  });

  it('uses provider-native label deltas so a concurrent new label survives the edit', async () => {
    let updated = false;
    const h = host(({ operationName, query, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearUpdate') {
        expect(variables.input).toEqual({ addedLabelIds: ['new-label'], removedLabelIds: ['old-label'] });
        updated = true;
        return { issueUpdate: { success: true, issue: { id: issue.id } } };
      }
      if (query.includes('labels(')) return { issue: { id: issue.id, team: issue.team, labels: page(updated
        ? [{ id: 'new-label', name: 'New' }, { id: 'concurrent-label', name: 'Concurrent' }]
        : [{ id: 'old-label', name: 'Old' }]) } };
      return { issue: { ...issue, description: null } };
    });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { labelIds: ['new-label'] } }, h.context)).toMatchObject({ kind: 'applied' });
  });

  it('authorizes the native team workflow state and confirms the transition', async () => {
    let transitioned = false;
    const h = host(({ operationName, query, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (query.includes('states(')) return { issue: { id: issue.id, team: { ...issue.team, states: page([{ id: 'done-state', name: 'Done', type: 'completed' }]) } } };
      if (operationName === 'LinearUpdate') {
        expect(variables.input).toEqual({ stateId: 'done-state' });
        transitioned = true;
        return { issueUpdate: { success: true, issue: { id: issue.id } } };
      }
      return { issue: { ...issue, description: null, state: transitioned ? { id: 'done-state', name: 'Done', type: 'completed' } : issue.state } };
    });
    expect(await transitionLinearIssue({ v: 1, instance, localRef, transitionId: 'done-state',
      fieldValues: [{ fieldId: 'resolution', value: 'done' }] }, h.context))
      .toEqual({ kind: 'refused', reason: 'linear/unsupportedField' });
    expect(h.request).not.toHaveBeenCalled();
    expect(await transitionLinearIssue({ v: 1, instance, localRef, transitionId: 'done-state', fieldValues: [] }, h.context))
      .toMatchObject({ kind: 'applied', observation: { snapshot: { state: { presentation: 'resolved', completionReason: 'completed' } } } });
  });

  it('does not replay an answer-lost create or comment', async () => {
    let writes = 0;
    const h = host(({ operationName }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearTeam') return { team: { id: 'team-1' } };
      if (operationName === 'LinearCreate' || operationName === 'LinearComment') { writes += 1; throw new Error('answer lost'); }
      return { issue: { ...issue, description: null } };
    });
    expect(await createLinearIssue({ v: 1, instance, kindId: 'issue', fields: { title: 'One issue' } }, h.context)).toMatchObject({ kind: 'uncertain' });
    expect(await commentLinearIssue({ v: 1, instance, localRef, body: 'One comment' }, h.context)).toMatchObject({ kind: 'uncertain' });
    expect(writes).toBe(2);
  });

  it('confirms the exact created comment and never substitutes an unrelated comment', async () => {
    let wrongIssue = false;
    const h = host(({ operationName }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearComment') return { commentCreate: { success: true, comment: { id: 'comment-1' } } };
      if (operationName === 'LinearCommentRead') return { comment: { id: 'comment-1', body: 'Public update', issue: { id: wrongIssue ? 'other-issue' : issue.id } } };
      return { issue };
    });
    const input = { v: 1, instance, localRef, body: 'Public update' };
    expect(await commentLinearIssue(input, h.context)).toMatchObject({ kind: 'applied' });
    wrongIssue = true;
    expect(await commentLinearIssue(input, h.context)).toMatchObject({ kind: 'uncertain' });
  });

  it('settles an answer-lost edit from a fresh read and refuses a state outside the team workflow', async () => {
    let changed = false;
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearUpdate') { changed = true; throw new Error('response lost after apply'); }
      if (query.includes('states(')) return { issue: { id: issue.id, team: { ...issue.team, states: page([{ id: 'allowed-state', name: 'Started', type: 'started' }]) } } };
      return { issue: { ...issue, title: changed ? 'Confirmed edit' : issue.title } };
    });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { title: 'Confirmed edit' } }, h.context)).toMatchObject({ kind: 'applied' });
    expect(await transitionLinearIssue({ v: 1, instance, localRef, transitionId: 'foreign-state' }, h.context)).toEqual({ kind: 'refused', reason: 'linear/transitionUnavailable' });
    expect(h.request.mock.calls.filter(([request]) => new TextDecoder().decode(request.body).includes('mutation LinearUpdate'))).toHaveLength(1);
  });

  it('refuses unsupported assignment cardinality or foreign parents before any write', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issue });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { assigneeIds: ['a', 'b'] } }, h.context)).toMatchObject({ kind: 'refused' });
    expect(await createLinearIssue({ v: 1, instance, kindId: 'issue', fields: { title: 'No cross-source parent', parent: {
      source: { pluginId: 'example.other', localId: 'issues' }, ...localRef,
    } } }, h.context)).toMatchObject({ kind: 'refused' });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { blockedBy: [] } }, h.context)).toMatchObject({ kind: 'refused' });
    expect(await editLinearIssue({ v: 1, instance, localRef, fields: { priority: 'opaque-provider-priority' } }, h.context)).toMatchObject({ kind: 'refused' });
    expect(h.request).not.toHaveBeenCalled();
  });
});
