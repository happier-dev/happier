import { describe, expect, it } from 'vitest';

import {
    createTauriPluginUiPersistentArtifactStore,
    type TauriArtifactCacheInvoke,
} from './artifactByteCache.tauri';
import type { PluginUiPersistentArtifactIdentity } from './artifactByteCache';

const identity: PluginUiPersistentArtifactIdentity = Object.freeze({
    accountScope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    releaseVersion: '1.2.3',
    pluginId: 'com.acme.hosted',
    contributionId: 'artifact',
    tier: 'hostedWeb',
    platform: 'web',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
});

const entryBytes = new TextEncoder().encode('<!doctype html>');
const scriptBytes = new TextEncoder().encode('export {};');

describe('Tauri Artifact byte-cache adapter', () => {
    it('uses only opaque hashed locators and returns bytes only after the native record exactly matches the requested identity', async () => {
        const calls: Array<readonly [string, Record<string, unknown> | undefined]> = [];
        const invoke: TauriArtifactCacheInvoke = async <T>(
            command: string,
            args?: Record<string, unknown>,
        ): Promise<T> => {
            calls.push([command, args]);
            if (command === 'desktop_hosted_artifact_cache_read') {
                const input = args?.input as Record<string, unknown> | undefined;
                // Test boundary fixture: production validates this untyped
                // native response before exposing a cache record.
                return {
                    identityKeyHash: input?.identityKeyHash,
                    entryRelativePath: 'hosted/index.html',
                    files: [
                        {
                            relativePath: 'hosted/index.html',
                            digest: identity.artifactDigest,
                            byteSize: entryBytes.byteLength,
                            bytesBase64: 'PCFkb2N0eXBlIGh0bWw+',
                        },
                        {
                            relativePath: 'hosted/app.js',
                            digest: `sha256:${'b'.repeat(64)}`,
                            byteSize: scriptBytes.byteLength,
                            bytesBase64: 'ZXhwb3J0IHt9Ow==',
                        },
                    ],
                } as unknown as T;
            }
            return undefined as T;
        };
        const store = createTauriPluginUiPersistentArtifactStore({ invoke });

        const record = await store.read(identity);

        expect(record).toEqual(expect.objectContaining({
            persistentIdentity: identity,
            entryRelativePath: 'hosted/index.html',
            bytes: entryBytes,
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: 'hosted/app.js', bytes: scriptBytes }),
            ]),
        }));
        const args = calls[0]?.[1] as Readonly<{ input?: Record<string, unknown> }>;
        expect(args.input).toEqual(expect.objectContaining({
            identityKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            locator: expect.objectContaining({
                namespace: 'happier-plugin-ui-artifacts-v1',
                accountKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                artifactKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }),
        }));
        expect(JSON.stringify(args)).not.toContain('account-a');
        expect(JSON.stringify(args)).not.toContain('com.acme.hosted');
    });

    it('fails closed instead of accepting a malformed native cache record', async () => {
        const store = createTauriPluginUiPersistentArtifactStore({
            // Test boundary fixture: the untyped native response deliberately
            // fails the production parser's identity check.
            invoke: async <T>(): Promise<T> => ({
                identityKeyHash: 'wrong',
                entryRelativePath: 'hosted/index.html',
                files: [],
            } as unknown as T),
        });

        await expect(store.read(identity)).resolves.toBeNull();
    });
});
