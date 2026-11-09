import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { evaluateSessionFollowRuleOccurrenceV1, SessionFollowRuleSourceEvidenceV1Schema, SessionFollowRuleSourceOccurrenceV1Schema } from './sessionFollowRuleOccurrenceV1.js';
import { FOLLOW_EVENT_KINDS_V1 } from './sessionFollowPolicyV1.js';
import type { SessionFollowRuleDefinitionV1 } from './sessionFollowRuleV1.js';
import { z } from 'zod/mini';
import { createSessionMessageMetaSchema } from '../messages/sessionMessageMeta.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { projectSessionFollowFactsV1, SessionAutoFollowPreferencesV1Schema, normalizeSessionFollowDefaultRulesV1 } from './accountFollow.js';

const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], startedBy: ['you'], scope: 'all_accessible',
  projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] } });
const definition: SessionFollowRuleDefinitionV1 = { v: 1, enabled: true, filter, policy: { preset: 'important' } };
const rules = [{ ruleId: 'project', version: 1, receiver: { kind: 'session' as const, sessionId: 'coordinator' }, definition }];
const evidence = { v: 1 as const, ownerAccountId: 'alice', event: { kind: 'failed_or_stopped' as const },
  facts: { serverId: 'home', kind: 'session' as const, startedBy: 'you' as const } };
const currentFacts = { ...evidence.facts, projectKey: 'payments' };

