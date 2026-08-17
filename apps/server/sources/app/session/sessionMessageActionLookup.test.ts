import { describe, expect, it, vi } from 'vitest';

import * as sessionMessageActionLookup from './sessionMessageActionLookup';
import {
  issueSessionMessageActionReference,
  resolveSessionMessageActionLookup,
} from './sessionMessageActionLookup';

describe('session Message Action lookup', () => {
  const input = {
    actorUserId: 'account-reader',
    sessionId: 'session-1',
    messageId: 'message-durable-1',
  } as const;

  const currentRow = {
    id: input.messageId,
    sessionId: input.sessionId,
    seq: 8,
    messageRole: 'agent',
    updatedAt: new Date('2026-08-09T08:00:00.000Z'),
  } as const;

  const currentReference = issueSessionMessageActionReference({
    sessionId: input.sessionId,
    messageId: input.messageId,
    updatedAt: currentRow.updatedAt,
  });

  if (!currentReference) throw new Error('Expected a valid Message Action reference fixture');

  it('returns unavailable when a current-participant row lookup misses and Session access is gone', async () => {
    const readMessage = vi.fn(async () => null);
    const readPublication = vi.fn(async () => ({ currentStorageState: 'hosted' }));

    await expect(resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => false,
      readMessage,
      readPublication,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(readMessage).toHaveBeenCalled();
    expect(readPublication).not.toHaveBeenCalled();
  });

  it('returns only current durable row facts and keeps deletion/compaction exact after access', async () => {
    const deleted = await resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => null,
      readPublication: async () => ({ currentStorageState: 'hosted' }),
    });
    expect(deleted).toEqual({ status: 'deleted' });

    const compacted = await resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => currentRow,
      readPublication: async () => ({
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: 7,
      }),
    });
    expect(compacted).toEqual({ status: 'compacted' });

    const available = await resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => currentRow,
      readPublication: async () => ({ currentStorageState: 'hosted' }),
    });
    expect(available).toEqual({
      status: 'available',
      message: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        seq: 8,
        messageRole: 'agent',
        observedRevision: currentReference.observedRevision,
      },
    });
    expect(JSON.stringify(available)).not.toContain('content');
  });

  it('fails closed when a reader yields malformed identity or publication facts', async () => {
    await expect(resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => ({ ...currentRow, id: 'different-message' }),
      readPublication: async () => ({ currentStorageState: 'hosted' }),
    })).resolves.toEqual({ status: 'unavailable' });

    await expect(resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => currentRow,
      readPublication: async () => ({
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: 'not-a-sequence',
      }),
    })).resolves.toEqual({ status: 'compacted' });
  });

  it('rejects a stale durable revision after access without letting a prior reference authorize current dispatch', async () => {
    const updatedRow = {
      ...currentRow,
      updatedAt: new Date('2026-08-09T08:00:00.001Z'),
    };

    await expect(resolveSessionMessageActionLookup({
      ...input,
      reference: currentReference,
      readAccess: async () => true,
      readMessage: async () => updatedRow,
      readPublication: async () => ({ currentStorageState: 'hosted' }),
    })).resolves.toEqual({ status: 'stale' });
  });

  it('prepares the private row-revision reference codec without activating it over the timestamp issuer', () => {
    const issueRowRevisionReference = Reflect.get(
      sessionMessageActionLookup,
      'issueSessionMessageRowRevisionActionReference',
    ) as ((params: {
      sessionId: string;
      messageId: string;
      rowRevision: unknown;
    }) => { observedRevision: string } | null) | undefined;
    const parseRowRevision = Reflect.get(
      sessionMessageActionLookup,
      'parseSessionMessageRowRevisionActionReference',
    ) as ((observedRevision: unknown) => bigint | null) | undefined;

    expect(issueRowRevisionReference).toBeTypeOf('function');
    expect(parseRowRevision).toBeTypeOf('function');
    if (!issueRowRevisionReference || !parseRowRevision) return;

    const prepared = issueRowRevisionReference({
      sessionId: input.sessionId,
      messageId: input.messageId,
      rowRevision: BigInt(0),
    });
    expect(prepared).toMatchObject({
      observedRevision: 'session-message-row-revision:v1:0',
    });
    expect(parseRowRevision(prepared?.observedRevision)).toBe(BigInt(0));
    expect(parseRowRevision('session-message-row-revision:v1:42')).toBe(BigInt(42));
    expect(parseRowRevision('session-message-row-revision:v1:042')).toBeNull();
    expect(parseRowRevision('message-updated-at:0')).toBeNull();

    expect(issueSessionMessageActionReference({
      sessionId: input.sessionId,
      messageId: input.messageId,
      updatedAt: currentRow.updatedAt,
    })).toMatchObject({ observedRevision: 'message-updated-at:1786262400000' });
  });

  it('fails closed before lookup when the opaque reference is malformed', async () => {
    const readAccess = vi.fn(async () => true);
    const readMessage = vi.fn(async () => currentRow);

    await expect(resolveSessionMessageActionLookup({
      ...input,
      reference: { ...currentReference, observedRevision: '' },
      readAccess,
      readMessage,
      readPublication: async () => ({ currentStorageState: 'hosted' }),
    })).resolves.toEqual({ status: 'unavailable' });
    expect(readAccess).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();
  });
});
