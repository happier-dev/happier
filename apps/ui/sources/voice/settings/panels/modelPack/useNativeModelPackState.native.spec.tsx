import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import {
  modelPackDevice as boundary,
  modelPackManifest,
  seedInstalledPack,
  useModelPackDeviceBoundary,
  voiceFilesRoot as root,
} from './modelPackSettings.testHarness';
import { useNativeModelPackState } from './useNativeModelPackState.native';

const packId = 'cancellation-test';
const input = { role: 'stt' as const, packId, manifestUrl: 'https://example.test/manifest.json' };
useModelPackDeviceBoundary();

describe('useNativeModelPackState through device boundaries', () => {
  it('warns when native storage becomes unavailable, falls back, and recovers on a later refresh', async () => {
    seedInstalledPack(packId, 'stt');
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    expect(hook.getCurrent().installed).toBe(true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      boundary.failDocumentPath = true;
      await act(async () => { await hook.getCurrent().refreshInstallState(); });
      expect(hook.getCurrent().installed).toBe(false);
      expect(hook.getCurrent().installSummary).toBeNull();
      expect(hook.getCurrent().modelStatus).toBe('idle');
      expect(warning.mock.calls.some(call => call.some(value =>
        value instanceof Error && value.message === 'storage_unavailable'))).toBe(true);
      expect(boundary.alert).not.toHaveBeenCalled();
      boundary.failDocumentPath = false;
      await act(async () => { await hook.getCurrent().refreshInstallState(); });
      expect(hook.getCurrent().installed).toBe(true);
      expect(hook.getCurrent().modelStatus).toBe('ready');
    } finally {
      warning.mockRestore();
    }
  });

  it('refreshes installed state and reports failure when staging deletion fails after removing the live pack', async () => {
    seedInstalledPack(packId, 'stt');
    const staging = `${root}/modelPackUpdates/${packId}`;
    boundary.files.set(`${staging}/partial.bin`, new Uint8Array(3));
    boundary.failDeleteUri = staging;
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    expect(hook.getCurrent().installed).toBe(true);
    await act(async () => { hook.getCurrent().clearAssets(); });
    await vi.waitFor(() => expect(hook.getCurrent().installed).toBe(false));
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(3);
    expect(boundary.alert.mock.calls.some(call => String(call[1]).includes('storage_delete_failed'))).toBe(true);
    expect(boundary.files.has(`${root}/modelPacks/${packId}/pack.json`)).toBe(false);
  });

  it.each(['prepare', 'update'] as const)('admits only one %s operation from the same rendered callback', async operation => {
    if (operation === 'update') seedInstalledPack(packId, 'stt');
    const release = createDeferred<void>();
    boundary.fetch.mockImplementation(async () => {
      await release.promise;
      return operation === 'update'
        ? Response.json(modelPackManifest(packId, 'stt', 'a'.repeat(64)))
        : new Response(null, { status: 503 });
    });
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    await act(async () => {
      const invoke = operation === 'prepare' ? hook.getCurrent().prepareModel : hook.getCurrent().checkForUpdates;
      const operations = [invoke(), invoke()];
      release.resolve();
      await Promise.all(operations);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(boundary.fetch).toHaveBeenCalledTimes(1);
    expect(boundary.alert).toHaveBeenCalledTimes(1);
  });

  it('keeps preparation out of a pending deletion confirmation', async () => {
    boundary.files.set(`${root}/modelPacks/${packId}/saved.bin`, new Uint8Array(3));
    boundary.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    let confirmation: Parameters<typeof boundary.alert>[2];
    boundary.alert.mockImplementation((_title, _message, buttons) => {
      if (buttons) confirmation = buttons;
    });
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    await act(async () => {
      hook.getCurrent().clearAssets();
      await hook.getCurrent().prepareModel();
    });
    try {
      expect(boundary.fetch).not.toHaveBeenCalled();
      expect(boundary.files.has(`${root}/modelPacks/${packId}/saved.bin`)).toBe(true);
    } finally {
      await act(async () => { confirmation?.find(button => button.style === 'cancel')?.onPress?.(); });
    }
  });

  it('reports a manifest preparation failure through the real installer', async () => {
    boundary.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    await act(async () => { await hook.getCurrent().prepareModel(); });
    expect(hook.getCurrent().modelStatus).toBe('error');
    expect(hook.getCurrent().installed).toBe(false);
    expect(boundary.alert.mock.calls.some(call =>
      String(call[1]).includes('model_pack_manifest_download_failed:503'))).toBe(true);
  });

  it('cancels a resumed preparation, refreshes saved bytes, and permits retry', async () => {
    boundary.files.set(`${root}/modelPacks/${packId}/model.bin`, new Uint8Array([1, 2, 3]));
    const requested = createDeferred<void>();
    boundary.fetch.mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected installer cancellation signal');
      requested.resolve();
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const hook = await renderHook(useNativeModelPackState, { initialProps: input });
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(3);
    let operation!: Promise<void>;
    await act(async () => { operation = hook.getCurrent().prepareModel(); await requested.promise; });
    expect(hook.getCurrent().modelStatus).toBe('downloading');
    await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().downloadProgress).toBeNull();
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(0);
    expect(boundary.files.size).toBe(0);
    expect(boundary.alert).not.toHaveBeenCalled();
    boundary.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await act(async () => { await hook.getCurrent().prepareModel(); });
    expect(hook.getCurrent().modelStatus).toBe('error');
  });

  it.each(['stt', 'tts'] as const)('keeps the installed %s pack ready when an admitted update fails', async role => {
    seedInstalledPack(packId, role);
    boundary.fetch.mockResolvedValueOnce(Response.json(modelPackManifest(packId, role)));
    const admitted = createDeferred<void>();
    boundary.fetch.mockImplementation(async () => { admitted.resolve(); throw new Error('network_offline'); });
    const hook = await renderHook(useNativeModelPackState, { initialProps: { ...input, role, networkTimeoutMs: 1000 } });
    expect(hook.getCurrent().modelStatus).toBe('ready');
    await act(async () => { hook.getCurrent().checkForUpdates(); await admitted.promise; });
    await vi.waitFor(() => expect(hook.getCurrent().modelStatus).toBe('ready'));
    expect(hook.getCurrent().installed).toBe(true);
    expect(boundary.alert.mock.calls.some(call => String(call[1]).includes('network_offline'))).toBe(true);
    expect(boundary.files.has(`${root}/modelPacks/${packId}/pack.json`)).toBe(true);
  });

  it.each(['prepare', 'update'] as const)('reports storage failure while cancelling %s and refreshes disk state', async operation => {
    const installed = operation === 'update';
    const partialFile = installed
      ? `${root}/modelPackUpdates/${packId}/model.bin`
      : `${root}/modelPacks/${packId}/model.bin`;
    boundary.files.set(partialFile, new Uint8Array([1, 2, 3]));
    if (installed) {
      boundary.files.set(`${root}/modelPacks/${packId}/pack.json`,
        new TextEncoder().encode(JSON.stringify({ manifest: modelPackManifest(packId, 'stt', 'a'.repeat(64)) })));
      boundary.files.set(`${root}/modelPacks/${packId}/model.bin`, new Uint8Array([9, 9, 9]));
      boundary.fetch.mockResolvedValueOnce(Response.json(modelPackManifest(packId, 'stt', 'b'.repeat(64))));
    }
    const requested = createDeferred<void>();
    boundary.fetch.mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected installer cancellation signal');
      requested.resolve();
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const hook = await renderHook(useNativeModelPackState, { initialProps: {
      role: 'stt' as const, packId, manifestUrl: 'https://example.test/manifest.json',
    } });
    await act(async () => {
      if (installed) hook.getCurrent().checkForUpdates();
      else void hook.getCurrent().prepareModel();
      await requested.promise;
    });
    expect(hook.getCurrent().modelStatus).toBe('downloading');
    // The retained-byte count must be refreshed after the cleanup failure.
    boundary.files.set(partialFile, new Uint8Array([1, 2, 3, 4]));
    boundary.failDelete = true;
    await act(async () => { hook.getCurrent().cancelPrepare(); });
    await vi.waitFor(() => expect(boundary.alert.mock.calls.some(call =>
      String(call[1]).includes('storage_delete_failed'))).toBe(true));
    expect(hook.getCurrent().installed).toBe(installed);
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(installed ? 0 : 4);
    expect(hook.getCurrent().modelStatus).toBe(installed ? 'ready' : 'error');
    expect(boundary.files.has(partialFile)).toBe(true);
  });
});
