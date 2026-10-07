import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { invokeVoiceDeviceModelPackOperation } from './voiceDeviceModelPackOperation.native';
import * as React from 'react';
import { renderHook, renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useLocalNeuralModelPackState } from './panels/localTts/useLocalNeuralModelPackState.native';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installDisconnectedServerSocketBoundary();

const filesystem = createMemFs();
const confirm = vi.hoisted(() => vi.fn(async () => true));

// Native filesystem, modal presentation and HTTP are genuine system boundaries.
vi.mock('expo-file-system', () => filesystem.fs);
vi.mock('@happier-dev/sherpa-native', () => ({ getOptionalHappierSherpaNativeModule: () => null }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const modelUri = () => `${filesystem.root}/${packId}/model.onnx`;
const manifest = {
    packId, kind: 'stt_sherpa', model: 'zipformer', version: 'v2', buildId: 'build-2',
    files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sizeBytes: 1,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }],
};
const input = { packId, role: 'stt_sherpa' as const, isCurrent: () => true };

describe('native device model operations through the real installer', () => {
    beforeEach(() => {
        filesystem.files.clear();
        confirm.mockReset().mockResolvedValue(true);
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('model.onnx')
            ? new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } })
            : new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })));
    });
    afterEach(() => vi.unstubAllGlobals());

    it.each(['prepare', 'update'] as const)('keeps a slow %s pending for its caller instead of imposing a local deadline', async (operation) => {
        vi.useFakeTimers();
        try {
            if (operation === 'update') {
                filesystem.files.set(modelUri(), new Uint8Array([9]));
                filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({
                    manifest: { ...manifest, version: 'v1', files: [{ ...manifest.files[0], sha256: 'a'.repeat(64) }] },
                })));
            }
            let finishManifest: ((response: Response) => void) | undefined;
            let delayed = false;
            const fetchImpl: typeof fetch = async (url) => {
                if (String(url).endsWith('model.onnx')) {
                    return new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } });
                }
                if (!delayed) {
                    delayed = true;
                    return await new Promise<Response>((resolve) => { finishManifest = resolve; });
                }
                return Response.json(manifest);
            };
            vi.stubGlobal('fetch', fetchImpl);
            const result = invokeVoiceDeviceModelPackOperation({ ...input, operation,
                manifestUrl: 'https://example.test/manifest.json' });
            const outcome = result.then((value) => value.status,
                (error: unknown) => error instanceof Error ? error.message : String(error));
            await vi.advanceTimersByTimeAsync(300_000);
            finishManifest?.(Response.json(manifest));
            expect(await outcome).toBe('completed');
            expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([1]));
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports download admission and real progress before publishing the installed pack', async () => {
        const events: string[] = [];
        const progress: unknown[] = [];
        const result = await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'prepare',
            onDownloadStarted: () => events.push(filesystem.files.has(modelUri()) ? 'already-installed' : 'downloading'),
            onProgress: (value: unknown) => progress.push(value),
        });
        expect(result.status).toBe('completed');
        expect(events).toEqual(['downloading']);
        expect(progress).toContainEqual(expect.objectContaining({ loaded: 1, total: 1 }));
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([1]));
    });

    it('preserves the installed bytes when selection changes while removal consent is open', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        let current = true;
        confirm.mockImplementationOnce(async () => { current = false; return true; });
        expect(await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'remove', isCurrent: () => current }))
            .toEqual({ status: 'cancelled' });
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
    });

    it('publishes checked update facts but does not replace files when consent is declined', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({
            manifest: { ...manifest, version: 'v1', files: [{ ...manifest.files[0], sha256: 'a'.repeat(64) }] },
        })));
        confirm.mockResolvedValueOnce(false);
        const checked: unknown[] = [];
        const result = await invokeVoiceDeviceModelPackOperation({ ...input, operation: 'update',
            onUpdateChecked: (value: unknown) => checked.push(value),
        });
        expect(result.status).toBe('cancelled');
        expect(checked).toEqual([expect.objectContaining({ updateAvailable: true, build: expect.any(String) })]);
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
    });

    it('does not remove the old UI selection after the pack changes during consent', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        let answer!: (confirmed: boolean) => void;
        confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
        const props = { packId, manifestUrl: 'https://example.test/manifest.json',
            role: 'stt_sherpa' as const };
        const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: props });
        await act(async () => { hook.getCurrent().clearAssets(); });
        await hook.rerender({ ...props, packId: 'other-pack' });
        await act(async () => { answer(true); });
        expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([9]));
        expect(hook.getCurrent().modelStatus).toBe('idle');
    });

    it('cancels UI preparation through the installer and settles back to idle', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })));
        const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: {
            ...input, manifestUrl: 'https://example.test/manifest.json',
        } });
        let operation!: Promise<void>;
        await act(async () => { operation = hook.getCurrent().prepareModel(); });
        expect(hook.getCurrent().modelStatus).toBe('downloading');
        await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
        expect(hook.getCurrent().modelStatus).toBe('idle');
        expect(hook.getCurrent().downloadProgress).toBeNull();
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('aborts admitted UI work when device execution is deselected', async () => {
        let fetchSignal: AbortSignal | null = null;
        vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
            fetchSignal = options.signal ?? null;
            fetchSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })));
        const props = { ...input, manifestUrl: 'https://example.test/manifest.json', enabled: true };
        const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: props });
        let operation!: Promise<void>;
        await act(async () => { operation = hook.getCurrent().prepareModel(); });
        expect(hook.getCurrent().modelStatus).toBe('downloading');
        await hook.rerender({ ...props, enabled: false });
        await act(async () => { await operation; });
        expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(hook.getCurrent().modelStatus).toBe('idle');
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('keeps committed removal custody when a replacement selection suspends without committing', async () => {
        filesystem.files.set(modelUri(), new Uint8Array([9]));
        let answer!: (confirmed: boolean) => void;
        confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
        const neverCommits = new Promise<never>(() => undefined);
        function Harness(props: { packId: string; suspend?: Promise<never> }) {
            const owner = useLocalNeuralModelPackState({ ...input, packId: props.packId, manifestUrl: null });
            if (props.suspend) throw props.suspend;
            return React.createElement('Remove', { onPress: owner.clearAssets });
        }
        const { tree } = await renderScreen(React.createElement(React.Suspense, { fallback: null },
            React.createElement(Harness, { packId })));
        await act(async () => { tree.root.findByType('Remove').props.onPress(); });
        await act(async () => {
            tree.update(React.createElement(React.Suspense, { fallback: null },
                React.createElement(Harness, { packId: 'other-pack', suspend: neverCommits })));
        });
        await act(async () => { answer(true); });
        expect(filesystem.files.has(modelUri())).toBe(false);
    });

    it('preserves device files when Account retirement invalidates pending removal consent for the same pack', async () => {
        await loadSyncSingletonForTests();
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://device-model-home.example.test', accountId: 'device-model-account',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const lifetime = captureActiveServerAccountScopeLifetime();
            expect(lifetime?.isCurrent()).toBe(true);
            filesystem.files.set(modelUri(), new Uint8Array([9]));
            let answer!: (confirmed: boolean) => void;
            confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
            const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: { ...input, manifestUrl: null } });
            await act(async () => { hook.getCurrent().clearAssets(); });
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            expect(lifetime?.isCurrent()).toBe(false);
            // A retired consent prompt must not keep the new Account's UI busy.
            await act(async () => { hook.getCurrent().clearAssets(); });
            expect(filesystem.files.has(modelUri())).toBe(false);
            // New Account work can install bytes while the old dialog is still open.
            filesystem.files.set(modelUri(), new Uint8Array([7]));
            await act(async () => { answer(true); });
            expect(filesystem.files.get(modelUri())).toEqual(new Uint8Array([7]));
            await hook.unmount();
        } finally {
            await connection.dispose();
        }
    });
});
