import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { beginPromptLibraryCatalogRowsLoad, getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { storage } from '@/sync/domains/state/storage';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptDocEditorScreen } from './PromptDocEditorScreen';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), preventRemove: false }));
const modal = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation, navigation: { canGoBack: () => false } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: key => key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true, spies: { alert: modal.alert } }).module;
});
// Native navigation interception is external to the editor's draft/save owner.
vi.mock('@react-navigation/native', async importOriginal => ({
  ...await importOriginal<typeof import('@react-navigation/native')>(),
  ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
  usePreventRemove: (prevent: boolean) => { navigation.preventRemove = prevent; },
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let catalog = createPromptLibraryCatalogBoundary();
// The browser-hosted Monaco adapter is a platform boundary. With no installed
// Monaco API it uses its real text-input fallback; draft/save logic stays real.
beforeEach(async () => { await loadSyncSingletonForTests(); vi.stubGlobal('window', {}); navigation.push.mockClear(); navigation.replace.mockClear(); navigation.back.mockClear(); navigation.preventRemove = false; modal.alert.mockClear(); });
afterEach(async () => {
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await fixture?.dispose(); fixture = undefined; vi.unstubAllGlobals();
});

async function home(records: readonly PromptLibraryRecordV1[] = []) {
  catalog = createPromptLibraryCatalogBoundary({ records });
  fixture = await createPlainArtifactHomeFixture('https://reviewed-prompt-editor.test', { handleRequest: catalog.handle });
  return fixture;
}

describe('PromptDocEditorScreen', () => {
  it('exports the saved Markdown through the editor menu without changing its unsaved draft', async () => {
    const f = await home();
    const markdown = '# Saved instructions\n\nReview the change.\n';
    const id = await createPromptDoc({ title: 'Review instructions', markdown });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Review instructions'); });
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Unsaved title'); });
    const blobs: Blob[] = [];
    const downloaded: string[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:prompt'; });
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
      const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
      return anchor;
    } });
    try {
      const menu = screen.findByType(PageHeaderMenu).props.actions as readonly PageHeaderMenuAction[];
      const exportAction = menu.find(action => action.id === 'export');
      expect(exportAction).toBeDefined();
      await act(async () => { await exportAction!.onSelect(); });
      expect(downloaded).toEqual(['Review instructions.md']);
      expect(await blobs[0]?.text()).toBe(markdown);
      expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Unsaved title');
      expect(f.boundary.list()).toHaveLength(1);
      expect(modal.alert).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });
  it.each(['unavailable', 'stale'] as const)('saves a new unfiled document with a %s folder catalog', async state => {
    const f = state === 'stale' ? await home() : await createPlainArtifactHomeFixture('https://prompt-editor-folder-outage.test', {
      handleRequest: async (path, init) => path.startsWith('/v1/account/entity-rows/prompt-library')
        ? Response.json({ error: 'unavailable' }, { status: 503 }) : catalog.handle(path, init),
    });
    fixture = f;
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={null} />);
    await vi.waitFor(() => expect(screen.findByTestId('promptDoc.title')?.props.editable).toBe(true));
    if (state === 'stale') {
      await vi.waitFor(() => expect(screen.findByTestId('promptDoc.folderName')?.props.editable).toBe(true));
      await act(async () => {
        screen.changeTextByTestId('promptDoc.folderName', '  ');
        screen.changeTextByTestId('promptDoc.tags', ', ');
        beginPromptLibraryCatalogRowsLoad(storage.getState().profileScope!, ['folders']);
      });
    } else {
      await vi.waitFor(() => expect(getPromptLibraryCatalogValue(storage.getState().profileScope, 'folders').status).toBe('unavailable'));
    }
    expect(screen.findByTestId('promptDoc.folderName')?.props.editable).toBe(false);
    expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(false);
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Unfiled draft'); });
    expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(() => expect(f.boundary.list()).toHaveLength(1));
    expect(JSON.parse(f.boundary.readPlainBody(f.boundary.list()[0].id)!)).toMatchObject({ markdown: '' });
    expect(navigation.replace).toHaveBeenCalled();
    expect(modal.alert).not.toHaveBeenCalled();
  });

  it.each(['folderName', 'tags'] as const)('visibly refuses a retained %s draft while its catalog is stale', async field => {
    const f = await home();
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={null} />);
    await vi.waitFor(() => expect(screen.findByTestId(`promptDoc.${field}`)?.props.editable).toBe(true));
    await act(async () => {
      screen.changeTextByTestId('promptDoc.title', 'Placed draft');
      screen.changeTextByTestId(`promptDoc.${field}`, 'Keep placement');
      beginPromptLibraryCatalogRowsLoad(storage.getState().profileScope!, ['folders']);
    });
    expect(screen.findByTestId(`promptDoc.${field}`)?.props.editable).toBe(false);
    await screen.pressByTestIdAsync('promptDoc.save');
    expect(modal.alert).toHaveBeenCalledWith('common.error', 'promptLibrary.saveError');
    expect(f.boundary.list()).toHaveLength(0);
    expect(screen.findByTestId(`promptDoc.${field}`)?.props.value).toBe('Keep placement');
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves existing placement during refresh when its clearing draft is %s', async clearPlacement => {
    const f = await home([{ key: 'folders', value: { v: 1, folders: [{ id: 'ops', name: 'Ops' }] } }]);
    const id = await createPromptDoc({ title: 'Filed prompt', markdown: 'Saved content', folderId: 'ops' });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(() => expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('Ops'));
    await act(async () => {
      if (clearPlacement) screen.changeTextByTestId('promptDoc.folderName', '');
      else screen.changeTextByTestId('promptDoc.title', 'Content-only edit');
      beginPromptLibraryCatalogRowsLoad(storage.getState().profileScope!, ['folders']);
    });
    await screen.pressByTestIdAsync('promptDoc.save');
    if (clearPlacement) {
      expect(modal.alert).toHaveBeenCalledWith('common.error', 'promptLibrary.saveError');
      expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('');
    } else {
      expect(modal.alert).not.toHaveBeenCalled();
      expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({ title: 'Content-only edit' });
    }
    expect(catalog.read('folders')).toMatchObject({ value: { artifactHeadersById: { [id]: { folderId: 'ops' } } } });
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Saved content' });
  });

  it('refuses an unconfirmed editor snapshot while preserving the prompt draft and saved bytes', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Instructions', markdown: 'Saved markdown' });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Instructions'); });
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Draft title'); });
    const { MarkdownCodeEditorField } = await import('@/components/ui/markdown/editor/MarkdownCodeEditorField');
    const handle = screen.findByType(MarkdownCodeEditorField).props.editorRef.current;
    const flush = vi.spyOn(handle, 'flushPendingChange').mockRejectedValueOnce(new Error('snapshot_unconfirmed'));
    try {
      await screen.pressByTestIdAsync('promptDoc.save');
      expect(modal.alert).toHaveBeenCalledWith('common.error', 'promptLibrary.saveError');
      expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Draft title');
      expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Saved markdown' });
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(navigation.back).not.toHaveBeenCalled();
    } finally { flush.mockRestore(); await screen.unmount(); }
  });

  it('creates a real new draft and opens its saved document without an unsaved-navigation decision', async () => {
    const f = await home();
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={null} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.editable).toBe(true); });
    expect(screen.findByTestId('promptDoc.editor')).toBeTruthy();
    expect(screen.findByTestId('promptDoc.folderName')).toBeTruthy();
    expect(screen.findByTestId('promptDoc.tags')).toBeTruthy();
    expect(screen.findAllByTestId('promptDoc.manageExternalAssets')).toHaveLength(0);
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Fresh'); });
    expect(navigation.preventRemove).toBe(true);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false); });
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(async () => { await flushHookEffects(); expect(f.boundary.list()).toHaveLength(1); });
    const saved = f.boundary.list().find(row => JSON.parse(f.boundary.readPlainBody(row.id) ?? '{}').markdown === '');
    expect(saved).toBeDefined();
    await vi.waitFor(async () => { await flushHookEffects(); expect(navigation.replace).toHaveBeenCalledWith(`/settings/prompts/docs/${saved!.id}?serverId=${encodeURIComponent(f.home.id)}`); });
    expect(navigation.back).not.toHaveBeenCalled();
    expect(navigation.preventRemove).toBe(false);
  });

  it('keeps retired export receipts unexposed and preserves every dirty field when the folder row refreshes', async () => {
    const f = await home([{ key: 'folders', value: { v: 1, folders: [{ id: 'ops', name: 'Ops' }] } }]);
    const id = await createPromptDoc({ title: 'Organized', markdown: 'Original', folderId: 'ops', tags: ['alpha', 'beta'] });
    const { writePromptLibraryRecord } = await import('@/sync/api/account/apiPromptLibraryCatalog');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = storage.getState().profileScope!;
    await writePromptLibraryRecord(scope, { expectedRevision: catalog.revision('external-links'), record: { key: 'external-links', value: { v: 1, links: [{
      id: 'link', artifactId: id, assetTypeId: 'claude.command', machineId: 'machine-1', scope: 'user', workspacePath: null,
      externalRef: { relativePath: 'review/code.md' }, lastExternalDigest: 'digest',
    }] } } });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('Ops'); });
    expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe('alpha, beta');
    expect(screen.findAllByTestId('promptDoc.link.0')).toHaveLength(0);
    expect(screen.findAllByTestId('promptDoc.manageExternalAssets')).toHaveLength(0);
    expect(screen.findAllByType(PageHeaderMenu)[0]?.props.actions.map((action: PageHeaderMenuAction) => action.id))
      .toEqual(['duplicate', 'export', 'delete']);
    expect(screen.findAll(node => Array.isArray(node.props.meta)
      && node.props.meta.some((fact: Readonly<{ key: string }>) => fact.key === 'exports'))).toHaveLength(0);
    expect(catalog.read('external-links')).toMatchObject({ value: { links: [{ id: 'link', assetTypeId: 'claude.command' }] } });
    await act(async () => {
      screen.changeTextByTestId('promptDoc.title', 'Draft title');
      screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Draft markdown');
      screen.changeTextByTestId('promptDoc.folderName', 'Draft folder');
      screen.changeTextByTestId('promptDoc.tags', 'draft, tags');
    });
    expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Draft title');
    const folders = catalog.read('folders');
    if (folders.key !== 'folders') throw new Error('Wrong domain');
    await act(async () => { await writePromptLibraryRecord(scope, { expectedRevision: catalog.revision('folders'),
      record: { key: 'folders', value: { ...folders.value, folders: [{ id: 'ops', name: 'Renamed Ops' }] } } }); });
    await flushHookEffects();
    expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Draft title');
    expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Draft markdown');
    expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('Draft folder');
    expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe('draft, tags');
  });

  it('edits the explicitly selected Home while a different Home is active', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Selected Home', markdown: 'Selected instructions' });
    const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const other = await upsertAndActivateServer({ serverUrl: 'https://other-prompt-home.test', scope: 'device' });
    const accountId = storage.getState().profileScope!.accountId;
    storage.setState({ artifacts: {}, settingsScope: { serverId: other.id, accountId }, profileScope: { serverId: other.id, accountId } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} serverId={f.home.id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Selected Home'); });
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Edited on selected Home'); });
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(async () => { await flushHookEffects(); expect(f.boundary.read(id)?.headerVersion).toBeGreaterThan(1); });
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.back).not.toHaveBeenCalled();
    expect(f.boundary.read(id)?.headerVersion).toBeGreaterThan(1);
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Selected instructions' });
    expect(storage.getState().artifacts[id]).toBeUndefined();
  });

  it('loads the current document, keeps a conflicted draft and uses the accepted revision for repeated saves', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Original', markdown: 'Original' });
    const original = f.boundary.read(id)!;
    const currentWrite = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Current' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Current', createdAtMs: 1, updatedAtMs: 2 }) }),
      expectedHeaderVersion: original.headerVersion, expectedBodyVersion: original.bodyVersion,
      // A concurrent writer binds private metadata to the new body revision.
      provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId: id,
        bodyVersion: original.bodyVersion! + 1, provenance: { savedBy: { kind: 'person', accountId: original.ownerAccountId } } }),
      provenanceDataEncryptionKey: null,
    }) });
    expect(await currentWrite?.json()).toMatchObject({ success: true });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Current'); });
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'First'); });
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(async () => { await flushHookEffects(); expect(f.boundary.read(id)?.headerVersion).toBeGreaterThan(original.headerVersion + 1); });
    await vi.waitFor(async () => { await flushHookEffects(); expect(navigation.preventRemove).toBe(false); });
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Current' });
    const first = f.boundary.read(id)!;
    expect(first.headerVersion).toBeGreaterThan(1);
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Second'); });
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(async () => { await flushHookEffects(); expect(f.boundary.read(id)?.headerVersion).toBeGreaterThan(first.headerVersion); });
    await vi.waitFor(async () => { await flushHookEffects(); expect(navigation.preventRemove).toBe(false); });
    const second = f.boundary.read(id)!;
    expect(second.headerVersion).toBeGreaterThan(first.headerVersion);
    await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Retained draft'); });
    const concurrentWrite = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Concurrent' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Concurrent', createdAtMs: 1, updatedAtMs: 2 }) }),
      expectedHeaderVersion: second.headerVersion, expectedBodyVersion: second.bodyVersion,
      provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId: id,
        bodyVersion: second.bodyVersion! + 1, provenance: { savedBy: { kind: 'person', accountId: second.ownerAccountId } } }),
      provenanceDataEncryptionKey: null,
    }) });
    expect(await concurrentWrite?.json()).toMatchObject({ success: true });
    await screen.pressByTestIdAsync('promptDoc.save');
    // A stale reviewed revision is a conflict the editor explains in place, not a generic failure.
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.conflict')).toBeTruthy(); });
    expect(modal.alert).not.toHaveBeenCalled();
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Concurrent' });
    expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Retained draft');
    expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false);
    // Saving again before reviewing the current version never overwrites it.
    await screen.pressByTestIdAsync('promptDoc.save');
    await flushHookEffects();
    expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Concurrent' });
    expect(screen.findByTestId('promptDoc.conflict')).toBeTruthy();
    // Reviewing shows the current version against the retained draft; the next save is an informed one.
    await screen.pressByTestIdAsync('promptDoc.conflict.line-action');
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.conflict.current')).toBeTruthy(); });
    expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Retained draft');
    await screen.pressByTestIdAsync('promptDoc.save');
    await vi.waitFor(async () => { await flushHookEffects(); expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ markdown: 'Current' }); });
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.conflict')).toBeFalsy(); });
    expect(modal.alert).not.toHaveBeenCalled();
  });
});
