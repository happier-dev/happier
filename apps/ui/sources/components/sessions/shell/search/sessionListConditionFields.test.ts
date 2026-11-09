import { describe, expect, it, vi } from 'vitest';
import { listSessionPresentationStatesForWorkStatusFilterV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import {
  buildSessionListConditionLabels,
  buildSessionListFilterEditorLabels,
} from './SessionListFilterControl';
import {
  applySessionListConditionEdit,
  buildSessionListConditionBindings,
  buildSessionListConditionModel,
  resolveSessionListBaseConditionFields,
  restoreSessionListConditionToBase,
} from './sessionListConditionFields';
import { createSessionListViewFilterDefaults } from './sessionListViewFilters';
import { toStoredSessionListFilter } from './storedSessionListFilter';

const base = createSessionListViewFilterDefaults({
  scope: 'my_work',
  homeServerIds: ['home-a', 'home-b'],
});
const writers = () => ({
  updateFilters: vi.fn(),
  setSource: vi.fn(),
  setIncludeInactive: vi.fn(),
  resetFilters: vi.fn(),
});
const choices = () =>
  buildSessionListConditionBindings({
    editorLabels: buildSessionListFilterEditorLabels(),
    copy: buildSessionListConditionLabels(),
    scopesAvailable: {
      my_work: true,
      assigned_to_me: true,
      following: true,
      involving_me: true,
      all_accessible: true,
    },
    homes: [
      { serverId: 'home-a', label: 'Home A' },
      { serverId: 'home-b', label: 'Home B' },
    ],
    tags: [],
    projects: [],
    agents: [{ agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), label: 'Codex' }],
    sections: [{ serverId: 'home-a', sectionId: 'section-a', label: 'Release' }],
    audiences: [],
    attentionAvailable: true,
    inactiveVisibilityAvailable: true,
    sourceAvailable: true,
  });

