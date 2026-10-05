import { describe, expect, it, vi } from 'vitest';
import { resolvePromptInvocationInLibrary } from './promptInvocationActionOperations.js';

describe('prompt invocation Action resolution', () => {
  it('enforces session-only admission before reading, then renders through the canonical document reader', async () => {
    const invocations = { v: 1, entries: [{ id: 'local', token: '/local', title: 'Local', availableIn: 'session_only', allowArgs: true, target: { kind: 'doc', artifactId: 'doc' } }] };
    const read = vi.fn(async () => ({ id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }, body: JSON.stringify({ v: 1, markdown: 'Use $ARGUMENTS', createdAtMs: 1, updatedAtMs: 1 }) }));
    const store = { read, update: async () => {} };
    expect(await resolvePromptInvocationInLibrary({ invocations, store, request: { invocationId: 'local' }, sessionId: null })).toEqual({ status: 'unavailable', invocationId: 'local' });
    expect(read).not.toHaveBeenCalled();
    expect(await resolvePromptInvocationInLibrary({ invocations, store, request: { invocationId: 'local', argsText: 'text' }, sessionId: 'live' })).toMatchObject({ status: 'resolved', text: 'Use text' });
    expect(await resolvePromptInvocationInLibrary({ invocations, store: { ...store, read: async () => ({ ...(await read()), header: { kind: 'role.v1', title: 'Other' } }) }, request: { invocationId: 'local' }, sessionId: 'live' })).toEqual({ status: 'unavailable', invocationId: 'local' });
  });
});
