import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateAccount } from './accountRuntime.js';
import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1, TriageGetResultV1Schema, TriageListInstancesResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { getLinearEntry, listLinearInstances, listLinearScopeUnits, scanLinearSource, readLinearDetail } from './source.js';

import { account, instance, localRef, issue, page, host } from './fixtures.test-support.js';
import { writeLinearScopeSelection } from './contracts.js';
import { LINEAR_ACTIONS } from './contracts.js';
import { LINEAR_ACCOUNT_ACTIONS } from './accountActions.js';
import { LINEAR_PLUGIN } from './manifest.js';

const workspaceInstance = (teams: unknown) => ({ ...instance, localInstanceKey: 'linear',
  configuration: { v: 1 as const, token: JSON.stringify({ v: 1, teams, involvement: 'everyone' }) } });

describe('Linear source through provider HTTP', () => {
  it.each([
    ['updated', 'asc', ['issue-a', 'issue-b', 'issue-y', 'issue-z']],
    ['updated', 'desc', ['issue-z', 'issue-y', 'issue-b', 'issue-a']],
    ['created', 'asc', ['issue-z', 'issue-y', 'issue-b', 'issue-a']],
    ['created', 'desc', ['issue-a', 'issue-b', 'issue-y', 'issue-z']],
  ] as const)('keeps %s %s globally ordered across native cursor pages', async (field, direction, expected) => {
    // IDs and the two time fields have deliberately different orders.
    const rows = [
      { ...issue, id: 'issue-z', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' },
      { ...issue, id: 'issue-a', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      { ...issue, id: 'issue-y', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' },
      { ...issue, id: 'issue-b', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
    ];
    let pages = 0;
    const h = host(({ operationName, query, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(query).toContain('orderBy: ' + (field === 'created' ? 'createdAt' : 'updatedAt'));
      expect(variables).toMatchObject(direction === 'asc' ? { last: 2 } : { first: 2 });
      expect(variables[direction === 'asc' ? 'before' : 'after']).toBe(pages === 0 ? undefined : 'page-2');
      const nativeDescending = field === 'created' ? [rows[1], rows[3], rows[2], rows[0]] : [rows[0], rows[2], rows[3], rows[1]];
      const nodes = direction === 'asc' ? nativeDescending.slice(pages === 0 ? 2 : 0, pages === 0 ? 4 : 2)
        : nativeDescending.slice(pages === 0 ? 0 : 2, pages === 0 ? 2 : 4);
      pages++;
      return { issues: { nodes, pageInfo: direction === 'asc'
        ? { hasPreviousPage: pages === 1, startCursor: pages === 1 ? 'page-2' : null }
        : { hasNextPage: pages === 1, endCursor: pages === 1 ? 'page-2' : null } } };
    });
    const sort = { field, direction };
    const first = await scanLinearSource({ v: 1, instance, sort, page: { kind: 'initial', limit: 2 } }, h.context);
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('Expected Linear continuation');
    const second = await scanLinearSource({ v: 1, instance, sort, page: { kind: 'continuation', continuation: first.continuation } }, h.context);
    expect(second.kind).toBe('complete');
    if (second.kind !== 'complete') throw new Error('Expected completed Linear walk');
    expect([...first.observations, ...second.observations].map((row) => row.localRef.entryId)).toEqual(expected);
    expect(pages).toBe(2);
    expect(await scanLinearSource({ v: 1, instance, sort: { field, direction: direction === 'asc' ? 'desc' : 'asc' },
      page: { kind: 'continuation', continuation: first.continuation } }, h.context)).toMatchObject({ kind: 'failed' });
    expect(pages).toBe(2);
  });

  it.each([
    ['connected_service_credential_reconnect_required', 'authentication'],
    ['plugin_connected_account_settings_unavailable', 'transient'],
  ] as const)('preserves typed host refusal %s and request ID without HTTP', async (code, classification) => {
    const h = host(() => ({}));
    h.materializeListedAccount.mockRejectedValue(Object.assign(new Error('private credential'), {
      code, retryable: false, details: { requestId: 'linear-host-refusal' },
    }));
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({
      kind: 'unresolved', failure: { class: classification, code, detail: 'Happier Request ID: linear-host-refusal' },
    });
    expect(h.request).not.toHaveBeenCalled();
  });

    it('executes the Account scan through registration and HTTP without a Machine', async () => {
        const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issues: page([issue]) });
        const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest,
            module: { activate: LINEAR_PLUGIN.activate, activateAccount }, services: h.context.services });
        try {
            expect(await kit.invokeAction(LINEAR_ACTIONS.scan, { v: 1, instance: instance, page: { kind: 'initial', limit: 3 } }))
                .toMatchObject({ kind: 'complete', observations: [{ kind: 'present', snapshot: { title: issue.title } }] });
            expect(h.request).toHaveBeenCalledTimes(2);
        } finally { await kit.dispose(); }
    });
  it('bounds completed task reads at the provider without replacing the involvement union and keeps it on the next page', async () => {
    const sinceMs = Date.parse('2026-10-19T00:00:00Z');
    const h = host(({ operationName, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(variables.filter).toMatchObject({ and: [
        { or: expect.arrayContaining([{ assignee: { id: { eq: 'viewer-1' } } }]) },
        { or: [{ state: { type: { neq: 'completed' } } }, { completedAt: { gte: new Date(sinceMs).toISOString() } }] },
      ] });
      return { issues: page([{ ...issue, state: { id: 'done', name: 'Done', type: 'completed' }, completedAt: '2026-10-20T09:00:00Z' }], !variables.after, variables.after ? null : 'page-2') };
    });
    const completed = { kindIds: ['issue'], sinceMs };
    const first = await scanLinearSource({ v: 1, instance, completed, page: { kind: 'initial', limit: 20 } }, h.context);
    expect(first).toMatchObject({ kind: 'page', observations: [{ snapshot: { completedAtMs: Date.parse('2026-10-20T09:00:00Z') } }] });
    if (first.kind !== 'page') throw new Error('Expected provider continuation');
    expect(await scanLinearSource({ v: 1, instance, completed, page: { kind: 'continuation', continuation: first.continuation } }, h.context))
      .toMatchObject({ kind: 'complete' });
    expect(await scanLinearSource({ v: 1, instance, completed: { ...completed, sinceMs: sinceMs + 1 },
      page: { kind: 'continuation', continuation: first.continuation } }, h.context)).toMatchObject({ kind: 'failed' });
  });
  it('projects a due date and provider completion time through the scan snapshot', async () => {
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(query).toContain('completedAt');
      expect(query).toContain('dueDate');
      return { issues: page([{ ...issue, state: { id: 'done', name: 'Done', type: 'completed' }, completedAt: '2026-10-20T09:00:00Z' }]) };
    });
    const result = TriageScanResultV1Schema.parse(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context));
    expect(result).toMatchObject({ kind: 'complete', observations: [{ snapshot: {
      dueDate: issue.dueDate, completedAtMs: Date.parse('2026-10-20T09:00:00Z'),
    } }] });
  });
  it('loads complete editable values without putting bodies into scans', async () => {
    const body = 'Full Markdown\n\nPreserve whitespace.  \n';
    const title = '界'.repeat(Math.floor(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 / 3) + 1);
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearIssue') return { issue: { ...issue, title, description: body } };
      if (query.includes('labels(')) return { issue: { ...issue, labels: page([{ id: 'label-1', name: 'Fix' }]) } };
      throw new Error('Optional relation unavailable');
    });
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({ kind: 'present',
      snapshot: { projectionTruncated: true }, taskFields: { title, body, assigneeIds: ['viewer-1'],
        labelIds: ['label-1'], projectId: 'project-1', priority: 2, dueDate: '2026-10-25', estimate: 3, parent: { entryId: 'parent-1' } } });
  });
  it('discovers one workspace through the exact listed account', async () => {
    const h = host(() => ({ viewer: { organization: { id: 'workspace-1', name: 'Engineering workspace' } } }));
    const result = TriageListInstancesResultV1Schema.parse(await listLinearInstances({ v: 1 }, h.context));
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('discovery failed');
    expect(result.candidates.map((candidate) => candidate.localInstanceKey)).toEqual(['linear']);
    expect(result.candidates[0]?.locator.displayLabel).toBe('Engineering workspace');
    expect(h.materializeListedAccount).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'linear-api', account }), expect.anything());
    expect(JSON.stringify(result)).not.toContain('test-personal-key');
  });

  it('pages the involvement union without dropping overlapping assigned/created/subscribed facts', async () => {
    const h = host(({ operationName, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(variables.filter).toEqual({ team: { id: { eq: 'team-1' } }, or: [
        { assignee: { id: { eq: 'viewer-1' } } }, { creator: { id: { eq: 'viewer-1' } } }, { subscribers: { some: { id: { eq: 'viewer-1' } } } },
      ] });
      return { issues: page([{ ...issue, subscribers: page([{ id: 'viewer-1' }]) }], true, 'issues-next') };
    });
    const result = TriageScanResultV1Schema.parse(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context));
    expect(result.kind).toBe('page');
    if (result.kind === 'failed') throw new Error('scan failed');
    expect(result.observations[0]).toMatchObject({ kind: 'present', localRef, snapshot: {
      designation: 'ENG-123', state: { presentation: 'active', nativeLabel: 'In Progress', stage: 'started' },
    }, viewer: { involvement: ['author', 'assignee', 'subscribed'] } });
    if (result.observations[0]?.kind !== 'present') throw new Error('missing present issue');
    expect(result.observations[0].snapshot.facts).toContainEqual({ id: 'assignee', label: 'Assignee', importance: 'secondary', value: { kind: 'text', value: 'Mara' } });
    expect(result.observations[0].snapshot.facts.map((fact) => fact.id)).toEqual([
      'assignee', 'priority', 'project', 'cycle', 'parent', 'due', 'estimate',
    ]);
    expect(result.observations[0].snapshot.projectionTruncated).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain('description');
  });

  it('scans all accessible teams or the exact selected set in one workspace lane', async () => {
    for (const teams of [{ kind: 'all' }, { kind: 'selected', unitIds: ['team-1', 'team-2'] }]) {
      const configured = workspaceInstance(teams);
      const h = host(({ operationName, variables }) => {
        if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
        expect(variables.filter).toEqual(teams.kind === 'all' ? {} : { team: { id: { in: ['team-1', 'team-2'] } } });
        return { issues: page([issue, { ...issue, id: 'issue-2', team: { id: 'team-2', key: 'OPS', name: 'Operations' } }]) };
      });
      expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'complete', observations: [
          { localRef: { collisionScope: 'linear', entryId: 'issue-1' }, snapshot: { scopeUnitId: 'team-1' } },
          { localRef: { collisionScope: 'linear', entryId: 'issue-2' }, snapshot: { scopeUnitId: 'team-2' } },
        ] });
    }
  });

  it('refuses provider rows outside selected teams in scans and exact reads', async () => {
    const configured = workspaceInstance({ kind: 'selected', unitIds: ['team-2'] });
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : operationName === 'LinearIssues' ? { issues: page([issue]) } : { issue });
    expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
      .toMatchObject({ kind: 'failed', failure: { code: 'linear/teamMismatch' } });
    expect(await getLinearEntry({ v: 1, instance: configured, localRef }, h.context))
      .toMatchObject({ kind: 'unresolved', failure: { code: 'linear/entryMismatch' } });
  });

  it('keeps historical team keys usable with old tokens and newly written selections', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issues: page([issue]) });
    for (const configured of [instance, { ...workspaceInstance({ kind: 'selected', unitIds: ['team-1'] }), localInstanceKey: instance.localInstanceKey }]) {
      expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'complete', observations: [{ localRef }] });
    }
    expect(await listLinearScopeUnits({ v: 1, mode: 'configured', draft: {
      v: 1, binding: instance.binding, localInstanceKey: instance.localInstanceKey, configuration: instance.configuration,
    } }, h.context)).toMatchObject({ kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['team-1'] }, units: [{ id: 'team-1' }] });
  });

  it('writes the shared selection through the Linear codec while retaining identity and involvement', async () => {
    const previous = { v: 1 as const, binding: instance.binding, localInstanceKey: instance.localInstanceKey,
      configuration: instance.configuration, keyStability: 'stable' as const, locator: { v: 1 as const, displayLabel: 'Engineering' } };
    const draft = writeLinearScopeSelection(previous, { kind: 'selected', unitIds: ['team-2'] },
      [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS', collisionScope: 'incorrect-team-identity' }]);
    expect(draft.localInstanceKey).toBe(previous.localInstanceKey);
    expect(draft.binding).toEqual(previous.binding);
    expect(JSON.parse(draft.configuration.token)).toEqual({ v: 1, involvement: 'mine', teams: { kind: 'selected', unitIds: ['team-2'] },
      teamUnits: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }] });
    const h = host(() => { throw new Error('Configured projection must not call Linear'); });
    expect(await listLinearScopeUnits({ v: 1, draft, mode: 'configured' }, h.context)).toEqual({ kind: 'page', status: 'complete',
      selection: { kind: 'selected', unitIds: ['team-2'] }, units: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }] });
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('refuses empty, duplicate and unknown selections before provider authorization', async () => {
    const h = host(() => ({}));
    for (const teams of [{ kind: 'selected', unitIds: [] }, { kind: 'selected', unitIds: ['team-1', 'team-1'] }, { kind: 'future' }]) {
      expect(await scanLinearSource({ v: 1, instance: workspaceInstance(teams), page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'failed', failure: { code: 'linear/configurationInvalid' } });
    }
    expect(h.request).not.toHaveBeenCalled();
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('reports GraphQL HTTP-400 RATELIMITED with the provider complexity reset and never retries', async () => {
    const h = host(() => ({}));
    h.request.mockResolvedValue({ status: 400, finalUrl: 'https://api.linear.app/graphql', headers: {
      'X-RateLimit-Requests-Remaining': '2', 'X-RateLimit-Requests-Reset': '1792320000000',
      'X-RateLimit-Complexity-Remaining': '0', 'X-RateLimit-Complexity-Reset': '1792320300000',
    }, body: new TextEncoder().encode(JSON.stringify({ errors: [{ message: 'private provider prose', extensions: { code: 'RATELIMITED' } }] })) });
    const result = await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context);
    expect(result).toEqual({ kind: 'failed', failure: { class: 'rateLimit', code: 'linear/rateLimited', retryNotBeforeMs: 1792320300000 } });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-team reference before credentials or provider access', async () => {
    const h = host(() => ({}));
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef: { ...localRef, collisionScope: 'other-deployment' } }, h.context));
    expect(result.kind).toBe('unresolved');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('keeps credential refusal and cancellation explicit without an anonymous provider request', async () => {
    const h = host(() => ({}));
    h.materializeListedAccount.mockRejectedValue(new Error('private credential failure'));
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({
      kind: 'unresolved', failure: { class: 'authentication', code: 'linear/materializationFailed' },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, { ...h.context, signal: controller.signal }))
      .toMatchObject({ kind: 'failed', failure: { class: 'transient', code: 'linear/cancelled' } });
    expect(h.request).not.toHaveBeenCalled();
  });

  it('keeps GraphQL not-found/permission errors unresolved rather than inventing absence', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issue: null });
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({ kind: 'unresolved', localRef });
  });

  it('retains a readable issue with long Unicode content and an unfamiliar native state', async () => {
    const title = '界'.repeat(Math.floor(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 / 3) + 1);
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : { issue: { ...issue, title, state: { ...issue.state, type: 'future-state' } } });
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef }, h.context));
    expect(result).toMatchObject({ kind: 'present', localRef, snapshot: { state: { presentation: 'unknown' }, projectionTruncated: true } });
  });

  it('reads native relations in their real direction, with an explicit next page', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : {
      issue: { ...issue, inverseRelations: page([{ type: 'blocks', issue: { id: 'blocker-1', identifier: 'OPS-7', title: 'Upstream work' }, relatedIssue: { id: issue.id, identifier: issue.identifier, title: issue.title } }], true, 'relations-next') },
    });
    expect(await readLinearDetail({ v: 1, instance, localRef, section: 'blockedBy' }, h.context)).toMatchObject({
      kind: 'ready', entries: [{ id: 'blocker-1', title: 'OPS-7 · Upstream work' }], continuation: 'relations-next',
    });
  });

  it.each([1, 2])('preserves the native workflow without opting into quick completion (%s completed states)', async (doneStates) => {
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearIssue') return { issue };
      if (query.includes('children(')) return { issue: { ...issue, children: page([{ id: 'child-1', identifier: 'ENG-124', title: 'Child' }]) } };
      if (query.includes('inverseRelations(')) return { issue: { ...issue, inverseRelations: page([{ type: 'blocks', issue: { id: 'blocker-1', identifier: 'OPS-7', title: 'Dependency' }, relatedIssue: issue }]) } };
      return { issue: { ...issue, team: { ...issue.team, states: page([{ id: 'state-1', name: 'In Progress', type: 'started' },
        ...Array.from({ length: doneStates }, (_, index) => ({ id: `done-${index}`, name: 'Done', type: 'completed' }))]) } } };
    });
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef }, h.context));
    expect(result).toMatchObject({ kind: 'present', snapshot: {
      relations: { parent: { entryId: 'parent-1' }, children: { total: 1, complete: true, entries: [{ entryId: 'child-1' }] }, blockedBy: [{ entryId: 'blocker-1' }] },
    } });
    if (result.kind !== 'present') throw new Error('Expected a task');
    expect(result.snapshot.taskCapabilities?.transitions?.[0]).toMatchObject({ id: 'state-1', state: { presentation: 'active', stage: 'started' } });
    expect(result.snapshot.taskCapabilities).not.toHaveProperty('completingTransitionId');
    expect(result.snapshot.taskCapabilities?.transitions?.map(transition => transition.id))
      .toEqual(['state-1', ...Array.from({ length: doneStates }, (_, index) => `done-${index}`)]);
  });
});


