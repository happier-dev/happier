import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { storage } from '@/sync/domains/state/storage';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { createArtifactStoreBoundary, createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { withUiPromptLibraryArtifactReader, createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { listPromptInvocationsForActions, resolvePromptInvocationForActions } from './resolvePromptInvocations';

describe('Account-bound prompt invocations', () => {
  let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
  beforeEach(async () => { fixture = await createPlainArtifactHomeFixture('https://prompt-invocations.example'); });
  afterEach(() => { fixture.dispose(); resetPromptLibraryCatalogSnapshotsForTests(); });
  const entries = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `prompt-${index}`, token: `/prompt-${index}`, title: `Prompt ${index}`,
    target: { kind: 'doc' as const, artifactId: `artifact-${index}` },
    behavior: 'insert' as const, allowArgs: false, availableIn: 'global' as const,
  }));
  function admit(count: number) {
    const record = PromptLibraryRecordV1Schema.parse({ key: 'invocations', value: { v: 1, entries: entries(count) } });
    applyPromptLibraryCatalogSnapshot({ serverId: fixture.home.id, accountId: 'artifact-account' }, {
      catalog: { status: 'ready', rows: [{ record, revision: 7 }], tombstones: [], diagnostics: [] },
      rawSettings: { promptInvocationsV1: { v: 1, entries: entries(2) } }, sourceSettingsVersion: 3,
    }, true);
  }
  it('lists the complete current catalog beyond a single transport page', () => {
    admit(501);
    const result = listPromptInvocationsForActions({});
    expect(result.coverage).toBe('complete');
    expect(result.items).toHaveLength(501);
    expect(result.items.at(-1)?.id).toBe('prompt-500');
  });
  it('marks an explicitly limited projection as truncated', () => {
    admit(2);
    expect(listPromptInvocationsForActions({ limit: 1 })).toMatchObject({ coverage: 'truncated', items: [{ id: 'prompt-0' }] });
  });
  it('does not resurrect stale Settings when the destination catalog is empty', async () => {
    storage.setState({ settings: { ...storage.getState().settings, promptInvocationsV1: { v: 1, entries: entries(2) } } });
    admit(0);
    expect(listPromptInvocationsForActions({})).toEqual({ items: [], coverage: 'complete' });
    await expect(resolvePromptInvocationForActions({ invocationId: 'prompt-1' })).resolves.toMatchObject({ status: 'unknownInvocation' });
  });
  it('keeps unavailable Account catalog state distinct from deletion', async () => {
    storage.setState({ settings: { ...storage.getState().settings, promptInvocationsV1: { v: 1, entries: entries(2) } } });
    expect(listPromptInvocationsForActions({})).toEqual({ items: [], coverage: 'unavailable' });
    await expect(resolvePromptInvocationForActions({ invocationId: 'prompt-1' })).resolves.toMatchObject({ status: 'unavailable' });
  });
  it('resolves identical Artifact ids through their qualified Home reader', async () => {
    const otherUrl = 'https://prompt-invocations-other.example';
    const otherHome = await upsertServerProfileOnly({ serverUrl: otherUrl });
    const otherBoundary = createArtifactStoreBoundary({ ownerAccountId: () => 'other-account', encryptionMode: 'plain' });
    const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => ({ token: token(url === otherUrl ? 'other-account' : 'artifact-account') }));
    for (const [boundary, markdown] of [[fixture.boundary, 'Alpha current'], [otherBoundary, 'Bravo current']] as const) {
      await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'same-id',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
    }
    let retireDuringOtherBody = false;
    let retirementObserved = false;
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      const accountId = url.origin === otherUrl ? 'other-account' : 'artifact-account';
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${token(accountId)}`) return new Response('{}', { status: 401 });
      if (url.pathname === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
      if (url.pathname === '/v1/account/encryption/currentness') return new Response(JSON.stringify({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }));
      if (retireDuringOtherBody && url.origin === otherUrl && url.pathname === '/v1/artifacts/same-id') {
        retireActiveServerAccountScopeLifetime();
        retirementObserved = true;
      }
      const boundary = url.origin === otherUrl ? otherBoundary : fixture.boundary;
      return await boundary.handle(`${url.pathname}${url.search}`, init) ?? new Response('{}', { status: 404 });
    });
    const invocations = { v: 1, entries: [fixture.home.id, otherHome.id].map((serverId, index) => ({ id: `qualified-${index}`,
      token: `/qualified-${index}`, title: 'Qualified', target: { kind: 'doc', artifactId: 'same-id', serverId } })) };
    const account = await captureLazyActionAccountContext(fixture.home.id);
    try {
      await withUiPromptLibraryArtifactReader(async (reader) => {
        const source = { invocations, store: createUiPromptLibraryArtifactStore(account.workflowArtifacts), readArtifact: reader.readArtifact,
          assertCurrent: account.assertCurrent };
        expect(await resolvePromptInvocationForActions({ invocationId: 'qualified-0' }, source)).toMatchObject({ status: 'resolved', text: 'Alpha current' });
        expect(await resolvePromptInvocationForActions({ invocationId: 'qualified-1' }, source)).toMatchObject({ status: 'resolved', text: 'Bravo current' });
        retireDuringOtherBody = true;
        const retiredResult = await resolvePromptInvocationForActions({ invocationId: 'qualified-1' }, source);
        expect(retirementObserved).toBe(true);
        expect(retiredResult).toEqual({ status: 'unavailable', invocationId: 'qualified-1' });
      }, { accountContext: account });
    } finally { account.dispose(); }
  });
});
