import { describe, expect, it } from 'vitest';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from './sessionFollowRuleContentCodecV1.js';
import { SessionFollowRuleDefinitionV1Schema,
  buildSessionFollowRulePhysicalKeyV1, parseSessionFollowRulePhysicalKeyV1 } from './sessionFollowRuleV1.js';
import { SessionFollowPersonalProgressRequestV1Schema, SessionFollowRuleStoredRowV1Schema, SessionFollowRuleV1Schema } from './sessionFollowRuleV1.js';
import { OpenedSessionFollowRuleV1Schema } from './actions.js';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from './sessionFollowFrontierV1.js';
import { matchSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { SESSION_FOLLOW_RULE_CIPHER_KIND_V1 } from './sessionFollowRuleV1.js';
import { SessionFollowObserveSourceRoutesRequestV1Schema } from './sessionFollowTransportV1.js';

const definition = SessionFollowRuleDefinitionV1Schema.parse({ v: 1, enabled: true, policy: { preset: 'important' },
  filter: { show: 'both', startedBy: ['you'], scope: 'all_accessible', attention: 'any', homeServerIds: ['home'], audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, source: 'all' } });
const receiver = { kind: 'session', sessionId: 'coordinator' } as const;
const material = { type: 'dataKey', machineKey: new Uint8Array(32).fill(23) } as const;

describe('private Follow rule content', () => {
  it('admits only closed receiver-person original identities without publisher authority', () => {
    const occurrence = { evaluation: 'receiver', production: 'source', sourceSessionId: 'source',
      rules: [{ ruleId: 'rule', ruleVersion: 0 }], sourceMessage: { localId: 'message', seq: 1 } };
    expect(SessionFollowPersonalProgressRequestV1Schema.safeParse(occurrence).success).toBe(true);
    const observation = { v: 1, receiver: { kind: 'account' }, production: 'source', sourceMessage: occurrence.sourceMessage };
    expect(SessionFollowObserveSourceRoutesRequestV1Schema.safeParse(observation).success).toBe(true);
    expect(SessionFollowObserveSourceRoutesRequestV1Schema.safeParse({ ...observation, destinationSessionId: 'destination' }).success).toBe(false);
    for (const extra of [{ accountId: 'foreign' }, { machineId: 'machine' }, { expectedSourcePublisherGeneration: '1' },
      { rules: [] }, { production: 'unknown' }, { sourceMessage: { ...occurrence.sourceMessage, event: 'finished' } }]) {
      expect(SessionFollowPersonalProgressRequestV1Schema.safeParse({ ...occurrence, ...extra }).success).toBe(false);
    }
  });
  it.each([{ futureCore: { value: 'narrow' } }, { extensions: { 'acme.future': { kind: 'future', value: true } } }])('opens future narrowing without authorizing a rule or a current write (%j)', narrowing => {
    const future = { ...definition, filter: { ...definition.filter, ...narrowing } };
    const content = { t: 'plain', v: future };
    const row = { ruleId: 'future', receiver, version: 1, content };
    expect(SessionFollowRuleV1Schema.safeParse(row).success).toBe(true);
    const opened = openSessionFollowRuleContentV1({ ruleId: 'future', receiver, content, mode: 'plain', material: null });
    expect(opened.status).toBe('opened');
    if (opened.status !== 'opened') return;
    expect(opened.definition.filter).toEqual(future.filter);
    expect(matchSessionListFilterV1(opened.definition.filter, { serverId: 'home', kind: 'session', startedBy: 'you' }, 'daemonRule')).toBe('unavailable');
    expect(SessionFollowRuleDefinitionV1Schema.safeParse(future).success).toBe(false);
    const encrypted = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: SESSION_FOLLOW_RULE_CIPHER_KIND_V1,
      material, payload: { ruleId: 'future', receiver, definition: future }, randomBytes: length => new Uint8Array(length).fill(7) }) };
    expect(openSessionFollowRuleContentV1({ ruleId: 'future', receiver, content: encrypted, mode: 'e2ee', material }))
      .toEqual({ status: 'opened', definition: future });
    expect(() => sealSessionFollowRuleContentV1({ ruleId: 'future', receiver, definition: opened.definition, mode: 'e2ee', material })).toThrow();
  });

  it('rejects list-only attention, Branch and plugin conditions at current rule admission', () => {
    for (const filter of [
      { ...definition.filter, attention: 'needs_my_attention' },
      { ...definition.filter, branches: { include: ['main'], exclude: [] } },
      { ...definition.filter, extensions: { 'acme.flag': { kind: 'boolean', value: true } } },
    ]) expect(SessionFollowRuleDefinitionV1Schema.safeParse({ ...definition, filter }).success).toBe(false);
  });
  it('retains one canonical source frontier without changing the private authoring version', () => {
    const source = { sourceSessionId: 'source', delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 5 } };
    const row = { version: 2, receiver, content: { t: 'plain', v: definition }, sources: [source] };
    expect(SessionFollowRuleStoredRowV1Schema.safeParse(row).success).toBe(true);
    expect(SessionFollowRuleStoredRowV1Schema.safeParse({ ...row, sources: [source, source] }).success).toBe(false);
    expect(SessionFollowRuleV1Schema.parse({ ruleId: 'rule', ...row }).sources).toEqual([source]);
    expect(OpenedSessionFollowRuleV1Schema.parse({ ruleId: 'rule', version: row.version,
      receiver, definition, sources: [source] }).sources).toEqual([source]);
  });
  it('round-trips keyless plain and encrypted rules while binding rule and receiver identities', () => {
    const encrypted = sealSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, definition, mode: 'e2ee', material });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material })).toEqual({ status: 'opened', definition });
    for (const identity of [{ ruleId: 'rule-b', receiver }, { ruleId: 'rule-a', receiver: { kind: 'account' } as const }]) {
      expect(openSessionFollowRuleContentV1({ ...identity, content: encrypted, mode: 'e2ee', material })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    }
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(24) } })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    const plain = sealSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, definition, mode: 'plain', material: null });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: plain, mode: 'plain', material: null })).toEqual({ status: 'opened', definition });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: plain, mode: 'e2ee', material })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'plain', material: null })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material: null })).toEqual({ status: 'unavailable', reason: 'encryption-material-unavailable' });
  });

  it('keeps encoded rule identities canonical and denies mutation fields outside the definition', () => {
    const ruleId = 'project/payments %';
    expect(parseSessionFollowRulePhysicalKeyV1(buildSessionFollowRulePhysicalKeyV1(ruleId))).toBe(ruleId);
    expect(parseSessionFollowRulePhysicalKeyV1('@happier/account/session-follow-rules/v1/project/payments')).toBeNull();
    expect(SessionFollowRuleDefinitionV1Schema.safeParse({ ...definition, accountId: 'other' }).success).toBe(false);
  });
});
