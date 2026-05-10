import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';

function sessionMetaLine(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'response_item', payload })}\n`;
}

describe('codexExternalSessionProviderOps.resolveTakeoverSpawnOptions', () => {
    const originalActiveServerDir = configuration.activeServerDir;

    afterEach(() => {
        (configuration as { activeServerDir: string }).activeServerDir = originalActiveServerDir;
    });

    it('reuses the authoritative connected-service home when multiple homes exist for the same linked session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-provider-ops-takeover-'));
        const activeServerDir = join(root, 'servers', 'cloud');
        const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1');
        const olderHome = join(homesRoot, 'profile-a', 'codex', 'codex-home');
        const newerHome = join(homesRoot, 'profile-b', 'codex', 'codex-home');
        const olderSessionsDir = join(olderHome, 'sessions');
        const newerSessionsDir = join(newerHome, 'sessions');
        await mkdir(olderSessionsDir, { recursive: true });
        await mkdir(newerSessionsDir, { recursive: true });

        const remoteSessionId = 'takeover-authoritative-home-session';
        const olderRollout = join(olderSessionsDir, `rollout-2026-01-01T00-00-00-${remoteSessionId}.jsonl`);
        const newerRollout = join(newerSessionsDir, `rollout-2026-01-02T00-00-00-${remoteSessionId}.jsonl`);

        await writeFile(
            olderRollout,
            sessionMetaLine({ id: remoteSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/older-home' })
            + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Older title' }] }),
            'utf8',
        );
        await writeFile(
            newerRollout,
            sessionMetaLine({ id: remoteSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/newer-home' })
            + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Newer title' }] }),
            'utf8',
        );
        await utimes(olderRollout, new Date('2026-01-01T00:00:01.000Z'), new Date('2026-01-01T00:00:01.000Z'));
        await utimes(newerRollout, new Date('2026-01-02T00:00:01.000Z'), new Date('2026-01-02T00:00:01.000Z'));

        (configuration as { activeServerDir: string }).activeServerDir = activeServerDir;

        const { codexExternalSessionProviderOps } = await import('./providerOps');

        const result = await codexExternalSessionProviderOps.resolveTakeoverSpawnOptions({
            linked: {
                rawSession: {
                    id: 'raw-session-1',
                    seq: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    active: true,
                    activeAt: Date.now(),
                    metadata: '{}',
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null,
                    accountId: 'acct-1',
                    machineId: 'machine-1',
                    machineLabel: null,
                    sessionPath: null,
                    providerId: 'codex',
                    providerSessionId: remoteSessionId,
                    providerSource: JSON.stringify({ kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' }),
                },
                metadata: {},
                sessionPath: null,
                providerId: 'codex',
                machineId: 'machine-1',
                remoteSessionId,
                source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' },
                codexBackendMode: null,
            },
            sessionId: 'happy-session-1',
        });

        expect(result).toEqual(expect.objectContaining({
            directory: '/repo/newer-home',
            existingSessionId: 'happy-session-1',
            resume: remoteSessionId,
            environmentVariables: expect.objectContaining({
                CODEX_HOME: newerHome,
            }),
        }));
    });
});
