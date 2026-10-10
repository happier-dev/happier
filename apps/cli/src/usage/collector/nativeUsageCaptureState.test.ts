import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createNativeUsageCaptureStore, type NativeUsageCaptureState } from './nativeUsageCaptureState';

describe('native accounting capture custody', () => {
    it('retains normalized pending and its cursor across restart using device-only custody', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-usage-custody-'));
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: 'plain-account', machineId: 'machine' };
            const path = join(directory, 'capture.sealed');
            const store = createNativeUsageCaptureStore({ path, authority, storage });
            const state: NativeUsageCaptureState = { v: 1, authority, sources: [{
                sourceId: 'opaque-root', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: directory }, sourceKey: 'private-root', root: directory,
                supported: true, consented: true, cursor: 'completed-record-1', pending: [{
                    nativeSessionId: 'native-session', observedAt: 10,
                    observation: { provider: 'claude', source: 'native', scope: 'turn_delta', key: 'inference', modelId: 'model',
                        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 },
                        cost: null, contextUsedTokens: null, contextWindowTokens: null },
                }],
            }] };
            await store.save(state);
            const restarted = createNativeUsageCaptureStore({ path, authority, storage });
            expect(await restarted.load()).toEqual(state);
            const retainedBytes = await readFile(path, 'utf8');
            expect(retainedBytes).not.toContain('native-session');
            expect(retainedBytes).not.toContain(directory);
            await restarted.save({ ...state, sources: state.sources.map(source => ({ ...source, pending: [] })) });
            expect((await store.load()).sources[0]?.pending).toEqual([]);
            await expect(createNativeUsageCaptureStore({ path, storage, authority: { ...authority, accountId: 'other' } }).load())
                .rejects.toThrow(/authority/);
            await writeFile(path, 'corrupt-custody', { mode: 0o600 });
            await expect(restarted.load()).rejects.toThrow();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
