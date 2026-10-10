import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import * as platformDigest from '@/platform/digest';
import { materializeVerifiedPluginArtifactSource } from '@/sync/domains/plugins/availability/artifactLease';
import { createPluginReactNativeBundleCache } from './bundleCache';
import { evaluatePluginUiCommonJsBundle } from './commonJsEvaluator';

// Opt-in source-owner measurement. The published bundle is workload data only;
// the cache, verifier and evaluator always run from the current moving source.
describe.runIf(process.env.HAPPIER_MEASURE_PLUGIN_UI_LOAD === '1')('Plugin UI source load measurement', () => {
    it('loads and verifies one real executable graph without changing its bytes', async () => {
        const bytes = new Uint8Array(readFileSync(resolve(
            '../../packages/plugins/triage/dist/happier-plugin-ui/react-native/triage-entity-drag-drop-native/entry.cjs.bundle',
        )));
        const relativePath = 'react-native/triage-entity-drag-drop-native/entry.cjs.bundle';
        const fileDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);
        const identity = { accountScope: { serverId: 'measure', accountId: 'measure' }, artifactDigest };
        const record = {
            persistentIdentity: identity, bytes, entryRelativePath: relativePath,
            files: [{ relativePath, digest: fileDigest, byteSize: bytes.byteLength, bytes }],
        };
        let reads = 0;
        let nativeBytesHashed = 0;
        let nativeHashes = 0;
        const hashing = vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, data) => {
            nativeBytesHashed += data.byteLength;
            nativeHashes += 1;
            return new Uint8Array(await webcrypto.subtle.digest(algorithm, new Uint8Array(data)));
        });
        const cache = createPluginReactNativeBundleCache({ persistentStore: {
            read: async () => { reads += 1; return record; },
            write: async () => 'persisted', remove: async () => {}, removeAccount: async () => {},
        } });
        const started = performance.now();
        let heartbeatAt: number | null = null;
        const heartbeat = new Promise<void>((done) => setTimeout(() => { heartbeatAt = performance.now() - started; done(); }, 0));
        try {
            const restored = await cache.readPersistentArtifact(identity);
            const readMs = performance.now() - started;
            expect(restored).not.toBeNull();
            const verified = await materializeVerifiedPluginArtifactSource({
                artifact: {
                    pluginId: 'triage', contributionId: 'entry-reference', artifactId: 'triage-entity-drag-drop-native',
                    tier: 'reactNative', platform: 'web', digest: artifactDigest,
                    hostUiApiRange: '^1.0.0', releaseVersion: '0.0.0',
                },
                graph: {
                    artifactId: 'triage-entity-drag-drop-native', tier: 'reactNative', entry: relativePath,
                    files: record.files.map(({ bytes: _bytes, ...file }) => file), digest: artifactDigest,
                    builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0',
                    executable: { exports: ['activate'] },
                },
                sources: [{ kind: 'persistentCache', fetch: async () => new Map([[relativePath, restored!.bytes]]) }],
                isCurrent: () => true,
            });
            expect(verified.kind).toBe('available');
            const verifiedMs = performance.now() - started;
            const exported = evaluatePluginUiCommonJsBundle({
                bytes, identity: { pluginId: 'triage', artifactId: 'triage-entity-drag-drop-native', digest: artifactDigest },
                requestedExport: 'activate',
            });
            expect(exported).toBeTypeOf('function');
            const totalMs = performance.now() - started;
            await heartbeat;
            console.info('PLUGIN_UI_LOAD_MEASUREMENT', JSON.stringify({
                bytes: bytes.byteLength, reads, evaluations: 1, nativeHashes, nativeBytesHashed,
                readMs, verifyMs: verifiedMs - readMs, evaluationMs: totalMs - verifiedMs, totalMs, heartbeatMs: heartbeatAt,
            }));
        } finally {
            hashing.mockRestore();
        }
    });
});
