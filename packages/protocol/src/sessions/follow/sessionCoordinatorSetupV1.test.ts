import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { normalizeSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { OpenedSessionFollowRuleV1Schema } from './actions.js';
import { prepareSessionCoordinatorSetupV1 } from './sessionCoordinatorSetupV1.js';

const settings = accountSettingsParse({});
const ruleIds = { project: 'project-rule', home: 'home-rule' };
const project = { serverId: 'home', projectKey: 'payments' };
const homeFilter = normalizeSessionListFilterV1({ show: 'sessions', startedBy: ['you'], scope: 'all_accessible', homeServerIds: ['home'] });
const rule = (sessionId: string, ruleId = 'daily') => OpenedSessionFollowRuleV1Schema.parse({
  ruleId, receiver: { kind: 'session', sessionId }, version: 1,
  definition: { v: 1, enabled: true, filter: homeFilter, policy: { preset: 'important' } },
});
const input = { serverId: 'home', sessionId: 'new', scope: 'project' as const, project, settings, ruleIds };

describe('coordinator setup preparation', () => {
  it('recognizes the same Home-wide filter after strict schema projection changes object-key insertion order', () => {
    const candidate = rule('daily');
    const { source, ...otherSelections } = homeFilter;
    const filter = { source, ...otherSelections };
    const reordered = OpenedSessionFollowRuleV1Schema.parse({ ...candidate,
      definition: { ...candidate.definition, filter } });
    expect(prepareSessionCoordinatorSetupV1({ ...input,
      ruleCensus: { serverId: 'home', coverage: 'complete', rules: [reordered] } }).managedBySessionId).toBe('daily');
  });
  it('prepares project-first and Home Started-by-me rules from creation defaults, with exact caller-owned identities and explicit keep resolution', () => {
    const prepared = prepareSessionCoordinatorSetupV1(input);
    expect(prepared).toMatchObject({ roleId: 'orchestrator', answersWorkerQuestions: true,
      keepPreference: 'suggest', keep: 'list_pin', managedBySessionId: null });
    expect(prepared.ruleSuggestions).toEqual([
      { source: { kind: 'rule', ruleId: 'project-rule' }, expectedVersion: -1,
        ruleDefinition: { v: 1, enabled: true, filter: { ...homeFilter, projects: { include: [project], exclude: [] } } } },
      { source: { kind: 'rule', ruleId: 'home-rule' }, expectedVersion: -1,
        ruleDefinition: { v: 1, enabled: true, filter: homeFilter } },
    ]);
    expect(prepareSessionCoordinatorSetupV1({ ...input, scope: 'home' }).keep).toBe('list_pin');
    expect(prepareSessionCoordinatorSetupV1({ ...input, project: null, scope: 'home' }).ruleSuggestions.map(value => value.source.ruleId)).toEqual(['home-rule']);
    const explicit = prepareSessionCoordinatorSetupV1({ ...input, settings: { ...settings,
      coordinationCoordinatorRoleId: 'custom', coordinationCoordinatorKeep: 'none', coordinationCoordinatorAnswersWorkerQuestions: false,
      coordinationCoordinatorSuggestProjectRule: false, coordinationCoordinatorSuggestHomeRule: false } });
    expect(explicit).toMatchObject({ roleId: 'custom', answersWorkerQuestions: false, keepPreference: 'none', keep: 'none', ruleSuggestions: [] });
    expect(() => prepareSessionCoordinatorSetupV1({ ...input, project: { ...project, serverId: 'foreign' } })).toThrow('invalid_parameters');
  });

  it('preselects only one other enabled Home-wide Session receiver from a complete admitted same-Home census', () => {
    const rules = [rule('daily'), rule('daily', 'daily-again'), rule('new', 'self'),
      { ...rule('account'), receiver: { kind: 'account' as const } }];
    const census = { serverId: 'home', coverage: 'complete' as const, rules };
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: census }).managedBySessionId).toBe('daily');
    for (const coverage of ['partial', 'unavailable'] as const) {
      expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census, coverage } }).managedBySessionId).toBeNull();
    }
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census, serverId: 'foreign' } }).managedBySessionId).toBeNull();
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census, rules: [...rules, rule('another')] } }).managedBySessionId).toBeNull();
    const allOrigins = { ...rule('daily'), definition: { ...rule('daily').definition,
      filter: { ...homeFilter, show: 'both' as const, startedBy: ['agents', 'you', 'triggers'] as const } } };
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census, rules: [allOrigins] } }).managedBySessionId).toBe('daily');
    const emptyFacets = { ...rule('daily'), definition: { ...rule('daily').definition,
      filter: { ...homeFilter, projects: { include: [], exclude: [] }, statuses: { include: [], exclude: [] } } } };
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census, rules: [emptyFacets] } }).managedBySessionId).toBe('daily');
  });

  it('does not call restricted or disabled rules Home-wide', () => {
    const candidate = rule('daily');
    const filters = [
      { ...homeFilter, show: 'runs' as const }, { ...homeFilter, startedBy: ['agents'] as const },
      { ...homeFilter, homeServerIds: ['home', 'other'] }, { ...homeFilter, homeServerIds: ['other'] },
      { ...homeFilter, scope: 'my_work' as const }, { ...homeFilter, attention: 'needs_my_attention' as const },
      { ...homeFilter, source: 'persisted' as const }, { ...homeFilter, bot: 'bot' as const },
      { ...homeFilter, coordinator: 'coordinator' as const }, { ...homeFilter, statuses: { include: ['failed'] as const, exclude: [] } },
      { ...homeFilter, statuses: { include: [], exclude: ['failed'] as const } },
      { ...homeFilter, projects: { include: [project], exclude: [] } },
      { ...homeFilter, projects: { include: [], exclude: [project] } }, { ...homeFilter, underSessionId: 'manager' },
      { ...homeFilter, tagIds: { include: [{ serverId: 'home', tagId: 'urgent' }], exclude: [] } },
      { ...homeFilter, audiences: { include: [{ serverId: 'home', kind: 'outside_teams' as const }], exclude: [] } },
    ];
    const census = { serverId: 'home', coverage: 'complete' as const, rules: [candidate] };
    for (const filter of filters) {
      expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census,
        rules: [{ ...candidate, definition: { ...candidate.definition, filter } }] } }).managedBySessionId).toBeNull();
    }
    expect(prepareSessionCoordinatorSetupV1({ ...input, ruleCensus: { ...census,
      rules: [{ ...candidate, definition: { ...candidate.definition, enabled: false } }] } }).managedBySessionId).toBeNull();
  });
});
