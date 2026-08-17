import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

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

describe('MessageActionReferenceV1', () => {
  const reference = {
    v: 1,
    sessionId: 'session_durable',
    messageId: 'msg_durable',
    observedRevision: 'revision_7',
  } as const;

  it('accepts only the opaque durable server Message identity', () => {
    const schema = readSchema('MessageActionReferenceV1Schema');

    expect(schema.parse(reference)).toEqual(reference);
    expect(schema.safeParse({ ...reference, localId: 'optimistic-local-id' }).success).toBe(false);
    expect(schema.safeParse({ ...reference, seq: 7 }).success).toBe(false);
    expect(schema.safeParse({ ...reference, message: { text: 'caller supplied' } }).success).toBe(false);
    expect(schema.safeParse({ ...reference, messageId: ' local-looking-id ' }).success).toBe(false);
  });

  it('bounds the only disclosure snapshot and makes every unavailable outcome exact', () => {
    const schema = readSchema('MessageActionResolutionV1Schema');
    const available = {
      status: 'available',
      snapshot: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        role: 'agent',
        contentCategory: 'text',
        seq: 7,
        visibleText: 'bounded visible transcript text',
        structuredPresentationSummary: null,
        provenanceCategory: 'plugin',
      },
    } as const;

    expect(schema.parse(available)).toEqual(available);
    for (const status of ['stale', 'deleted', 'compacted', 'ineligible', 'unavailable']) {
      expect(schema.parse({ status })).toEqual({ status });
    }

    expect(schema.safeParse({
      ...available,
      snapshot: { ...available.snapshot, visibleText: 'é'.repeat(16_385) },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...available,
      snapshot: { ...available.snapshot, structuredPresentationSummary: 'é'.repeat(4_097) },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...available,
      snapshot: { ...available.snapshot, encryptedContent: 'ciphertext' },
    }).success).toBe(false);
  });

  it('keeps the server-owned durable lookup distinct from the handler disclosure snapshot', () => {
    const schema = readSchema('MessageActionDurableResolutionV1Schema');
    const available = {
      status: 'available',
      message: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
      },
    } as const;

    expect(schema.parse(available)).toEqual(available);
    expect(schema.parse({ status: 'stale' })).toEqual({ status: 'stale' });
    expect(schema.safeParse({
      ...available,
      message: { ...available.message, content: { t: 'encrypted', c: 'must-not-cross' } },
    }).success).toBe(false);
    expect(schema.safeParse({ status: 'available', message: { ...available.message, localId: 'forbidden' } }).success).toBe(false);
  });

  it('uses current access, durable revision, mount state, and eligibility as the one resolution order', () => {
    const resolve = Reflect.get(protocol, 'resolveMessageActionReferenceV1');
    const issue = Reflect.get(protocol, 'issueMessageActionReferenceV1');
    expect(typeof resolve).toBe('function');
    expect(typeof issue).toBe('function');

    const current = {
      sessionId: reference.sessionId,
      messageId: reference.messageId,
      observedRevision: reference.observedRevision,
      state: 'available',
      accessible: true,
      mountCurrent: true,
      actionEligible: true,
      snapshot: {
        role: 'agent',
        contentCategory: 'text',
        seq: 7,
        visibleText: 'bounded visible transcript text',
        structuredPresentationSummary: null,
        provenanceCategory: 'plugin',
      },
    };

    expect((issue as (value: unknown) => unknown)(current)).toEqual(reference);
    expect((resolve as (value: unknown) => unknown)({ reference, current })).toEqual({
      status: 'available',
      snapshot: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        ...current.snapshot,
      },
    });
    expect((resolve as (value: unknown) => unknown)({
      reference,
      current: { ...current, accessible: false, state: 'deleted' },
    })).toEqual({ status: 'unavailable' });
    expect((resolve as (value: unknown) => unknown)({
      reference,
      current: { ...current, observedRevision: 'revision_8' },
    })).toEqual({ status: 'stale' });
    expect((resolve as (value: unknown) => unknown)({
      reference,
      current: { ...current, mountCurrent: false },
    })).toEqual({ status: 'stale' });
    expect((resolve as (value: unknown) => unknown)({
      reference,
      current: { ...current, state: 'compacted' },
    })).toEqual({ status: 'compacted' });
    expect((resolve as (value: unknown) => unknown)({
      reference,
      current: { ...current, actionEligible: false },
    })).toEqual({ status: 'ineligible' });
  });

  it('projects provenance through the canonical admission union without disclosing source identities', () => {
    const project = Reflect.get(protocol, 'projectMessageActionProvenanceCategoryV1');
    expect(typeof project).toBe('function');

    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'happierApp',
      actor: { kind: 'sharedCollaborator' },
    })).toBe('collaborator');
    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'plugin_example',
      contributionLocalId: 'action',
      surface: 'ui',
      externalActor: { kind: 'human', displayNameSnapshot: 'never disclosed here' },
      contentProvenance: 'forwarded',
    })).toBe('external_human');
    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'plugin_example',
      contributionLocalId: 'action',
      surface: 'ui',
      externalActor: { kind: 'bot' },
      contentProvenance: 'viaBot',
    })).toBe('plugin');
    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'host',
      producer: 'externalSessionHistory',
    })).toBe('recovered_history');
    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'happierSession',
      sourceSessionId: 'session_other',
      via: 'mcp',
    })).toBe('unknown');
    expect((project as (value: unknown) => unknown)({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'plugin_example',
      contributionLocalId: 'action',
      surface: 'ui',
      sourceRef: 'source-reference-must-not-leak',
      sourceRevisionOrEpoch: 'revision-must-not-leak',
    })).toBe('plugin');
  });
});
