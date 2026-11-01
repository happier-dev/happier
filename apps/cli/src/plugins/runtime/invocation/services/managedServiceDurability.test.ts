import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as processBoundary from '@happier-dev/cli-common/process';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { createStorageCategoryCatalog } from '@/storage/categoryCatalog';
import { storageLogRoots } from '@/utils/logs/logRetention';

import type {
    ManagedServiceEndpointProjectionInputV1,
} from './managedServiceEndpointProjection';
import { readManagedServiceEndpointProjectionCandidates } from './managedServiceEndpointProjection';
import {
    createManagedServiceDurabilityOwner as createDurabilityOwner,
    observeManagedServiceProcessStartIdentity,
} from './managedServiceDurability';

type ManagedSpawnEndpointProjectionInput = Extract<
    ManagedServiceEndpointProjectionInputV1,
    Readonly<{ mode: 'managedSpawn' }>
>;

type ManagedServiceProjectionFacts = Readonly<{
    instanceId: string;
    immutableGenerationId: string;
    pid: number;
    processStartIdentity: string;
    endpoint: Pick<ManagedSpawnEndpointProjectionInput['endpoint'], 'host' | 'port'>;
    createdAtMs: number;
}>;

function processIdentity(pid: number, occurrenceId = 1): string {
    return `${pid}:${occurrenceId * 1_000}`;
}

function createManagedServiceDurabilityOwner(params: Parameters<typeof createDurabilityOwner>[0]) {
    // The shared exact-generation scenarios model Linux numeric identities and absent owned
    // process groups, not the test host's PID 41. Platform-specific cases override these facts.
    return createDurabilityOwner({
        platform: 'linux',
        observeProcessGroupPresence: async () => 'absent',
        ...params,
    });
}

function record(instanceId: string, pid = 41): ManagedServiceProjectionFacts {
    return {
        instanceId,
        immutableGenerationId: 'immutable-occurrenceId-a',
        pid,
        processStartIdentity: processIdentity(pid),
        endpoint: { host: '127.0.0.1', port: 4312 },
        createdAtMs: 1_000,
    };
}

function endpointProjection(
    facts: ManagedServiceProjectionFacts,
): ManagedSpawnEndpointProjectionInput {
    return {
        sessionId: 'session-one',
        pluginId: 'opencode',
        contributionId: 'opencode/agent',
        serverId: 'opencode-server',
        instanceId: facts.instanceId,
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId: facts.immutableGenerationId,
            installSource: 'npm',
        },
        custodyOwner: 'sessionRunner' as const,
        mode: 'managedSpawn' as const,
        endpoint: {
            baseUrl: `http://${facts.endpoint.host}:${facts.endpoint.port}`,
            ...facts.endpoint,
        },
        process: {
            pid: facts.pid,
            startIdentity: facts.processStartIdentity,
        },
        createdAtMs: facts.createdAtMs,
    };
}