describe('current readable Follow rule matching', () => {
  it('applies canonical defaultRules through the same relationship matcher as legacy stored preferences', () => {
    const defaults = { assigned: true, direct: false, team: true, group: false };
    const parsed = SessionAutoFollowPreferencesV1Schema.safeParse({ defaultRules: defaults });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toEqual(SessionAutoFollowPreferencesV1Schema.parse(defaults));
    const matched = normalizeSessionFollowDefaultRulesV1({ serverId: 'home', preferences: parsed.data,
      relationships: { assigned: true, direct: true, team: true, group: true }, hasPersistentFollow: false });
    expect(matched.rules.map(rule => rule.key)).toEqual(['assigned', 'team']);
    expect(normalizeSessionFollowDefaultRulesV1({ serverId: 'home', preferences: parsed.data,
      relationships: { assigned: true, team: true }, hasPersistentFollow: true }).rules).toEqual([]);
  });

  it('requires needs_you evidence to name a current request original, never an immutable message', () => {
    const fields = { sourceSessionId: 'source', sourcePublisher: {
      publisherGeneration: '1', machineId: 'machine', committedFenceMs: 1 },
    };
    for (const type of ['decision', 'approval', 'blocked'] as const) {
      const question = { ...evidence, event: { kind: 'needs_you', type, mode: 'continue', handling: 'manager' } };
      expect(SessionFollowRuleSourceOccurrenceV1Schema.safeParse({ ...fields,
        sourceMessage: { localId: 'old-permission-frame', seq: 1 }, evidence: question }).success).toBe(false);
      expect(SessionFollowRuleSourceOccurrenceV1Schema.safeParse({ ...fields,
        sourceRequests: { agentStateVersion: 4, requests: [{ requestId: 'live-question', createdAt: 3, turnId: 'turn' }] },
        requestEvidence: [{ requestId: 'live-question', evidence: question }] }).success).toBe(true);
    }
    for (const kind of FOLLOW_EVENT_KINDS_V1) {
      if (kind !== 'needs_you') expect(SessionFollowRuleSourceOccurrenceV1Schema.safeParse({ ...fields,
        sourceMessage: { localId: 'original', seq: 1 }, evidence: { ...evidence, event: { kind } } }).success).toBe(true);
    }
  });
  it('normalizes personal defaults into the same policy evaluation without inventing stored rule identities', () => {
    const defaults = { preferences: { assigned: true, direct: true, team: true, group: false }, hasPersistentFollow: false,
      relationships: { assigned: true, direct: false } };
    const input = { accountId: 'alice', evaluator: 'receiver' as const, sourceSessionId: 'source',
      production: 'recovery' as const, evidence, currentFacts, rules: [], defaults };
    expect(evaluateSessionFollowRuleOccurrenceV1(input)).toMatchObject({ status: 'evaluated',
      pendingDefaultKeys: ['team'], routes: [{ receiver: { kind: 'account' }, rules: [], policies: [],
        defaultKeys: ['assigned'], defaultPolicies: [{ preset: 'important' }], delivery: { selected: true } }] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, personalFollowSuppressed: true }))
      .toMatchObject({ status: 'evaluated', routes: [], pendingDefaultKeys: [] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, mutedReceivers: [{ kind: 'account' }] }))
      .toMatchObject({ status: 'evaluated', routes: [] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, evidence: { ...evidence, event: { kind: 'message' } } }))
      .toMatchObject({ status: 'evaluated', routes: [] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, defaults: { ...defaults, hasPersistentFollow: undefined } }))
      .toMatchObject({ status: 'evaluated', routes: [], pendingDefaultKeys: ['assigned', 'team'] });
  });

  it('preserves an explicit Quiet choice against defaults while a separate explicit stronger rule still unions', () => {
    const quiet = projectSessionFollowFactsV1({ following: true, notificationLevel: 'none', hasPersistentFollow: true,
      followPolicy: JSON.stringify({ preset: 'quiet' }) });
    const input = { accountId: 'alice', evaluator: 'receiver' as const, sourceSessionId: 'source', production: 'recovery' as const,
      evidence, currentFacts, rules: [], defaults: { preferences: { assigned: true, direct: false, team: false, group: false },
        relationships: { assigned: true }, hasPersistentFollow: quiet.notificationLevel !== null } };
    expect(evaluateSessionFollowRuleOccurrenceV1(input)).toMatchObject({ status: 'evaluated', routes: [], pendingDefaultKeys: [] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, rules: [{ ruleId: 'explicit-important', version: 1,
      receiver: { kind: 'account' }, definition }] })).toMatchObject({ status: 'evaluated', routes: [{
        rules: [{ ruleId: 'explicit-important', version: 1 }], policies: [{ preset: 'important' }], delivery: { selected: true },
      }] });
    const onceOnly = projectSessionFollowFactsV1({ following: false, notificationLevel: 'none', hasPersistentFollow: false });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, defaults: { ...input.defaults,
      hasPersistentFollow: onceOnly.notificationLevel !== null } })).toMatchObject({ routes: [{ defaultKeys: ['assigned'] }] });
  });

  it('retains original source evidence through the exact stored-message metadata reader', () => {
    const opened = createStoredReadSchema(createSessionMessageMetaSchema(z)).parse({ happierFollowRuleEvidenceV1: evidence });
    expect(opened).toHaveProperty('happierFollowRuleEvidenceV1', evidence);
    for (const field of [{ metadata: { projectId: 'private' } }, { projectMetadata: { projectId: 'private' } }, { tagIds: ['private'] }]) {
      expect(SessionFollowRuleSourceEvidenceV1Schema.safeParse({ ...evidence, facts: { ...evidence.facts, ...field } }).success).toBe(false);
    }
  });
  it('selects a later matching source through the same policy without enrollment or another-session reads', () => {
    const result = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'source',
      sourceSessionId: 'created-after-rule', production: 'source', evidence, currentFacts, rules });
    expect(result).toMatchObject({ status: 'evaluated', pendingRuleIds: [], routes: [{ receiver: rules[0].receiver,
      rules: [{ ruleId: 'project', version: 1 }], delivery: { selected: true, session: { wake: true } } }] });
  });

  it('evaluates a moved source using current Project facts, never original private facts', () => {
    const result = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'source', sourceSessionId: 'source',
      production: 'source', evidence, currentFacts: { ...evidence.facts, projectKey: 'other' }, rules });
    expect(result).toMatchObject({ status: 'evaluated', routes: [], pendingRuleIds: [] });
    const movedIn = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'source', sourceSessionId: 'source',
      production: 'source', evidence, currentFacts, rules });
    expect(movedIn).toMatchObject({ status: 'evaluated', routes: [{ receiver: rules[0].receiver }], pendingRuleIds: [] });
  });

  it('keeps unreadable current project facts pending', () => {
    const result = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'source', sourceSessionId: 'source',
      production: 'source', evidence, currentFacts: { ...evidence.facts, metadata: undefined }, rules });
    expect(result).toMatchObject({ status: 'evaluated', routes: [], pendingRuleIds: ['project'] });
  });

  it('places recovered and foreign-Account occurrences at the receiver only', () => {
    for (const [production, ownerAccountId] of [['recovery', 'alice'], ['source', 'bob']] as const) {
      const input = { accountId: 'alice', sourceSessionId: 'source', production,
        evidence: { ...evidence, ownerAccountId }, currentFacts, rules };
      expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, evaluator: 'source' })).toEqual({ status: 'other_evaluator' });
      expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, evaluator: 'receiver' }).status).toBe('evaluated');
    }
    expect(evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'receiver', sourceSessionId: 'source',
      production: 'source', evidence, currentFacts, rules })).toEqual({ status: 'other_evaluator' });
  });

  it('merges overlapping rules by receiver and applies the canonical mute before selecting a wake', () => {
    const overlapping = [...rules, { ...rules[0], ruleId: 'quiet', definition: { ...definition, policy: { preset: 'quiet' as const } } }];
    const input = { accountId: 'alice', evaluator: 'source' as const, sourceSessionId: 'source', production: 'source' as const,
      evidence, currentFacts, rules: overlapping };
    expect(evaluateSessionFollowRuleOccurrenceV1(input)).toMatchObject({ routes: [{ rules: [
      { ruleId: 'project', version: 1 }, { ruleId: 'quiet', version: 1 }], delivery: { session: { wake: true } } }] });
    expect(evaluateSessionFollowRuleOccurrenceV1({ ...input, mutedReceivers: [{ kind: 'session', sessionId: 'coordinator' }] }))
      .toMatchObject({ status: 'evaluated', routes: [] });
  });

  it('Started by me excludes a person on another Account and real automated origins', () => {
    for (const [ownerAccountId, startedBy] of [['bob', 'you'], ['alice', 'triggers'], ['alice', 'agents']] as const) {
      const result = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'receiver', sourceSessionId: 'source',
        production: 'recovery', evidence: { ...evidence, ownerAccountId }, currentFacts: { ...currentFacts, startedBy }, rules });
      expect(result).toMatchObject({ status: 'evaluated', routes: [], pendingRuleIds: [] });
    }
  });

  it('measures one-source matching with 20 cached rules across 200 source sessions', () => {
    const benchmarkRules = Array.from({ length: 20 }, (_, index) => ({ ...rules[0], ruleId: `rule-${index}`,
      receiver: { kind: 'session' as const, sessionId: `coordinator-${index % 5}` } }));
    const corpus = Array.from({ length: 200 }, (_, index) => ({ ...evidence,
      facts: { ...evidence.facts, projectKey: index % 2 === 0 ? 'payments' : 'other' } }));
    const cycles = 100;
    let routes = 0;
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const [index, source] of corpus.entries()) {
        const result = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'alice', evaluator: 'source',
          sourceSessionId: `source-${index}`, production: 'source', evidence: source, currentFacts: source.facts, rules: benchmarkRules });
        if (result.status === 'evaluated') routes += result.routes.length;
      }
    }
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStart);
    expect(routes).toBe(cycles * 100 * 5);
    console.info('Follow occurrence benchmark', { rules: benchmarkRules.length, sourceSessions: corpus.length,
      occurrences: cycles * corpus.length, elapsedMs, cpuMicrosecondsPerOccurrence: (cpu.user + cpu.system) / (cycles * corpus.length),
      wallMicrosecondsPerOccurrence: elapsedMs * 1000 / (cycles * corpus.length) });
  });
});
