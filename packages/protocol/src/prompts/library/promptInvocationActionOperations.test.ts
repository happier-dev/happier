import { describe, expect, it, vi } from 'vitest';
import { createPromptInvocationInLibrary, resolvePromptInvocationInLibrary } from './promptInvocationActionOperations.js';
import type { PromptLibraryRecordV1 } from './promptLibraryRowsV1.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';
import type { PromptLibraryStoredArtifact } from './promptLibraryActionOperations.js';

describe('prompt invocation Action resolution', () => {
  it('appends through the current catalog CAS, validates collisions and retains a durable receipt after retirement', async () => {
    let record: PromptLibraryRecordV1 = { key: 'invocations', value: { v: 1, extension: 'kept', entries: [
      { id: 'neighbor', token: '/existing', title: 'Existing', target: { kind: 'doc', artifactId: 'old' }, behavior: 'insert', allowArgs: false, availableIn: 'global' },
    ] } };
    let revision = 4;
    let current = true;
    const port = { serverId: 'home', assertCurrent() { if (!current) throw new Error('retired'); },
      readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }) => {
        if (input.expectedRevision !== revision) return { status: 'conflict' as const, revision };
        record = input.record; revision++; current = false;
        return { status: 'updated' as const, revision, cursor: revision };
      },
    };
    const create = (token: string) => createPromptInvocationInLibrary({ port, request: { token, title: 'New',
      target: { kind: 'doc', artifactId: 'new', serverId: 'home' } }, invocationId: 'new', actionTokens: ['/next'] });
    expect(await create('EXISTING')).toEqual({ status: 'invalid', reason: 'duplicate' });
    expect(await create('clear')).toEqual({ status: 'invalid', reason: 'reserved' });
    expect(await create('Next')).toEqual({ status: 'invalid', reason: 'actionCollision' });
    expect(await create('new')).toEqual({ status: 'updated', invocationId: 'new', token: '/new', revision: 5 });
    expect(record.value).toMatchObject({ extension: 'kept', entries: [
      { id: 'neighbor', target: { kind: 'doc', artifactId: 'old' } }, { id: 'new', token: '/new', target: { serverId: 'home' } },
    ] });
  });
  it('reports a concurrent row winner without rebasing or overwriting it', async () => {
    const winner = { id: 'winner', token: '/winner', title: 'Winner', target: { kind: 'doc' as const, artifactId: 'winner' }, behavior: 'insert' as const, allowArgs: false, availableIn: 'global' as const };
    let record: PromptLibraryRecordV1 = { key: 'invocations', value: { v: 1, entries: [] } };
    const outcome = await createPromptInvocationInLibrary({ invocationId: 'loser', actionTokens: [],
      request: { token: 'loser', title: 'Loser', target: { kind: 'doc', artifactId: 'loser' } }, port: {
        serverId: 'home', assertCurrent() {}, readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision: 4 }], tombstones: [], diagnostics: [] } }),
        writeRecord: async () => { record = { key: 'invocations', value: { v: 1, entries: [winner] } }; return { status: 'conflict', revision: 5 }; },
      } });
    expect(outcome).toEqual({ status: 'conflict', revision: 5 });
    expect(record.value).toEqual({ v: 1, entries: [winner] });
  });
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