describe('managed server durability owner', () => {
    // A managed child is spawned detached, so a killed or crashed Session runner leaves it running
    // with its port, listener and injected credential. The projection already records the exact pid
    // and process birthday, which is what lets the daemon retire the real child and refuse to
    // signal a recycled pid.
    it('retains exact managed-child custody when termination cannot be verified', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-orphan-'));
        const terminated: number[] = [];
        const observeProcessGroupPresence = vi.fn(async () => 'alive' as const);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => (
                pid === 41 ? processIdentity(41)
                    : pid === 42 ? processIdentity(42, 2)
                        : null
            ),
            terminateProcessTree: async ({ pid }) => {
                terminated.push(pid);
                throw new Error('tree termination returned without proof');
            },
            observeProcessGroupPresence,
        });
        const live = endpointProjection(record('live-child', 41));
        const recycled = endpointProjection(record('recycled-pid', 42));
        const otherSession = {
            ...endpointProjection(record('other-session', 43)),
            sessionId: 'session-two',
        };
        const daemonOwned = {
            ...endpointProjection(record('daemon-owned', 44)),
            custodyOwner: 'daemon' as const,
        };
        const attached: ManagedServiceEndpointProjectionInputV1 = {
            ...endpointProjection(record('attached', 45)),
            mode: 'externalAttach' as const,
            process: null,
        };
        for (const projection of [live, recycled, otherSession, daemonOwned, attached]) {
            await owner.publishEndpointProjection(projection);
        }

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);

        // The reaper must not report PID 41 retired or forget its exact birthday merely because
        // the terminator returned: this observer still proves the same child is live. The recycled
        // PID belongs to someone else and is safe to forget; the attached server has no child
        // custody to retain.
        expect(terminated).toEqual([41]);
        expect(observeProcessGroupPresence).not.toHaveBeenCalled();
        const remaining = (await readdir(join(root, 'endpoint-projections')))
            .filter((entry) => entry.endsWith('.json'));
        const remainingInstanceIds = await Promise.all(remaining.map(async (entry) => (
            JSON.parse(await readFile(join(root, 'endpoint-projections', entry), 'utf8')) as {
                instanceId: string;
            }
        ).instanceId));
        expect(remainingInstanceIds.sort()).toEqual([
            'daemon-owned',
            'live-child',
            'other-session',
        ]);
    });

    it('forgets a managed child only after post-termination identity proves absence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-orphan-confirmed-'));
        let observed: string | null = processIdentity(41);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => observed,
            terminateProcessTree: async () => {
                observed = null;
            },
        });
        await owner.publishEndpointProjection(endpointProjection(record('confirmed-child', 41)));

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([41]);
        expect(
            (await readdir(join(root, 'endpoint-projections')))
                .filter((entry) => entry.endsWith('.json')),
        ).toEqual([]);
    });

    it('retires a surviving POSIX process group after its launcher root exits', async () => {
        if (process.platform === 'win32') return;
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-orphan-group-'));
        let groupPresent = true;
        const terminateProcessTree = vi.fn(async () => {
            groupPresent = false;
        });
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => null,
            observeProcessGroupPresence: async () => groupPresent ? 'alive' : 'absent',
            terminateProcessTree,
        });
        await owner.publishEndpointProjection(endpointProjection(record(
            'surviving-process-group',
            41,
        )));

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([41]);
        expect(terminateProcessTree).toHaveBeenCalledWith({
            pid: 41,
            exitCode: 0,
        });
        expect(
            (await readdir(join(root, 'endpoint-projections')))
                .filter((entry) => entry.endsWith('.json')),
        ).toEqual([]);
    });

    it('leaves a projection alone when the process birthday cannot be observed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-orphan-unknown-'));
        const terminated: number[] = [];
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => {
                throw new Error('process identity is unavailable');
            },
            terminateProcessTree: async ({ pid }) => {
                terminated.push(pid);
            },
        });
        await owner.publishEndpointProjection(endpointProjection(record('unknown-state', 41)));

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);

        expect(terminated).toEqual([]);
        expect(
            (await readdir(join(root, 'endpoint-projections')))
                .filter((entry) => entry.endsWith('.json')),
        ).toHaveLength(1);
    });

    it('rejects omitted durable-log retention instead of owning a default', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-log-retention-'));
        const owner = createManagedServiceDurabilityOwner({ rootDir: root });

        const outcome = await owner.openLog({
            instanceId: 'missing-retention',
            serverId: 'sidecar',
            secretValues: [],
            nowMs: 1_000,
        } as never).then(
            (capture) => ({ capture }),
            (error: unknown) => error,
        );
        if ('capture' in (outcome as { capture?: unknown })) {
            await (outcome as { capture: { close(): Promise<void> } })
                .capture.close();
        }

        expect(outcome).toMatchObject({
            code: 'plugin_managed_server_log_keep_count_invalid',
        });
        expect(await readdir(join(root, 'logs'))).toEqual([]);
    });

    it('exempts only open captures and protected current managed-instance logs across durability owners', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-current-logs-'));
        const runner = createManagedServiceDurabilityOwner({ rootDir: root });
        const daemon = createManagedServiceDurabilityOwner({ rootDir: root, observeProcessStartIdentity: async () => processIdentity(41) });
        const current = await runner.openLog({ instanceId: 'live', serverId: 'sidecar', keepCount: 50, secretValues: [], nowMs: 1_000 });
        const old = await runner.openLog({ instanceId: 'old', serverId: 'sidecar', keepCount: 50, secretValues: [], nowMs: 2_000 });
        expect(await runner.getCurrentLogPaths()).toEqual(expect.arrayContaining([current.path, old.path]));
        await old.close();
        expect(await runner.getCurrentLogPaths()).toEqual([current.path]);
        const projection = endpointProjection(record('live'));
        const token = await daemon.publishEndpointProjection(projection);
        expect(await daemon.getCurrentLogPaths()).toEqual([current.path]);
        await daemon.releaseEndpointProjection({ instanceId: projection.instanceId, projectionToken: token, sessionId: projection.sessionId, pluginId: projection.pluginId });
        expect(await daemon.getCurrentLogPaths()).toEqual([]);
        await current.close();
        expect(await runner.getCurrentLogPaths()).toEqual([]);
    });

    it('protects a cross-process current managed capture in the real asynchronous storage catalog', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-managed-catalog-logs-'));
        const roots = storageLogRoots(home);
        const root = join(roots[roots.length - 1], '..');
        const runner = createManagedServiceDurabilityOwner({ rootDir: root });
        const daemon = createManagedServiceDurabilityOwner({ rootDir: root, observeProcessStartIdentity: async () => processIdentity(41) });
        const capture = await runner.openLog({ instanceId: 'live', serverId: 'sidecar', keepCount: 50, secretValues: [], nowMs: 1_000 });
        capture.write('stdout', 'current bytes\n');
        await capture.close();
        await utimes(capture.path, 1, 1);
        const projection = endpointProjection(record('live'));
        const token = await runner.publishEndpointProjection(projection);
        try {
            const catalog = createStorageCategoryCatalog({ happyHomeDir: home, activeServerDir: home,
                currentLogPaths: () => daemon.getCurrentLogPaths(), now: () => Date.now() });
            expect((await catalog.discover()).find(item => item.path === capture.path)).toMatchObject({ verdict: 'keep', reason: { code: 'in_use' } });
            await runner.releaseEndpointProjection({ instanceId: projection.instanceId, projectionToken: token, sessionId: projection.sessionId, pluginId: projection.pluginId });
            expect((await catalog.discover()).find(item => item.path === capture.path)).toMatchObject({ verdict: 'safe', reason: { code: 'old' } });
        } finally { await rm(home, { recursive: true, force: true }); }
    });

    it('distinguishes confirmed process absence from unavailable start-identity observation', async () => {
        const readProcessIdentityByPidFn = vi.fn(async () => null);

        await expect(observeManagedServiceProcessStartIdentity(42, {
            readProcessIdentityByPidFn: async () => ({
                pid: 4_321,
                processStartTimeMs: 12_345,
                command: 'fixture-managed-service',
            }),
        })).resolves.toBe('42:12345');

        await expect(observeManagedServiceProcessStartIdentity(42, {
            readProcessIdentityByPidFn,
            signalProcessFn: () => {
                throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
            },
        })).resolves.toBeNull();
        await expect(observeManagedServiceProcessStartIdentity(42, {
            readProcessIdentityByPidFn,
            signalProcessFn: () => undefined,
        })).rejects.toThrow('observation is unavailable');
        await expect(observeManagedServiceProcessStartIdentity(42, {
            readProcessIdentityByPidFn,
            signalProcessFn: () => {
                throw Object.assign(new Error('access denied'), { code: 'EACCES' });
            },
        })).rejects.toThrow('observation is unavailable');
    });

    it('writes secret-redacted bounded logs without persisting launch arguments or environment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-logs-'));
        const owner = createManagedServiceDurabilityOwner({ rootDir: root });
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

    it('redacts secrets split across durable log chunks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-split-secret-'));
        const owner = createManagedServiceDurabilityOwner({ rootDir: root });
        const capture = await owner.openLog({
            instanceId: 'split-secret-instance',
            serverId: 'sidecar',
            keepCount: 50,
            secretValues: ['token-secret'],
            nowMs: 1_000,
        });

        capture.write('stdout', 'ready token-');
        capture.write('stdout', 'secret done\n');
        await capture.close();

        const text = await readFile(capture.path, 'utf8');
        expect(text).toContain('[REDACTED]');
        expect(text.replaceAll('[stdout] ', '')).not.toContain('token-secret');
    });

    it('redacts secrets split across stdout and stderr log chunks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-cross-stream-secret-'));
        const owner = createManagedServiceDurabilityOwner({ rootDir: root });
        const capture = await owner.openLog({
            instanceId: 'cross-stream-secret-instance',
            serverId: 'sidecar',
            keepCount: 50,
            secretValues: ['token-secret'],
            nowMs: 1_000,
        });

        capture.write('stdout', 'ready token-');
        capture.write('stderr', 'secret done\n');
        await capture.close();

        const text = await readFile(capture.path, 'utf8');
        expect(text).toContain('[REDACTED]');
        expect(text.replaceAll('[stdout] ', '').replaceAll('[stderr] ', ''))
            .not.toContain('token-secret');
    });

    it('requires exact session, plugin, instance, and token scope before projection release', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-projection-release-'));
        const projectionFacts = record('scoped-instance');
        const owner = createManagedServiceDurabilityOwner({ rootDir: root });
        const projectionToken = await owner.publishEndpointProjection(endpointProjection(projectionFacts));

        await expect(owner.releaseEndpointProjection({
            instanceId: projectionFacts.instanceId,
            projectionToken,
            sessionId: 'wrong-session',
            pluginId: 'opencode',
        })).resolves.toBe(false);
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
        await expect(owner.releaseEndpointProjection({
            instanceId: projectionFacts.instanceId,
            projectionToken,
            sessionId: 'session-one',
            pluginId: 'opencode',
        })).resolves.toBe(true);
        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);
    });

    it('persists only non-secret endpoint projection facts and re-observes the exact live process before resolving it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-projection-'));
        const rawHeader = 'Basic raw-secret';
        const secretDerivedFingerprint = createHash('sha256')
            .update(rawHeader)
            .digest('hex');
        let observedStartIdentity: string | null = processIdentity(42);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => observedStartIdentity,
        });
        const projection = {
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 42, startIdentity: processIdentity(42) },
        };
        const projectionToken = await owner.publishEndpointProjection(projection);

        const persisted = await readFile(join(
            root,
            'endpoint-projections',
            (await readdir(join(root, 'endpoint-projections')))[0]!,
        ), 'utf8');
        expect(persisted).not.toContain(rawHeader);
        expect(persisted).not.toContain(secretDerivedFingerprint);
        expect(persisted).not.toMatch(/"headers"|"serverFingerprint"/u);

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toMatchObject({
            custodyOwner: 'sessionRunner',
            process: {
                pid: 42,
                startIdentity: processIdentity(42),
            },
        });

        observedStartIdentity = processIdentity(42, 2);
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);
    });

    it('retains a live session-runner projection across daemon owner replacement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-live-runner-projection-'));
        const projection = {
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 42, startIdentity: processIdentity(42) },
        };
        const daemonA = createManagedServiceDurabilityOwner({ rootDir: root });
        const projectionToken = await daemonA.publishEndpointProjection(projection);
        const daemonB = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => processIdentity(42),
        });

        await expect(daemonB.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toMatchObject({ instanceId: 'runner-instance' });
    });

    it.each([
        ['dead process', null],
        ['reused PID', processIdentity(42, 2)],
    ])('reaps a session-runner projection after positive %s evidence', async (_label, observedIdentity) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-stale-runner-projection-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => observedIdentity,
        });
        const projectionToken = await owner.publishEndpointProjection({
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner',
            process: { pid: 42, startIdentity: processIdentity(42) },
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toBeNull();

        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);
    });

    it.each([
        ['unavailable observer', undefined],
        ['failed observation', async () => { throw new Error('transient observer failure'); }],
    ])('retains session-runner projections when the process observer is %s', async (_label, observer) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-uncertain-runner-projection-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            ...(observer ? { observeProcessStartIdentity: observer } : {}),
        });
        const projectionToken = await owner.publishEndpointProjection({
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner',
            process: { pid: 42, startIdentity: processIdentity(42) },
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toBeNull();

        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('does not apply managed-process reaping to external attachments', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-external-projection-'));
        const observeProcessStartIdentity = vi.fn(async () => null);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity,
        });
        const projectionToken = await owner.publishEndpointProjection({
            ...endpointProjection(record('external-instance', 42)),
            custodyOwner: 'sessionRunner',
            mode: 'externalAttach',
            process: null,
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toMatchObject({
            instanceId: 'external-instance',
            mode: 'externalAttach',
        });
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agent',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'immutable-occurrenceId-a',
                installSource: 'npm',
            },
            selector: { kind: 'currentContribution' },
        })).resolves.toBeNull();
        expect(observeProcessStartIdentity).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('clears same-base ambiguity after positively reaping the stale runner projection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-base-ambiguity-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => pid === 41 ? processIdentity(41) : null,
        });
        const liveToken = await owner.publishEndpointProjection({
            ...endpointProjection(record('live-runner', 41)),
            custodyOwner: 'sessionRunner',
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('dead-runner', 42)),
            custodyOwner: 'sessionRunner',
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toMatchObject({
            instanceId: 'live-runner',
            projectionToken: liveToken,
        });
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('fails closed when an omitted session matches two live same-base projections', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-cross-session-base-ambiguity-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid),
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('session-one-runner', 41)),
            sessionId: 'session-one',
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('session-two-runner', 42)),
            sessionId: 'session-two',
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(2);

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toMatchObject({ instanceId: 'session-one-runner' });
    });

    it('binds same-plugin same-base G/H reads to the exact immutable occurrenceId', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-occurrenceId-binding-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid),
        });
        const immutableGenerationG = 'immutable-occurrenceId-g';
        const immutableGenerationH = 'immutable-occurrenceId-h';
        const tokenG = await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('occurrenceId-g', 41),
                immutableGenerationId: immutableGenerationG,
            }),
            contributionId: 'opencode/agents/opencode',
        });
        await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('occurrenceId-h', 42),
                immutableGenerationId: immutableGenerationH,
            }),
            contributionId: 'opencode/agents/opencode',
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agents/opencode',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: immutableGenerationG,
                installSource: 'npm',
            },
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toMatchObject({
            instanceId: 'occurrenceId-g',
            projectionToken: tokenG,
        });
        await owner.releaseEndpointProjection({
            instanceId: 'occurrenceId-g',
            projectionToken: tokenG,
            sessionId: 'session-one',
            pluginId: 'opencode',
        });
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agents/opencode',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: immutableGenerationG,
                installSource: 'npm',
            },
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toBeNull();
    });

    it('resolves exactly one current live session-runner contribution and fails closed on ambiguity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-current-contribution-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid),
        });
        const immutableGeneration = 'immutable-occurrenceId-current';
        const currentToken = await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('current-runner', 41),
                immutableGenerationId: immutableGeneration,
            }),
            contributionId: 'opencode/agents/opencode',
        });
        const exactQuery = {
            pluginId: 'opencode',
            contributionId: 'opencode/agents/opencode',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: immutableGeneration,
                installSource: 'npm',
            },
            selector: { kind: 'currentContribution' as const },
        } as const;

        await expect(owner.resolveEndpointProjection(exactQuery))
            .resolves.toMatchObject({
                instanceId: 'current-runner',
                projectionToken: currentToken,
                custodyOwner: 'sessionRunner',
            });

        await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('second-current-runner', 42),
                immutableGenerationId: immutableGeneration,
            }),
            sessionId: 'session-two',
            contributionId: 'opencode/agents/opencode',
        });

        await expect(owner.resolveEndpointProjection(exactQuery))
            .resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            sessionId: 'session-one',
        })).resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            pluginId: 'other-plugin',
        })).resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            contributionId: 'opencode/agents/other',
        })).resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'immutable-occurrenceId-other',
                installSource: 'npm',
            },
        })).resolves.toBeNull();
    });

    it('resolves the live managed-spawn endpoint for one exact Session contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-current-session-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid),
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('session-one-runner', 41)),
            contributionId: 'opencode/agents/opencode',
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('session-two-runner', 42)),
            sessionId: 'session-two',
            contributionId: 'opencode/agents/opencode',
        });

        const exactQuery = {
            pluginId: 'opencode',
            sessionId: 'session-one',
            contributionId: 'opencode/agents/opencode',
            selector: { kind: 'currentSessionManagedSpawn' as const },
        };
        await expect(owner.resolveEndpointProjection(exactQuery)).resolves.toMatchObject({
            instanceId: 'session-one-runner',
            endpoint: { baseUrl: 'http://127.0.0.1:4312' },
            custodyOwner: 'sessionRunner',
            mode: 'managedSpawn',
        });
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            sessionId: 'session-missing',
        })).resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            contributionId: 'opencode/agents/other',
        })).resolves.toBeNull();
        await expect(owner.resolveEndpointProjection({
            ...exactQuery,
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'unexpected-occurrenceId',
                installSource: 'npm',
            },
        })).resolves.toBeNull();
    });

    it('rejects and reaps a stale exact-Session managed-spawn endpoint', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-stale-session-'));
        const publisher = createManagedServiceDurabilityOwner({ rootDir: root });
        await publisher.publishEndpointProjection({
            ...endpointProjection(record('stale-session-runner', 41)),
            contributionId: 'opencode/agents/opencode',
        });
        const resolver = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => null,
        });

        await expect(resolver.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            contributionId: 'opencode/agents/opencode',
            selector: { kind: 'currentSessionManagedSpawn' },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(0);
    });

    it('does not remove a same-instance replacement published during stale-process observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-reaper-race-'));
        const publisher = createManagedServiceDurabilityOwner({ rootDir: root });
        let replacementToken: string | null = null;
        const reaper = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => {
                replacementToken = await publisher.publishEndpointProjection({
                    ...endpointProjection(record('runner-instance', 43)),
                    custodyOwner: 'sessionRunner',
                });
                return null;
            },
        });
        const staleProjectionToken = await publisher.publishEndpointProjection({
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner',
        });

        await expect(reaper.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: {
                kind: 'projectionToken',
                projectionToken: staleProjectionToken,
            },
        })).resolves.toBeNull();

        expect(replacementToken).toMatch(/^[a-f0-9]{64}$/u);
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
        const resolver = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => processIdentity(43),
        });
        await expect(resolver.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: {
                kind: 'projectionToken',
                projectionToken: replacementToken!,
            },
        })).resolves.toMatchObject({
            instanceId: 'runner-instance',
            process: { pid: 43, startIdentity: processIdentity(43) },
        });
    });

    it('retains every live endpoint projection beyond the former fixed census limit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-projection-census-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid),
        });
        try {
            for (let index = 0; index < 257; index += 1) {
                await owner.publishEndpointProjection({
                    ...endpointProjection(record(`live-runner-${index}`, index + 41)),
                    sessionId: `session-${index}`,
                });
            }
            const projections = readManagedServiceEndpointProjectionCandidates(root);
            expect(projections).toHaveLength(257);
            for (const projection of [projections[0]!, projections[256]!]) {
                await expect(owner.resolveEndpointProjection({
                    pluginId: projection.pluginId,
                    sessionId: projection.sessionId,
                    selector: { kind: 'projectionToken', projectionToken: projection.projectionToken },
                })).resolves.toMatchObject({ instanceId: projection.instanceId });
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('round-trips a valid canonical projection larger than the former file-reader ceiling', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-projection-record-'));
        const owner = createManagedServiceDurabilityOwner({ rootDir: root,
            observeProcessStartIdentity: async (pid) => processIdentity(pid) });
        try {
            const input = { ...endpointProjection(record('large-record')),
                sessionId: 's'.repeat(10_000), pluginId: 'p'.repeat(10_000), contributionId: 'c'.repeat(10_000),
                serverId: 'v'.repeat(10_000), instanceId: 'i'.repeat(10_000), operationClaimId: 'o'.repeat(10_000),
                process: { pid: 42, startIdentity: 'b'.repeat(10_000) } };
            const token = await owner.publishEndpointProjection(input);
            const projections = readManagedServiceEndpointProjectionCandidates(root);
            expect(projections).toHaveLength(1);
            expect(projections[0]).toMatchObject({ ...input, projectionToken: token });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reaps confirmed stale runner projections when resolving a current contribution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-projection-capacity-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => pid === 41 ? null : processIdentity(pid),
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('crashed-runner', 41)),
            custodyOwner: 'sessionRunner',
        });

        await expect(owner.publishEndpointProjection({
            ...endpointProjection(record('replacement-runner', 42)),
            custodyOwner: 'sessionRunner',
        })).resolves.toMatch(/^[a-f0-9]{64}$/u);
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agent',
            selector: { kind: 'currentContribution' },
        })).resolves.toMatchObject({ instanceId: 'replacement-runner' });
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('enforces private directory permissions and a hard per-log byte bound', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-private-log-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            maxLogBytes: 128,
        });
        const capture = await owner.openLog({
            instanceId: 'private-instance',
            serverId: 'private-server',
            keepCount: 50,
            secretValues: ['xy'],
            nowMs: 1_000,
        });
        capture.write('stdout', `${'a'.repeat(1_024)}xy`);
        await capture.close();

        for (const directory of ['endpoint-projections', 'logs']) {
            expect((await stat(join(root, directory))).mode & 0o777).toBe(0o700);
        }
        const persisted = await readFile(capture.path);
        expect(persisted.byteLength).toBeLessThanOrEqual(128);
        expect(persisted.toString('utf8')).not.toContain('xy');
    });

    // A Darwin `ps lstart` record truncates the birthday to whole seconds, so a pid replaced
    // inside that same second cannot be told apart from the recorded child. That ambiguity must
    // fence custody — the record is retained and unadoptable, the replacement is never signalled,
    // and nothing is reaped until better evidence arrives.
    it('fences a same-second pid replacement recorded in a legacy identity instead of reaping or signalling it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-darwin-same-second-'));
        const terminateProcessTree = vi.fn(async () => undefined);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'darwin',
            observeProcessStartIdentity: async () => '41:1754041400000',
            terminateProcessTree,
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('same-second-child', 41)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 41, startIdentity: '41:1754041400000' },
        });

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);
        expect(terminateProcessTree).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'currentSessionManagedSpawn' as const },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('reaps a legacy identity after a different-second observation proves reuse without signalling the replacement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-darwin-different-second-'));
        const terminateProcessTree = vi.fn(async () => undefined);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'darwin',
            observeProcessStartIdentity: async () => '41:1754041401000',
            terminateProcessTree,
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('stale-second-child', 41)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 41, startIdentity: '41:1754041400000' },
        });

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);
        expect(terminateProcessTree).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);
    });

    it('fences a Darwin predecessor record when its root is absent but a same-number group exists', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-darwin-root-absent-'));
        const terminateProcessTree = vi.fn(async () => undefined);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'darwin',
            observeProcessStartIdentity: async () => null,
            observeProcessGroupPresence: async () => 'alive',
            terminateProcessTree,
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('darwin-root-absent', 41)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 41, startIdentity: '41:1754041400000' },
        });

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);
        expect(terminateProcessTree).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('keeps predecessor Windows projections fenced without atomic process-tree containment', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-win32-fenced-'));
        const terminateProcessTree = vi.fn(async () => undefined);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'win32',
            observeProcessStartIdentity: async () => '42:1000',
            terminateProcessTree,
        });
        await owner.publishEndpointProjection(endpointProjection({
            ...record('win32-predecessor', 42),
            processStartIdentity: '42:1000',
        }));

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);
        expect(terminateProcessTree).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('retains tagged Windows custody when fresh native membership cannot be read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-win32-unavailable-'));
        let jobLive = true;
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root, platform: 'win32',
            observeProcessCustodyJob: async () => jobLive ? 'live' : 'absent',
            processTreeSystemBoundary: { platform: 'win32',
                censusDependencies: { platform: 'win32', helperExecutablePath: '/native-helper',
                    execFile: async () => { throw new Error('native membership unavailable'); } },
            },
        });
        await owner.publishEndpointProjection(endpointProjection({ ...record('win32-unavailable', 42),
            processStartIdentity: 'winjob:Local\\happier-svc09-fixture' }));
        await expect(owner.retireSessionRunnerOwnedProjections({ sessionId: 'session-one' })).resolves.toEqual([]);
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('observes and retires tagged Windows job custody through the job, never the pid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-win32-job-'));
        const terminateProcessTree = vi.fn(async () => undefined);
        let jobLive = true;
        let terminationProven = true;
        const observeProcessCustodyJob = vi.fn(async () => (jobLive ? 'live' : 'absent') as 'live' | 'absent');
        const terminateWindowsJob = vi.fn(async () => {
            if (terminationProven) jobLive = false;
            return terminationProven ? 'absent' : 'members-remaining';
        });
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'win32',
            observeProcessStartIdentity: async () => {
                throw new Error('job custody never asks for a pid birth witness');
            },
            observeProcessCustodyJob,
            processTreeSystemBoundary: { platform: 'win32', terminateWindowsJob,
                censusDependencies: { platform: 'win32', helperExecutablePath: '/native-helper',
                    execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 1,
                        rows: [process.pid, ...(jobLive ? [42] : [])].map(pid => ({ pid, ppid: 1, name: 'fixture',
                            start: { startTimeMs: pid }, principal: { kind: 'sid', value: 'S-1-5-21-1000' },
                            memory: null, cpuTimeUs: null,
                            ...(pid === 42 ? { jobs: ['Local\\happier-svc09-fixture'] } : {}) })), partial: [],
                        jobObservations: [{ name: 'Local\\happier-svc09-fixture',
                            ...(jobLive ? { state: 'live', pids: [42] } : { state: 'absent' }) }],
                    }), stderr: '' }),
                },
            },
            terminateProcessTree,
        });
        const jobIdentity = 'winjob:Local\\happier-svc09-fixture';
        await owner.publishEndpointProjection(endpointProjection({
            ...record('win32-job-child', 42),
            processStartIdentity: jobIdentity,
        }));

        // A live job is live root custody; resolution adopts it, and the pid
        // witness is never consulted for a job-owned record.
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            contributionId: 'opencode/agent',
            selector: { kind: 'currentSessionManagedSpawn' },
        })).resolves.toMatchObject({
            process: { pid: 42, startIdentity: jobIdentity },
        });
        expect(observeProcessCustodyJob).toHaveBeenCalledWith('Local\\happier-svc09-fixture');

        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([42]);
        expect(terminateWindowsJob).toHaveBeenCalledWith({ jobName: 'Local\\happier-svc09-fixture', timeoutMs: 5000 });
        expect(terminateProcessTree).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);

        // Retry custody: an unproven job termination retains the projection.
        await owner.publishEndpointProjection(endpointProjection({
            ...record('win32-job-retry', 43),
            processStartIdentity: jobIdentity,
        }));
        terminationProven = false;
        jobLive = true;
        await expect(owner.retireSessionRunnerOwnedProjections({
            sessionId: 'session-one',
        })).resolves.toEqual([]);
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('resolves a tagged Windows record through job absence and fences an unprovable job', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-win32-job-query-'));
        const observeProcessCustodyJob = vi.fn(async () => 'unknown' as const);
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'win32',
            observeProcessStartIdentity: async () => null,
            observeProcessCustodyJob,
        });
        await owner.publishEndpointProjection(endpointProjection({
            ...record('win32-job-unknown', 42),
            processStartIdentity: 'winjob:Local\\happier-svc09-unknown',
        }));

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            contributionId: 'opencode/agent',
            selector: { kind: 'currentSessionManagedSpawn' },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);

        const absentOwner = createManagedServiceDurabilityOwner({
            rootDir: root,
            platform: 'win32',
            observeProcessStartIdentity: async () => null,
            observeProcessCustodyJob: async () => 'absent',
        });
        await expect(absentOwner.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            contributionId: 'opencode/agent',
            selector: { kind: 'currentSessionManagedSpawn' },
        })).resolves.toBeNull();
        expect(await readdir(join(root, 'endpoint-projections'))).toEqual([]);
    });

    it('captures the tagged Darwin native identity when the witness proves it and falls back to legacy otherwise', async () => {
        const snapshot = (native?: string) => JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 8, rows: [
            { pid: process.pid, ppid: 1, start: { startTimeMs: 1000 },
                principal: { kind: 'uid', value: '1000' }, name: 'daemon', memory: null, cpuTimeUs: null },
            { pid: 41, ppid: 1, start: { startTimeMs: 1754041400000, ...(native ? { native } : {}) },
                principal: { kind: 'uid', value: '1000' }, name: 'server', argv: ['server'], memory: null, cpuTimeUs: null },
        ] });
        // Mock the helper execution boundary, retaining both real identity views and census decoding.
        const helper = vi.spyOn(processBoundary, 'execFileWithDeadline').mockResolvedValue({
            stdout: snapshot('darwin-proc:41:1754041400:123456'), stderr: '',
        });
        const dependencies = {
            platform: 'darwin',
            resolveProcessCustodyRuntimeExecutableFn: () => '/staged/happier-process-custody',
            readProcessIdentityByPidFn: (pid, deps) => readProcessIdentityByPid(pid, {
                ...deps, helperExecutablePath: '/staged/happier-process-custody',
            }),
        } satisfies NonNullable<Parameters<typeof observeManagedServiceProcessStartIdentity>[1]>;
        try {
            await expect(observeManagedServiceProcessStartIdentity(41, dependencies)).resolves.toBe('darwin-proc:41:1754041400:123456');
            helper.mockResolvedValue({ stdout: snapshot(), stderr: '' });
            await expect(observeManagedServiceProcessStartIdentity(41, dependencies)).resolves.toBe('41:1754041400000');
        } finally {
            helper.mockRestore();
        }
    });
});