describe('task creation places', () => {
  it('exposes named included teams and preserves refusal reasons for excluded teams', async () => {
    const h = host(() => ({ teams: page([
      { id: 'team-1', name: 'Engineering', key: 'ENG' },
      { id: 'team-2', name: 'Support', key: 'SUP' },
    ]) }));
    const action = LINEAR_ACCOUNT_ACTIONS[LINEAR_ACTIONS.listCreationPlaces];
    expect(action).toBeDefined();
    const result = await action.run({ v: 1, instance }, h.context);
    expect(result.kind, JSON.stringify(result)).toBe('page');
    expect(result).toMatchObject({ kind: 'page', status: 'complete', places: [
      { id: 'team-1', label: 'Engineering', kindId: 'issue', fields: { scopeId: 'team-1' } },
      { id: 'team-2', label: 'Support', refusal: { reason: 'linear/teamMismatch' } },
    ] });
  });
  it('pages named projects only on demand and keeps their team create operand', async () => {
    const h = host(({ operationName, variables }) => {
      expect(operationName).toBe('LinearCreationProjects');
      expect(variables.id).toBe('team-1');
      return { team: { id: 'team-1', projects: page([{ id: 'project-1', name: 'Autumn' }], true, 'next') } };
    });
    expect(await LINEAR_ACCOUNT_ACTIONS[LINEAR_ACTIONS.listCreationPlaces].run({ v: 1, instance, scopeId: 'team-1' }, h.context))
      .toMatchObject({ kind: 'page', status: 'partial', nextCursor: { token: 'next' }, places: [
        { label: 'Autumn', fields: { scopeId: 'team-1', projectId: 'project-1' } },
      ] });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});
