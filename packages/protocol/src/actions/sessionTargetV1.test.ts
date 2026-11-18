import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { normalizeSessionTargetV1, SessionTargetV1Schema, SessionTargetSelectorV1Schema, ActionResolvedSessionTargetsV1Schema } from './sessionTargetV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  PluginAccountCollectionContributionV1Schema,
  normalizePluginAccountCollectionContractV1,
  resolvePluginCollectionContractAccessV1,
} from '../plugins/data/collectionsV1.js';

describe('Session target routing contract', () => {
  it('keeps retained collection targets readable when explicit addresses are added', () => {
    const current = normalizePluginAccountCollectionContractV1({
      pluginId: 'test.session-targets',
      contribution: PluginAccountCollectionContributionV1Schema.parse({
        id: 'targets', schemaVersion: 1,
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            target: projectZodProtocolSchema(SessionTargetSelectorV1Schema).jsonSchema,
          },
          required: ['id', 'target'], additionalProperties: false,
        },
        serverReadable: ['id'], indexes: [],
      }),
    });
    const selector = current.schema.properties!.target!;
    const arms = selector.oneOf ?? selector.anyOf!;
    const retainedArms = arms.filter(arm => arm.properties?.selector?.const !== 'sessions');
    expect(retainedArms.length).toBe(arms.length - 1);
    const previous = normalizePluginAccountCollectionContractV1({
      pluginId: current.pluginId,
      contribution: PluginAccountCollectionContributionV1Schema.parse({
        id: current.collectionId, schemaVersion: 1,
        schema: {
          ...current.schema,
          properties: {
            ...current.schema.properties,
            target: { ...selector, ...(selector.oneOf ? { oneOf: retainedArms } : { anyOf: retainedArms }) },
          },
        },
        serverReadable: ['id'], indexes: [],
      }),
    });
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: previous, requested: current })).toBe('readOnly');
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: current, requested: previous })).toBe('readOnly');
  });

  it('accepts nonempty explicit addresses, dedupes by Home and Session, and keeps routing closed', () => {
    const a = { serverId: 'one', sessionId: 'a' };
    const b = { serverId: 'two', sessionId: 'a' };
    expect(SessionTargetV1Schema.parse({ selector: 'sessions', addresses: [a, a, b] }))
      .toEqual({ selector: 'sessions', addresses: [a, b] });
    for (const addresses of [[], [{ ...a, machineId: 'untrusted' }]]) {
      expect(SessionTargetV1Schema.safeParse({ selector: 'sessions', addresses }).success).toBe(false);
    }
  });
  it('retains unknown stored matching restrictions while refusing unsupported current routing inputs', () => {
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'] });
    const future = { selector: 'matching', filter: { ...filter, futureCore: { value: 'narrow' } } };
    expect(createStoredReadSchema(SessionTargetV1Schema).parse(future)).toEqual(future);
    for (const narrowing of [{ attention: 'needs_my_attention' }, { branches: { include: ['main'], exclude: [] } },
      { extensions: { 'acme.flag': { kind: 'boolean', value: true } } }]) {
      expect(SessionTargetV1Schema.safeParse({ selector: 'matching', filter: { ...filter, ...narrowing } }).success).toBe(false);
    }
  });
  it('normalizes only reserved shorthand and keeps exact reference operands exact', () => {
    expect(normalizeSessionTargetV1('session-existing')).toBe('session-existing');
    expect(normalizeSessionTargetV1('workers')).toEqual({ selector: 'workers' });
    expect(normalizeSessionTargetV1(' self ')).toEqual({ selector: 'self' });
    expect(normalizeSessionTargetV1('discussion:room-id')).toEqual({ selector: 'discussion', discussionId: 'room-id' });
    expect(normalizeSessionTargetV1({ selector: 'manager', of: 'workers' })).toEqual({ selector: 'manager', of: 'workers' });
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home-id'], show: 'sessions' });
    expect(normalizeSessionTargetV1(`matching:${JSON.stringify(filter)}`)).toEqual({ selector: 'matching', filter });
    expect(() => normalizeSessionTargetV1('matching:{broken')).toThrow();
    expect(() => normalizeSessionTargetV1('discussion:')).toThrow();
  });

  it('rejects unknown routing fields, recursive operands and noncanonical filters', () => {
    expect(SessionTargetV1Schema.safeParse({ selector: 'workers', recursive: true, of: 'base' }).success).toBe(true);
    for (const target of [
      { selector: 'workers', of: { selector: 'self' } },
      { selector: 'manager', recursive: true },
      { selector: 'discussion', discussionId: 'id', grant: true },
      { selector: 'matching', filter: { expression: 'status=failed' } },
      { selector: 'matching', filter: { ...normalizeSessionListFilterV1(), hiddenScope: true } },
    ]) expect(SessionTargetV1Schema.safeParse(target).success).toBe(false);
  });

  it('keeps the reviewed address snapshot closed down to concrete routing identities', () => {
    const snapshot = { actionId: 'session.message.send', field: 'sessionId', selector: true,
      targets: [{ serverId: 'home', sessionId: 'session' }] };
    expect(ActionResolvedSessionTargetsV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(ActionResolvedSessionTargetsV1Schema.safeParse({ ...snapshot, targets: [] }).success).toBe(false);
    expect(ActionResolvedSessionTargetsV1Schema.safeParse({ ...snapshot,
      targets: [{ serverId: 'home', sessionId: { selector: 'workers' } }],
    }).success).toBe(false);
    expect(ActionResolvedSessionTargetsV1Schema.safeParse({ ...snapshot,
      targets: [{ ...snapshot.targets[0], accountId: 'untrusted' }],
    }).success).toBe(false);
  });
});
