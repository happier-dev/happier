import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import { createDaemonPluginSecretCustodyRouter, createDeclaredPluginSecretsService } from './secrets';
import { createPluginStorageOwner, createStablePluginStorageService } from './storage';

describe('plugin file mutation lifetime', () => {
    it.each(['storage', 'secrets'] as const)('%s retains an old lock whose owner cannot be proven dead', async (kind) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'plugin-unknown-lock-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const controller = new AbortController();
        const pluginId = 'acme.plugin';
        const lockPath = kind === 'storage'
            ? join(paths.storageDir, pluginId, 'daemon.v1.json.lock')
            : join(paths.secretsDir, pluginId, 'secrets.v1.json.lock');
        const unknownOwner = '{"incomplete":"owner"}';
        await mkdir(dirname(lockPath), { recursive: true });
        await writeFile(lockPath, unknownOwner);
        await utimes(lockPath, new Date(0), new Date(0));
        const service = kind === 'storage'
            ? createStablePluginStorageService({ paths, pluginId, occurrenceId: 'occurrence', signal: controller.signal, isOccurrenceCurrent: () => true }).daemon
            : createDeclaredPluginSecretsService({
                pluginId, declarations: [{ id: 'token', custody: 'daemon' }],
                resolveCustody: createDaemonPluginSecretCustodyRouter({ paths,
                    resolveDeviceLocalSecretStorage: async () => ({ deriveSecretKey: () => new Uint8Array(32).fill(7) }),
                }).resolve,
                signal: controller.signal, isOccurrenceCurrent: () => true, registerRawForRedaction: () => {},
            });
        const pending = service.set('token', 'must-not-write').then(
            () => ({ ok: true }), (error: unknown) => ({ ok: false, error }),
        );
        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            controller.abort();
            expect(await pending).toMatchObject({ ok: false });
            expect(await readFile(lockPath, 'utf8')).toBe(unknownOwner);
        } finally {
            controller.abort();
            await pending;
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it.each(['storage', 'secrets'] as const)('%s waits for a healthy writer beyond five seconds', async (kind) => {
        await exerciseLockWait(kind, null);
    });

    for (const cancellation of ['operation', 'occurrence'] as const) {
        it.each(['storage', 'secrets'] as const)(`%s cancels a queued mutation on ${cancellation} retirement`, async (kind) => {
            await exerciseLockWait(kind, cancellation);
        });
    }
});

async function exerciseLockWait(kind: 'storage' | 'secrets', cancellation: 'operation' | 'occurrence' | null): Promise<void> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'plugin-lock-lifetime-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const occurrence = new AbortController();
    const operation = new AbortController();
    const pluginId = 'acme.plugin';
    const storage = createStablePluginStorageService({
        paths, pluginId, occurrenceId: 'occurrence', signal: occurrence.signal, isOccurrenceCurrent: () => true,
    });
    const custody = createDaemonPluginSecretCustodyRouter({
        paths, resolveDeviceLocalSecretStorage: async () => ({ deriveSecretKey: () => new Uint8Array(32).fill(7) }),
    });
    const secrets = createDeclaredPluginSecretsService({
        pluginId, declarations: [{ id: 'token', custody: 'daemon' }], resolveCustody: custody.resolve,
        signal: occurrence.signal, isOccurrenceCurrent: () => true, registerRawForRedaction: () => {},
    });
    const lockPath = kind === 'storage'
        ? join(paths.storageDir, pluginId, 'daemon.v1.json.lock')
        : join(paths.secretsDir, pluginId, 'secrets.v1.json.lock');
    let release!: () => void;
    let acquired = false;
    let pendingMutation: Promise<unknown> | undefined;
    const holder = withJsonOwnerFileLock({
        lockPath, timeoutMs: Infinity, staleAfterMs: 30_000, errorCode: 'test_lock_unavailable',
    }, async () => {
        acquired = true;
        await new Promise<void>((resolve) => { release = resolve; });
    });
    try {
        await vi.waitFor(() => expect(acquired).toBe(true));
        let settled = false;
        const mutation = (kind === 'storage'
            ? storage.daemon.set('token', 'new-value', { signal: operation.signal })
            : secrets.set('token', 'new-value', { signal: operation.signal }))
            .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
            .finally(() => { settled = true; });
        pendingMutation = mutation;
        if (cancellation) {
            // The explicit operation signal must not mask occurrence retirement.
            (cancellation === 'occurrence' ? occurrence : operation).abort();
            await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 });
            expect(await mutation).toMatchObject({ ok: false });
            release();
            await holder;
            const reader = kind === 'storage' ? createPluginStorageOwner({ paths, pluginId }).daemon.get('token')
                : custody.resolve({ pluginId, declaration: { id: 'token', custody: 'daemon' } })!.get('token');
            expect(await reader).toBeNull();
        } else {
            await new Promise((resolve) => setTimeout(resolve, 5_100));
            expect(settled).toBe(false);
            release();
            await holder;
            expect(await mutation).toEqual({ ok: true });
            expect(await (kind === 'storage' ? storage.daemon.get('token') : secrets.get('token'))).toBe('new-value');
        }
    } finally {
        release?.();
        await holder;
        await pendingMutation;
        await rm(happyHomeDir, { recursive: true, force: true });
    }
}
