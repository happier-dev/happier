import { afterEach, describe, expect, it, vi } from 'vitest';
import { updatePromptDocInLibrary } from '@happier-dev/protocol';

// Sync loads renderer bindings, but this Artifact-only suite never renders markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
  splitStreamingRevealTextParts: () => { throw new Error('Unexpected markdown rendering in Artifact test'); },
}));

import type { DecryptedArtifact, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storage';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { uiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { updateSkillPromptBundleWithEntry, removeSkillPromptBundleEntry } from './promptBundles';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';

describe('UI prompt-library Artifact CAS', () => {
  const originalCredentials = Reflect.get(sync, 'credentials');
  const initialState = storage.getState();

  afterEach(() => {
    resetRuntimeFetch();
    Reflect.set(sync, 'credentials', originalCredentials);
    storage.setState(initialState, true);
    vi.restoreAllMocks();
  });

  it('rejects another Artifact kind even when it has a prompt-shaped body', async () => {
    const artifact: DecryptedArtifact = {
      id: 'other', title: 'Other', header: { v: 1, kind: 'role.v1', title: 'Other' },
      body: JSON.stringify({ v: 1, markdown: 'Must not disclose', createdAtMs: 1, updatedAtMs: 1 }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      isDecrypted: true, storageMode: 'plain',
    };
    storage.setState({ artifacts: { other: artifact } });
    await expect(expandPromptTemplateInvocation({ targetArtifactId: 'other', argsText: '' })).rejects.toThrow();
  });

  it('refuses a retired caller before an Artifact read or write reaches HTTP', async () => {
    Reflect.set(sync, 'credentials', { token: 'prompt-cas-token' });
    const request = vi.fn(async () => Response.json({}));
    setRuntimeFetch(request);
    const controller = new AbortController();
    controller.abort();
    await expect(uiPromptLibraryArtifactStore.read('prompt-race', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(uiPromptLibraryArtifactStore.update({
      artifactId: 'prompt-race', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      header: { title: 'Retired' }, body: 'retired', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves a concurrent write through the real sync and Artifact API owners', async () => {
    Reflect.set(sync, 'credentials', { token: 'prompt-cas-token' });
    const original: DecryptedArtifact = {
      id: 'prompt-race', title: 'Original', header: { v: 1, kind: 'prompt_doc.v2', title: 'Original' },
      body: JSON.stringify({ v: 1, markdown: 'original', createdAtMs: 1, updatedAtMs: 1 }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      isDecrypted: true, storageMode: 'plain',
    };
    const concurrent: DecryptedArtifact = { ...original,
      title: 'Concurrent', header: { ...original.header, title: 'Concurrent' },
      body: JSON.stringify({ v: 1, markdown: 'concurrent', createdAtMs: 1, updatedAtMs: 2 }),
      headerVersion: 2, bodyVersion: 2,
    };
    storage.setState({ artifacts: { [original.id]: original } });
    let persisted = concurrent;
    setRuntimeFetch(async (_input, init) => {
      if (init?.method !== 'POST') return Response.json({ mode: 'plain', updatedAt: 0 });
      const request = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
      if ((request.header !== undefined && request.expectedHeaderVersion !== persisted.headerVersion)
        || (request.body !== undefined && request.expectedBodyVersion !== persisted.bodyVersion)) {
        return Response.json({ success: false, error: 'version-mismatch' });
      }
      persisted = { ...persisted, title: 'Stale overwrite' };
      return Response.json({ success: true, headerVersion: 3, bodyVersion: 3 });
    });

    await expect(updatePromptDocInLibrary({
      store: uiPromptLibraryArtifactStore,
      request: { artifactId: original.id, title: 'Stale overwrite', markdown: 'stale' },
      nowMs: () => { storage.getState().updateArtifact(concurrent); return 3; },
    })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(persisted).toEqual(concurrent);
    expect(storage.getState().artifacts[original.id]).toEqual(concurrent);
  });

  it.each(['update', 'remove'] as const)('refuses a stale supporting-entry %s without rebasing the bundle revision', async (operation) => {
    Reflect.set(sync, 'credentials', { token: 'prompt-cas-token' });
    const body = { v: 1, entries: [
      { path: 'SKILL.md', contentBase64: 'IyBTa2lsbA==', contentKind: 'utf8' },
      { path: 'notes.md', contentBase64: 'b3JpZ2luYWw=', contentKind: 'utf8' },
    ], createdAtMs: 1, updatedAtMs: 1 };
    const original: DecryptedArtifact = {
      id: 'bundle-race', title: 'Original', header: { v: 1, kind: 'prompt_bundle.v2', title: 'Original', bundleSchemaId: 'skills.skill_md_v1' },
      body: JSON.stringify(body), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      isDecrypted: true, storageMode: 'plain',
    };
    const concurrent: DecryptedArtifact = { ...original,
      title: 'Concurrent', header: { ...original.header, title: 'Concurrent' },
      body: JSON.stringify({ ...body, updatedAtMs: 2 }), headerVersion: 2, bodyVersion: 2,
    };
    storage.setState({ artifacts: { [original.id]: original } });
    let persisted = concurrent;
    setRuntimeFetch(async (_input, init) => {
      if (init?.method !== 'POST') return Response.json({ mode: 'plain', updatedAt: 0 });
      const request = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
      if ((request.header !== undefined && request.expectedHeaderVersion !== persisted.headerVersion)
        || (request.body !== undefined && request.expectedBodyVersion !== persisted.bodyVersion)) {
        return Response.json({ success: false, error: 'version-mismatch' });
      }
      persisted = { ...persisted, body: 'overwritten' };
      return Response.json({ success: true, headerVersion: 3, bodyVersion: 3 });
    });
    vi.spyOn(Date, 'now').mockImplementationOnce(() => { storage.getState().updateArtifact(concurrent); return 3; });
    const mutation = operation === 'update'
      ? updateSkillPromptBundleWithEntry({ artifactId: original.id, path: 'notes.md', content: 'stale' })
      : removeSkillPromptBundleEntry({ artifactId: original.id, path: 'notes.md' });
    await expect(mutation).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(persisted).toEqual(concurrent);
    expect(storage.getState().artifacts[original.id]).toEqual(concurrent);
  });
});
