import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

async function seed(boundary: ReturnType<typeof createArtifactStoreBoundary>, id: string) {
  await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: id }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: id, createdAtMs: 1, updatedAtMs: 1 }) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
  }) });
}

describe('prompt editor deletion authority', () => {
  it('deletes only the reviewed selected-Home document while preserving required references and other Home content', async () => {
    const libraryUrl = 'https://delete-library-home.test';
    const otherUrl = 'https://delete-other-home.test';
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [
      { id: 'session.instructions', ref: { kind: 'doc', artifactId: 'same-doc' }, enabled: true, placement: 'system_append', required: true },
    ] } }] });
    fixture = await createPlainArtifactHomeFixture(libraryUrl, { handleRequest: catalog.handle });
    await seed(fixture.boundary, 'same-doc'); await seed(fixture.boundary, 'neighbor');
    const other = createArtifactStoreBoundary({ ownerAccountId: () => 'artifact-account', encryptionMode: 'plain' });
    await seed(other, 'same-doc');
    const beforeReferences = catalog.read('coding');
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
      const path = `${url.pathname}${url.search}`;
      if (url.origin === libraryUrl) return await catalog.handle(path, init) ?? await fixture!.boundary.handle(path, init) ?? Response.json({}, { status: 404 });
      if (url.origin === otherUrl) return await other.handle(path, init) ?? Response.json({}, { status: 404 });
      throw new Error(`Unexpected Home ${url.origin}`);
    });
    const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const active = await upsertAndActivateServer({ serverUrl: otherUrl, scope: 'device' });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ artifacts: {}, settingsScope: { serverId: active.id, accountId: 'artifact-account' }, profileScope: { serverId: active.id, accountId: 'artifact-account' } });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { usePromptLibraryEntryActions } = await import('./usePromptLibraryEntryActions');
    const hook = await renderHook(() => usePromptLibraryEntryActions('doc', { serverId: fixture!.home.id,
      accountId: 'artifact-account' }));
    expect(await hook.getCurrent().remove('same-doc')).toBe(true);
    expect(fixture.boundary.read('same-doc')).toBeNull();
    expect(fixture.boundary.read('neighbor')).not.toBeNull();
    expect(other.read('same-doc')).not.toBeNull();
    expect(catalog.read('coding')).toEqual(beforeReferences);
    expect(catalog.requests).toEqual([]);
  });
});
