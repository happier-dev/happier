import { describe, expect, it, vi } from 'vitest';
import { resolvePromptInvocationInLibrary } from './promptInvocationActionOperations.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';
import type { PromptLibraryStoredArtifact } from './promptLibraryActionOperations.js';

describe('prompt invocation Action resolution', () => {
  it('qualifies identical Artifact ids to each invocation target Home', async () => {
    const document = (markdown: string): PromptLibraryStoredArtifact => ({ id: 'same-id',
      revision: { headerVersion: 1, bodyVersion: 1 }, header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
      body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) });
    const invocations = { v: 1, entries: ['alpha', 'bravo'].map(serverId => ({ id: serverId,
      token: `/${serverId}`, title: serverId, target: { kind: 'doc', artifactId: 'same-id', serverId } })) };
    const store = { read: async () => document('Alpha current'), update: async () => {} };
    const readArtifact = async (ref: PromptDocArtifactRefV1) => ref.serverId === 'alpha'
      ? document('Alpha current') : ref.serverId === 'bravo' ? document('Bravo current') : null;
    const resolve = (invocationId: string) => resolvePromptInvocationInLibrary({ invocations, store, readArtifact,
      request: { invocationId }, sessionId: null });
    expect(await resolve('alpha')).toMatchObject({ status: 'resolved', text: 'Alpha current' });
    expect(await resolve('bravo')).toMatchObject({ status: 'resolved', text: 'Bravo current' });
    expect(await resolvePromptInvocationInLibrary({ invocations, store, request: { invocationId: 'bravo' }, sessionId: null }))
      .toEqual({ status: 'unavailable', invocationId: 'bravo' });
  });
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
