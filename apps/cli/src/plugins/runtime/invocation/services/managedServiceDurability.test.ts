import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
    ManagedServiceEndpointProjectionInputV1,
} from './managedServiceEndpointProjection';
import {
    createManagedServiceDurabilityOwner,
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

function record(instanceId: string, pid = 41): ManagedServiceProjectionFacts {
    return {
        instanceId,
        immutableGenerationId: 'immutable-generation-a',
        pid,
        processStartIdentity: `start-${pid}`,
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
        immutableGenerationId: facts.immutableGenerationId,
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
    it('terminates the exact managed children an exited Session runner owned', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-orphan-'));
        const terminated: number[] = [];
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => (
                pid === 41 ? 'start-41'
                    : pid === 42 ? 'start-recycled'
                        : null
            ),
            terminateProcessTree: async ({ pid }) => {
                terminated.push(pid);
            },
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
        })).resolves.toEqual([41]);

        // The recycled pid belongs to somebody else now, and an attached server belongs to the
        // operator: neither is signalled. Both records still go, because the runner that published
        // them can no longer release them.
        expect(terminated).toEqual([41]);
        const remaining = (await readdir(join(root, 'endpoint-projections')))
            .filter((entry) => entry.endsWith('.json'));
        const remainingInstanceIds = await Promise.all(remaining.map(async (entry) => (
            JSON.parse(await readFile(join(root, 'endpoint-projections', entry), 'utf8')) as {
                instanceId: string;
            }
        ).instanceId));
        expect(remainingInstanceIds.sort()).toEqual(['daemon-owned', 'other-session']);
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

    it('distinguishes confirmed process absence from unavailable start-identity observation', async () => {
        const readProcessIdentityByPidFn = vi.fn(async () => null);

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
        let observedStartIdentity: string | null = 'runner-start-42';
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => observedStartIdentity,
        });
        const projection = {
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner' as const,
            process: { pid: 42, startIdentity: 'runner-start-42' },
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
                startIdentity: 'runner-start-42',
            },
        });

        observedStartIdentity = 'reused-pid-start';
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
            process: { pid: 42, startIdentity: 'runner-start-42' },
        };
        const daemonA = createManagedServiceDurabilityOwner({ rootDir: root });
        const projectionToken = await daemonA.publishEndpointProjection(projection);
        const daemonB = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => 'runner-start-42',
        });

        await expect(daemonB.resolveEndpointProjection({
            pluginId: 'opencode',
            sessionId: 'session-one',
            selector: { kind: 'projectionToken', projectionToken },
        })).resolves.toMatchObject({ instanceId: 'runner-instance' });
    });

    it.each([
        ['dead process', null],
        ['reused PID', 'replacement-start-42'],
    ])('reaps a session-runner projection after positive %s evidence', async (_label, observedIdentity) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-stale-runner-projection-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async () => observedIdentity,
        });
        const projectionToken = await owner.publishEndpointProjection({
            ...endpointProjection(record('runner-instance', 42)),
            custodyOwner: 'sessionRunner',
            process: { pid: 42, startIdentity: 'runner-start-42' },
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
            process: { pid: 42, startIdentity: 'runner-start-42' },
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
            immutableGenerationId: 'immutable-generation-a',
            selector: { kind: 'currentContribution' },
        })).resolves.toBeNull();
        expect(observeProcessStartIdentity).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'endpoint-projections'))).toHaveLength(1);
    });

    it('clears same-base ambiguity after positively reaping the stale runner projection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-base-ambiguity-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => pid === 41 ? 'start-41' : null,
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
            observeProcessStartIdentity: async (pid) => `start-${pid}`,
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

    it('binds same-plugin same-base G/H reads to the exact immutable generation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-generation-binding-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => `start-${pid}`,
        });
        const immutableGenerationG = 'immutable-generation-g';
        const immutableGenerationH = 'immutable-generation-h';
        const tokenG = await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('generation-g', 41),
                immutableGenerationId: immutableGenerationG,
            }),
            contributionId: 'opencode/agents/opencode',
        });
        await owner.publishEndpointProjection({
            ...endpointProjection({
                ...record('generation-h', 42),
                immutableGenerationId: immutableGenerationH,
            }),
            contributionId: 'opencode/agents/opencode',
        });

        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agents/opencode',
            immutableGenerationId: immutableGenerationG,
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toMatchObject({
            instanceId: 'generation-g',
            projectionToken: tokenG,
        });
        await owner.releaseEndpointProjection({
            instanceId: 'generation-g',
            projectionToken: tokenG,
            sessionId: 'session-one',
            pluginId: 'opencode',
        });
        await expect(owner.resolveEndpointProjection({
            pluginId: 'opencode',
            contributionId: 'opencode/agents/opencode',
            immutableGenerationId: immutableGenerationG,
            selector: { kind: 'baseUrl', baseUrl: 'http://127.0.0.1:4312/' },
        })).resolves.toBeNull();
    });

    it('resolves exactly one current live session-runner contribution and fails closed on ambiguity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-current-contribution-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            observeProcessStartIdentity: async (pid) => `start-${pid}`,
        });
        const immutableGeneration = 'immutable-generation-current';
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
            immutableGenerationId: immutableGeneration,
            selector: { kind: 'currentContribution' as const },
        };

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
            immutableGenerationId: 'immutable-generation-other',
        })).resolves.toBeNull();
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
            observeProcessStartIdentity: async () => 'start-43',
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
            process: { pid: 43, startIdentity: 'start-43' },
        });
    });

    it('reaps confirmed stale runner projections before enforcing projection capacity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-managed-runner-projection-capacity-'));
        const owner = createManagedServiceDurabilityOwner({
            rootDir: root,
            maxEndpointProjections: 1,
            observeProcessStartIdentity: async (pid) => pid === 41 ? null : `start-${pid}`,
        });
        await owner.publishEndpointProjection({
            ...endpointProjection(record('crashed-runner', 41)),
            custodyOwner: 'sessionRunner',
        });

        await expect(owner.publishEndpointProjection({
            ...endpointProjection(record('replacement-runner', 42)),
            custodyOwner: 'sessionRunner',
        })).resolves.toMatch(/^[a-f0-9]{64}$/u);
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
});