describe('Sessions binding of the shared condition editor', () => {
  it('offers Project, Agent and Section as composable conditions with qualified values', () => {
    const available = choices();
    for (const id of ['projects', 'agents', 'sections']) expect(available.addableFieldIds.has(id)).toBe(true);
    const model = buildSessionListConditionModel(base, true, available.bindings);
    expect(model.availableFields.find(field => field.id === 'agents')?.valueOptions).toEqual([
      expect.objectContaining({ value: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), label: 'Codex' }),
    ]);
    expect(model.availableFields.find(field => field.id === 'sections')?.valueOptions).toEqual([
      expect.objectContaining({ value: { serverId: 'home-a', sectionId: 'section-a' }, label: 'Release' }),
    ]);
    let filters = base;
    const agent = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
    expect(available.formatValue(model.availableFields.find(field => field.id === 'agents')!, agent)).toBe('Codex');
    expect(available.formatValue(model.availableFields.find(field => field.id === 'agents')!,
      buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'acme.assistant', localId: 'codex' } }))).not.toBe('Codex');
    for (const [fieldId, value] of [
      ['projects', { serverId: 'home-a', projectKey: 'project-a' }],
      ['agents', agent],
      ['sections', { serverId: 'home-a', sectionId: 'section-a' }],
    ] as const) {
      applySessionListConditionEdit({ type: 'add', condition: { fieldId, operator: 'is', values: [value] } }, {
        filters, includeInactive: true, ...writers(), updateFilters: next => { filters = next; },
      });
    }
    expect(buildSessionListConditionModel(filters, true, available.bindings).rows.map(row => row.fieldId))
      .toEqual(expect.arrayContaining(['projects', 'agents', 'sections']));
    const facts = { serverId: 'home-a', kind: 'session' as const, projectKey: 'project-a', agent, startedBy: 'you' as const,
      scopeMatches: { my_work: true },
      section: { serverId: 'home-a', sectionId: 'section-a' } };
    const stored = toStoredSessionListFilter(filters);
    expect(matchSessionListFilterV1(stored, facts)).toBe('match');
    expect(matchSessionListFilterV1(stored, { ...facts, projectKey: 'project-b' })).toBe('miss');
    expect(matchSessionListFilterV1(stored, { ...facts, agent: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }) })).toBe('miss');
    expect(matchSessionListFilterV1(stored, { ...facts, section: { serverId: 'home-b', sectionId: 'section-a' } })).toBe('miss');
  });
  it('carries held value frequencies into grouped options without persisting or inventing missing counts', () => {
    const counts = { fieldId: 'statuses', options: [{ value: 'working', count: 3 }, { value: 'idle', count: 0 }] };
    const model = buildSessionListConditionModel(base, true, choices().bindings, counts);
    const options = model.availableFields.find(field => field.id === 'statuses')!.valueOptions;
    expect(options.find(option => option.value === 'working')).toMatchObject({ count: 3,
      values: listSessionPresentationStatesForWorkStatusFilterV1('working') });
    expect(options.find(option => option.value === 'idle')).toMatchObject({ count: 0 });
    expect(options.find(option => option.value === 'needs_you')).not.toHaveProperty('count');
    expect(base).not.toHaveProperty('valueCounts');
  });

  it('draws only what differs from where the list starts, and always its Whose', () => {
    const filters = { ...base, attention: 'needs_my_attention' as const };
    const hidden = resolveSessionListBaseConditionFields({
      filters,
      base,
      includeInactive: true,
      baseIncludeInactive: true,
    });
    expect(hidden.has('attention')).toBe(false);
    expect(hidden.has('scope')).toBe(false);
    expect(hidden.has('show')).toBe(true);
    expect(hidden.has('homeServerIds')).toBe(true);
    const model = buildSessionListConditionModel(
      filters,
      true,
      choices().bindings,
    );
    const drawn = model.rows
      .filter((row) => !hidden.has(row.fieldId))
      .map((row) => row.fieldId);
    expect(drawn).toEqual(expect.arrayContaining(['scope', 'attention']));
    expect(drawn).not.toContain('show');
  });

  it('routes each edit to the facet owner: Source and inactive have theirs, Clear restores the base', () => {
    const filters = { ...base, searchQuery: 'release' };
    const model = buildSessionListConditionModel(
      filters,
      true,
      choices().bindings,
    );
    const write = writers();
    applySessionListConditionEdit(
      {
        type: 'add',
        condition: {
          fieldId: 'attention',
          operator: 'is',
          values: ['needs_my_attention'],
        },
      },
      { filters, includeInactive: true, ...write },
    );
    expect(write.updateFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attention: 'needs_my_attention',
        searchQuery: 'release',
      }),
    );

    const sourceRow = model.rows.find((row) => row.fieldId === 'source');
    applySessionListConditionEdit(
      sourceRow
        ? {
            type: 'change',
            rowId: sourceRow.id,
            condition: {
              fieldId: 'source',
              operator: 'is',
              values: ['direct'],
            },
          }
        : {
            type: 'add',
            condition: {
              fieldId: 'source',
              operator: 'is',
              values: ['direct'],
            },
          },
      { filters, includeInactive: true, ...write },
    );
    expect(write.setSource).toHaveBeenLastCalledWith('direct');

    const inactiveRow = model.rows.find(
      (row) => row.fieldId === 'includeInactive',
    )!;
    applySessionListConditionEdit(
      {
        type: 'change',
        rowId: inactiveRow.id,
        condition: {
          fieldId: 'includeInactive',
          operator: 'is',
          values: [false],
        },
      },
      { filters, includeInactive: true, ...write },
    );
    expect(write.setIncludeInactive).toHaveBeenLastCalledWith(false);

    applySessionListConditionEdit(
      { type: 'clear' },
      { filters, includeInactive: true, ...write },
    );
    expect(write.resetFilters).toHaveBeenCalledTimes(1);
    expect(write.updateFilters).toHaveBeenCalledTimes(1);
  });

  it('offers Status as its Work groups, each choice its whole state vector, named by the group word (P6 grouped Status)', () => {
    const states =
      listSessionPresentationStatesForWorkStatusFilterV1('working');
    const editorLabels = buildSessionListFilterEditorLabels();
    const model = buildSessionListConditionModel(
      { ...base, statuses: [...states] },
      true,
      choices().bindings,
    );
    for (const fieldId of ['statuses', 'excludedStatuses']) {
      const field = model.availableFields.find(
        (candidate) => candidate.id === fieldId,
      )!;
      expect(field.valueOptions.map((option) => option.label)).toEqual([
        editorLabels.statusWorking,
        editorLabels.statusNeedsYou,
        editorLabels.statusFailed,
        editorLabels.statusIdle,
        editorLabels.statusOffline,
      ]);
      expect(
        field.valueOptions.find((option) => option.value === 'working')?.values,
      ).toEqual(states);
    }
    // The Session editor keeps no Status summary of its own: the shared editor names a picked group.
    expect('summarizeValues' in choices()).toBe(false);
  });

  it("a token's × puts that one condition back to what the space says", () => {
    const space = { ...base, attention: 'needs_my_attention' as const };
    const filters = {
      ...space,
      attention: 'any' as const,
      coordinator: 'coordinator' as const,
    };
    const write = writers();
    restoreSessionListConditionToBase('attention', {
      filters,
      base: space,
      baseIncludeInactive: true,
      ...write,
    });
    expect(write.updateFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attention: 'needs_my_attention',
        coordinator: 'coordinator',
      }),
    );
  });
});
