import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptDocEditorScreen } from './PromptDocEditorScreen';
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
  return createModalModuleMock({ spies: { alert: modal.alert } }).module;
});
// Native navigation interception is external to the editor's draft/save owner.
vi.mock('@react-navigation/native', async importOriginal => ({
  ...await importOriginal<typeof import('@react-navigation/native')>(), usePreventRemove: (prevent: boolean) => { navigation.preventRemove = prevent; },
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let catalog = createPromptLibraryCatalogBoundary();
// The browser-hosted Monaco adapter is a platform boundary. With no installed
// Monaco API it uses its real text-input fallback; draft/save logic stays real.
beforeEach(() => { vi.stubGlobal('window', {}); navigation.push.mockClear(); navigation.replace.mockClear(); navigation.back.mockClear(); navigation.preventRemove = false; modal.alert.mockClear(); });
afterEach(() => { fixture?.dispose(); fixture = undefined; vi.unstubAllGlobals(); });

async function home(records: readonly PromptLibraryRecordV1[] = []) {
  catalog = createPromptLibraryCatalogBoundary({ records });
  fixture = await createPlainArtifactHomeFixture('https://reviewed-prompt-editor.test', { handleRequest: catalog.handle });
  return fixture;
}

describe('PromptDocEditorScreen', () => {
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

  it('shows real private organization and links, and preserves every dirty field when the folder row refreshes', async () => {
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
    expect(screen.findByTestId('promptDoc.link.0')).toBeTruthy();
    expect(screen.getTextContent()).toContain('machine-1');
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

  it('opens the real linked-assets destination for a saved document', async () => {
    const f = await home();
    const id = await createPromptDoc({ title: 'Exports', markdown: 'Instructions' });
    const screen = await renderScreen(<PromptDocEditorScreen artifactId={id} />);
    await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Exports'); });
    await screen.pressByTestIdAsync('promptDoc.manageExternalAssets');
    expect(navigation.push).toHaveBeenCalledWith(`/(app)/settings/prompts/docs/${id}/export?serverId=${encodeURIComponent(f.home.id)}`);
    expect(f.boundary.read(id)).not.toBeNull();
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
    expect(screen.findByTestId('promptDoc.conflict')).toBeFalsy();
    expect(modal.alert).not.toHaveBeenCalled();
  });
});
