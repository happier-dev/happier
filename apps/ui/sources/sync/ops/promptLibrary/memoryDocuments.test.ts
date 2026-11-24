import { describe, expect, it } from 'vitest';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { memoryDocumentActions, readMemoryActionOutcome, readMemoryCreationReceipt, readMemoryDuplicateReview } from './memoryDocuments';

describe('memory Action receipts', () => {
  it.each([null, 'database_transaction_conflict_exhausted', 'database_transaction_timeout', 'unrecognized_failure'])('retains the first Source-bound memory and recovers without another create after Source failure: %s', async sourceError => {
    const unavailable = sourceError !== null;
    let source: ProjectSourceV1 = { id: 'qa-memory-source', revision: 3, name: 'QA Memory Source', createdByAccountId: 'artifact-account', audience: [],
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'qa/memory', visibility: 'private' }, protocol: 'https' }, attachments: [] };
    let homeId = '';
    let sourceUnavailable = unavailable;
    const fixture = await createPlainArtifactHomeFixture('https://source-first-memory.test', { currentAccount: true,
      handleRequest: async (path, init) => {
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
          actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'memory.remember': ['ui'], 'projects.sources.update': ['ui'] } },
        } } });
        if (path === PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list') return Response.json(createPlainProjectAccountRowListFixture({
          workspaceRefs: [{ id: 'qa-checkout', serverId: homeId, projectKey: 'qa-project', machineId: 'offline-machine',
            rootPath: '/qa/memory', createdAtMs: 1, source: { sourceId: source.id, revision: 3 } }],
        }));
        if (path.startsWith('/v1/projects/sources/' + source.id)) {
          if (init?.method === 'PATCH') {
            if (sourceUnavailable) return Response.json({
              error: sourceError, statusCode: 503,
              ...(sourceError === 'database_transaction_timeout' ? { transactionOutcome: 'rolled_back' } : {}),
            }, { status: 503 });
            const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
            if (input.expectedRevision !== source.revision) return Response.json({ ok: false, error: 'source_conflict', current: source }, { status: 409 });
            if (input.patch.attachment?.kind !== 'attach') throw new Error('Expected attachment');
            source = { ...source, revision: source.revision + 1, attachments: [...(source.attachments ?? []), input.patch.attachment.attachment] };
          }
          return Response.json({ ok: true, source, canManage: true });
        }
        if (path.startsWith('/v1/public-shares?')) return Response.json({ publicShares: [] });
        return null;
      },
    });
    homeId = fixture.home.id;
    try {
      await fixture.hydrateAccountSettings();
      const result = await memoryDocumentActions.rememberInScope({ scope: 'project', projectRef: { serverId: homeId, projectKey: 'qa-project' } },
        { text: 'QA use the canonical context attachment.' }, homeId);
      const failure = { errorCode: sourceError === 'unrecognized_failure' ? 'outcome_unknown' : sourceError };
      expect(result).toMatchObject({ ok: true, result: { attachment: unavailable ? 'conflict' : 'attached', ref: { kind: 'doc', serverId: homeId },
        ...(unavailable ? { attachmentFailure: failure } : {}) } });
      const saved = fixture.boundary.list().filter(row => fixture.boundary.readPlainBody(row.id)?.includes('QA use the canonical context attachment.'));
      expect(saved).toHaveLength(1);
      if (unavailable) {
        const receipt = readMemoryCreationReceipt(result);
        expect(receipt).toMatchObject({ attachment: 'conflict', attachmentFailure: failure,
          factId: expect.any(String) });
        expect(readMemoryActionOutcome(result)).toBe('saved_unattached');
        expect(source.attachments).toEqual([]);
        if (!receipt) throw new Error('Expected saved document receipt');
        sourceUnavailable = false;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('projects.sources.update', { serverId: homeId, sourceId: source.id,
          expectedRevision: source.revision, patch: { attachment: { kind: 'attach', attachment: { purpose: 'context',
            entry: { id: 'project.memory', ref: receipt.ref, enabled: true, placement: 'system_append' } } } } },
        { serverId: homeId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true, result: { ok: true } });
        expect(fixture.boundary.list().filter(row => fixture.boundary.readPlainBody(row.id)?.includes('QA use the canonical context attachment.'))).toHaveLength(1);
      }
      expect(source.attachments).toEqual([{ purpose: 'context', entry: { id: 'project.memory', ref: {
        kind: 'doc', artifactId: saved[0]!.id, serverId: homeId }, enabled: true, placement: 'system_append' } }]);
      expect(fixture.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    } finally { await fixture.dispose(); }
  });
  it('replays an explicit restore choice through the real UI Action and captured Artifact CAS', async () => {
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [
      { id: 'existing', text: 'Use PostgreSQL', createdAtMs: 1, sourceSessionRef: null },
    ], topics: [{ title: 'archive', summary: 'History', facts: [
      { id: 'archived', text: 'Use PostgreSQL', createdAtMs: 0, sourceSessionRef: null },
    ] }] });
    const fixture = await createPlainArtifactHomeFixture('https://memory-restore-choice.test', {
      handleRequest: async path => path.startsWith('/v1/public-shares?') ? Response.json({ publicShares: [] }) : null,
    });
    try {
      await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'memory',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
      await withUiPromptLibraryArtifactStore(async (store, account) => {
        const target = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: account.serverId },
          serverId: account.serverId, accountId: account.accountId, isCurrent: () => true,
          expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        const reviewResult = await memoryDocumentActions.restore(target, 'archived');
        expect(readMemoryActionOutcome(reviewResult)).toBe('review');
        const review = readMemoryDuplicateReview(reviewResult);
        if (!review) throw new Error('Expected duplicate review');
        const restored = await memoryDocumentActions.restore(target, 'archived', undefined, undefined,
          { kind: 'keep_both', expectedRevision: review.revision });
        expect(readMemoryActionOutcome(restored)).toBe('applied');
        const reopened = MemoryDocBodyV1Schema.parse(JSON.parse((await store.read('memory'))!.body!));
        expect(reopened.index.map(fact => fact.id)).toEqual(['existing', 'archived']);
        expect(reopened.topics.find(topic => topic.title === 'archive')?.facts).toEqual([]);
      }, { serverId: fixture.home.id });
    } finally { await fixture.dispose(); }
  });
  it('adds, corrects and forgets a reviewed document through Home storage without a Machine', async () => {
    const fixture = await createPlainArtifactHomeFixture('https://memory-without-machine.test', {
      currentAccount: true,
      handleRequest: async path => path.startsWith('/v1/public-shares?') ? Response.json({ publicShares: [] }) : null,
    });
    try {
      await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'memory',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
      await withUiPromptLibraryArtifactStore(async (store, account) => {
        const target = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: account.serverId },
          serverId: account.serverId, accountId: account.accountId, isCurrent: () => true,
          expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        expect(readMemoryActionOutcome(await memoryDocumentActions.remember(target, { text: 'Prefer PostgreSQL' }))).toBe('applied');
        const added = (await store.read('memory'))!;
        const fact = MemoryDocBodyV1Schema.parse(JSON.parse(added.body!)).index[0]!;
        expect(readMemoryActionOutcome(await memoryDocumentActions.update({ ...target, expectedRevision: added.revision },
          { factId: fact.id, text: 'Prefer PostgreSQL for application data' }))).toBe('applied');
        const corrected = (await store.read('memory'))!;
        const correctedFact = MemoryDocBodyV1Schema.parse(JSON.parse(corrected.body!)).index[0]!;
        expect(correctedFact.text).toBe('Prefer PostgreSQL for application data');
        expect(readMemoryActionOutcome(await memoryDocumentActions.forget({ ...target, expectedRevision: corrected.revision }, correctedFact.id))).toBe('applied');
        const reopened = MemoryDocBodyV1Schema.parse(JSON.parse((await store.read('memory'))!.body!));
        expect(reopened.index).toEqual([]);
        expect(reopened.topics.find(topic => topic.title === 'archive')?.facts.map(saved => saved.text))
          .toEqual(['Prefer PostgreSQL', 'Prefer PostgreSQL for application data']);
      }, { serverId: fixture.home.id });
      expect(fixture.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    } finally { await fixture.dispose(); }
  });
  it('surfaces duplicate review as an unsaved draft with the exact target and revision', () => {
    const review = { ok: false as const, errorCode: 'memory_duplicate_choice_required',
      ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, revision: { headerVersion: 1, bodyVersion: 3 },
      candidates: [{ factId: 'old', text: 'Use PostgreSQL', match: 'related' }] };
    const receipt = { ok: true as const, result: review };
    expect(readMemoryActionOutcome(receipt)).toBe('review');
    expect(readMemoryActionOutcome({ ok: true, result: { ...review, revision: undefined } })).toBe('refused');
  });
  it('distinguishes a durable fact whose scope attachment conflicted from an attached fact', () => {
    const receipt = { ok: true as const, artifactId: 'created-memory', factId: 'saved-fact',
      ref: { kind: 'doc' as const, artifactId: 'created-memory', serverId: 'home-a' } };
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'conflict' } })).toBe('saved_unattached');
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'attached' } })).toBe('applied');
    expect(readMemoryActionOutcome({ ok: false, error: 'version_mismatch', errorCode: 'version_mismatch' })).toBe('conflict');
  });
});
