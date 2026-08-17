import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

function readFunction(name: string): (value: unknown) => unknown {
  const value = Reflect.get(protocol, name);
  expect(typeof value).toBe('function');
  return value as (input: unknown) => unknown;
}

type ParseableSchema = Readonly<{
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}>;

function readSchema(name: string): ParseableSchema {
  const value = Reflect.get(protocol, name);
  expect(value).toBeDefined();
  expect(typeof Reflect.get(value, 'parse')).toBe('function');
  expect(typeof Reflect.get(value, 'safeParse')).toBe('function');
  return value as ParseableSchema;
}

function nestedStack(depth: number): unknown {
  let snapshot: unknown = { kind: 'text', text: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    snapshot = { kind: 'stack', children: [snapshot] };
  }
  return snapshot;
}

describe('MessageStructuredPresentationV1', () => {
  const owner = {
    pluginId: 'acme.transcript',
    contributionLocalId: 'review-card',
  } as const;

  const persisted = {
    v: 1,
    profile: 'pluginTranscriptV1',
    owner,
    snapshot: {
      kind: 'stack',
      children: [
        { kind: 'text', text: 'Review ready' },
        {
          kind: 'actionPanel',
          children: [{
            kind: 'action',
            action: { pluginId: 'acme.transcript', localId: 'open-review' },
            label: 'Open review',
          }],
        },
      ],
    },
  } as const;

  it('imports the strict transcript profile and closes the persisted immutable envelope', () => {
    const schema = readSchema('MessageStructuredPresentationV1Schema');
    const isCandidate = readFunction('isMessageStructuredPresentationV1Candidate');

    expect(schema.parse(persisted)).toEqual(persisted);
    expect(schema.safeParse({
      ...persisted,
      snapshot: {
        kind: 'field',
        label: 'Live field',
        control: { kind: 'text', settingId: 'secret' },
      },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...persisted,
      snapshot: { kind: 'action', action: 'open-review', label: 'Open review' },
    }).success).toBe(false);
    expect(schema.safeParse({ ...persisted, callback: 'must-not-persist' }).success).toBe(false);
    expect(schema.safeParse({ ...persisted, snapshot: nestedStack(16) }).success).toBe(false);
    expect(schema.safeParse({
      ...persisted,
      snapshot: { kind: 'text', text: 'x'.repeat(256 * 1024) },
    }).success).toBe(false);

    // A writer must not reinterpret an attempted future/invalid structured
    // snapshot as ordinary Message content. Readers still use schema parsing
    // and fall back safely for such historical values.
    expect(isCandidate({ profile: 'pluginTranscriptV2', v: 1 })).toBe(true);
    expect(isCandidate({ profile: 'pluginTranscriptV1', v: 2 })).toBe(true);
    expect(isCandidate({ role: 'agent', text: 'ordinary Message content' })).toBe(false);
  });

  it('host-stamps the current owner, qualifies local action references, and reads no live plugin state', () => {
    const create = readFunction('createMessageStructuredPresentationV1');
    const read = readFunction('readMessageStructuredPresentationV1');

    const created = create({
      owner,
      snapshot: {
        kind: 'actionPanel',
        children: [{ kind: 'action', action: 'open-review', label: 'Open review' }],
      },
    }) as typeof persisted;

    expect(created).toEqual({
      v: 1,
      profile: 'pluginTranscriptV1',
      owner,
      snapshot: {
        kind: 'actionPanel',
        children: [{
          kind: 'action',
          action: { pluginId: owner.pluginId, localId: 'open-review' },
          label: 'Open review',
        }],
      },
    });

    const replay = read(created) as typeof persisted | null;
    expect(replay).toEqual(created);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay?.snapshot)).toBe(true);
    expect(read({ ...created, snapshot: { kind: 'field', label: 'no', control: { kind: 'text', settingId: 'x' } } })).toBeNull();
  });

  it('fails closed when a corrupt recursive snapshot exceeds the parser stack before the declared depth guard', () => {
    const read = readFunction('readMessageStructuredPresentationV1');
    let replay: unknown = undefined;

    expect(() => {
      replay = read({ ...persisted, snapshot: nestedStack(2_000) });
    }).not.toThrow();
    expect(replay).toBeNull();
  });
});
