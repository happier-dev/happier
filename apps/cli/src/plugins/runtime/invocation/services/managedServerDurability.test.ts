import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    createManagedServerDurabilityOwner,
    type ManagedServerCustodyRecord,
} from './managedServerDurability';

function record(instanceId: string, pid = 41): ManagedServerCustodyRecord {
    return {
        v: 1,
        instanceId,
        generationFingerprint: 'a'.repeat(64),
        serverFingerprint: 'b'.repeat(64),
        pid,
        processStartIdentity: `start-${pid}`,
        endpoint: { host: '127.0.0.1', port: 4312 },
        createdAtMs: 1_000,
    };
}

describe('managed server durability owner', () => {
    it('persists atomic bounded custody records without executable, args, env, or credentials', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-custody-'));
        const owner = createManagedServerDurabilityOwner({ rootDir: root, maxCustodyRecords: 2 });

        await owner.claim(record('instance-one'));
        const entries = await readdir(join(root, 'custody'));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
        const persisted = await readFile(join(root, 'custody', entries[0]!), 'utf8');
        expect(JSON.parse(persisted)).toEqual(record('instance-one'));
        expect(persisted).not.toMatch(/executable|argument|args|environment|credential|secret/iu);
        await owner.claim(record('instance-two', 42));
        await expect(owner.claim(record('instance-three', 43)))
            .rejects.toMatchObject({ code: 'plugin_managed_server_custody_capacity_exceeded' });
    });

    it('reconciles only parsed exact records and retains failed recovery for a later retry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-reconcile-'));
        const recovered: string[] = [];
        const owner = createManagedServerDurabilityOwner({
            rootDir: root,
            recover: async (candidate) => {
                recovered.push(candidate.instanceId);
                return candidate.instanceId === 'retry' ? 'failed' : 'reaped';
            },
        });
        await owner.claim(record('reap'));
        await owner.claim(record('retry', 42));
        await writeFile(join(root, 'custody', 'partial.json'), '{"v":1,"instanceId":"raw-secret', 'utf8');

        await expect(owner.reconcile()).resolves.toEqual({ reaped: 1, absent: 0, identityMismatch: 0, failed: 1, corrupt: 1 });
        expect(recovered.sort()).toEqual(['reap', 'retry']);
        const remaining = await readdir(join(root, 'custody'));
        expect(remaining.filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
        expect((await readdir(join(root, 'corrupt'))).length).toBeLessThanOrEqual(16);
    });

    it('writes secret-redacted bounded logs without persisting launch arguments or environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-logs-'));
        const owner = createManagedServerDurabilityOwner({ rootDir: root, maxLogKeepCount: 2 });
        for (let index = 0; index < 3; index += 1) {
            const capture = await owner.openLog({
                instanceId: `instance-${index}`,
                serverId: 'sidecar',
                keepCount: 2,
                secretValues: ['token-secret', '--auth=token-secret'],
                nowMs: 1_000 + index,
            });
            capture.write('stdout', `ready token-secret --auth=token-secret\n`);
            await capture.close();
        }

        const logs = (await readdir(join(root, 'logs'))).filter((entry) => entry.endsWith('.log'));
        expect(logs).toHaveLength(2);
        const text = await readFile(join(root, 'logs', logs.sort().at(-1)!), 'utf8');
        expect(text).toContain('[REDACTED]');
        expect(text).not.toContain('token-secret');
        expect(text).not.toContain('--auth=');
        expect(text).not.toContain('args');
        expect(text).not.toContain('environment');
        expect(basename(logs[0]!)).not.toContain('sidecar');
    });

    it('makes release idempotent and removes only the exact incarnation record', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-release-'));
        const owner = createManagedServerDurabilityOwner({ rootDir: root });
        await owner.claim(record('first'));
        await owner.claim(record('second', 42));

        await owner.release('first');
        await owner.release('first');
        const recover = vi.fn(async () => 'absent' as const);
        const restarted = createManagedServerDurabilityOwner({ rootDir: root, recover });
        await restarted.reconcile();
        expect(recover).toHaveBeenCalledTimes(1);
        expect(recover).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'second' }));
    });

    it('serializes concurrent capacity claims instead of exceeding the custody bound', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-capacity-race-'));
        const owner = createManagedServerDurabilityOwner({ rootDir: root, maxCustodyRecords: 1 });

        const results = await Promise.allSettled([
            owner.claim(record('first')),
            owner.claim(record('second', 42)),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toEqual([
            expect.objectContaining({ reason: expect.objectContaining({ code: 'plugin_managed_server_custody_capacity_exceeded' }) }),
        ]);
        expect((await readdir(join(root, 'custody'))).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
    });

    it('enforces private directory permissions and a hard per-log byte bound', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-private-log-'));
        const owner = createManagedServerDurabilityOwner({
            rootDir: root,
            maxLogBytes: 128,
        });
        const capture = await owner.openLog({
            instanceId: 'private-instance',
            serverId: 'private-server',
            secretValues: ['xy'],
            nowMs: 1_000,
        });
        capture.write('stdout', `${'a'.repeat(1_024)}xy`);
        await capture.close();

        for (const directory of ['custody', 'corrupt', 'logs']) {
            expect((await stat(join(root, directory))).mode & 0o777).toBe(0o700);
        }
        const persisted = await readFile(capture.path);
        expect(persisted.byteLength).toBeLessThanOrEqual(128);
        expect(persisted.toString('utf8')).not.toContain('xy');
    });
});
