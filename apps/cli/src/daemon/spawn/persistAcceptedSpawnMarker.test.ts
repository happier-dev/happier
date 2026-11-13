import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TrackedSession } from '../types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('persistAcceptedSpawnMarker native runner witness', () => {
    it('persists the runner generation rather than a distinct native wrapper, preserving explicit custody overrides', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-runner-marker-'));
        vi.stubEnv('HAPPIER_HOME_DIR', home);
        vi.resetModules();
        try {
            const { persistAcceptedSpawnMarker } = await import('./persistAcceptedSpawnMarker');
            const { readProcessIdentityByPid } = await import('../processIdentity');
            const { readSessionMarker } = await import('../sessionRegistry');
            const { readOrCreateDeviceLocalSecretStorage } = await import('../deviceLocalSecretStorage');
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(home, 'fixture-secret.key') });
            // Genuine procfs boundary: wrapper and runner have different native births.
            const linuxBoundary = {
                readdir: async () => [String(process.pid), '1111', '2222'],
                readlink: async () => '/usr/bin/node',
                readFile: async (path: string) => {
                    if (path === '/proc/self/auxv') return Buffer.alloc(0);
                    const pid = Number(/^\/proc\/(\d+)\//u.exec(path)?.[1]);
                    if (path.endsWith('/stat')) return `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 ${pid === 2222 ? 456 : 123} 4096 1`;
                    if (path.endsWith('/status')) return `Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n`;
                    if (path.endsWith('/cmdline')) return `node\0${pid === 2222 ? 'runner' : 'wrapper'}`;
                    if (path.endsWith('/environ')) return '';
                    if (path.endsWith('/cgroup')) return '0::/user.slice';
                    throw new Error(`Unexpected procfs read ${path}`);
                },
            };
            const materializedStateObservationBinding: NonNullable<TrackedSession['materializedStateObservationBinding']> = {
                    agentId: 'external-agent', pluginId: 'external-plugin',
                    sourceCustody: { kind: 'development', registeredRootId: 'external-plugin-root' },
                    nativeHomeRoot: join(home, 'materialized'),
                    entries: [{ entryPath: 'projects', sourceEntryRoot: join(home, 'native', 'projects'),
                        materializedEntryPath: join(home, 'materialized', 'projects') }],
                };
            const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1111), pid: 1111, sessionRunnerPid: 2222, startedBy: 'daemon', happySessionId: 's1',
                linuxLaunchUnit: 'happier-session-0123456789ab.session-0123456789abcdef0123456789abcdef.scope',
                spawnOptions: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } };
            const readIdentity: typeof readProcessIdentityByPid = pid => readProcessIdentityByPid(pid, { platform: 'linux', linuxBoundary });
            const wrapperIdentity = await readIdentity(tracked.pid);
            tracked.processStartTimeMs = wrapperIdentity!.processStartTimeMs;
            const { createSpawnLifecycleCallbacks } = await import('./createSpawnLifecycleCallbacks');
            const callbacks = createSpawnLifecycleCallbacks({
                connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'session-materialization',
                materializedStateObservationBinding,
                hasConnectedServiceAuth: () => false,
                onTrackedSessionRegistered: () => {
                    expect(tracked.materializedStateObservationBinding).toBe(materializedStateObservationBinding);
                },
                getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {},
                spawnResourceCleanupByKey: new Map(), getSessionAttachCleanup: () => null,
                setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: new Map(),
                persistAcceptedSpawnMarker: async trackedSession => {
                    await persistAcceptedSpawnMarker({ trackedSession, deviceLocalSecretStorage: storage, readProcessIdentityByPidFn: readIdentity });
                },
            });
            callbacks.onTrackedSessionRegistered?.(tracked);
            await callbacks.persistAcceptedSpawnMarker(tracked);
            expect(tracked.materializedStateObservationBinding).toBe(materializedStateObservationBinding);
            const marker = await readSessionMarker(tracked.trackingKey);
            expect(marker).toMatchObject({ pid: 2222, processStartTimeMs: 4560, linuxLaunchUnit: tracked.linuxLaunchUnit });
            const { buildTrackedSessionFromMarker } = await import('../sessions/trackedSessionFromMarker');
            expect(buildTrackedSessionFromMarker({ marker: marker!, startedByFallback: 'reattached' }).linuxLaunchUnit).toBe(tracked.linuxLaunchUnit);
            expect(buildTrackedSessionFromMarker({ marker: marker!, startedByFallback: 'reattached' }).materializedStateObservationBinding)
                .toEqual(tracked.materializedStateObservationBinding);
            const { writeSessionMarker } = await import('../sessionRegistry');
            const invalidBinding = { ...materializedStateObservationBinding,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'external-plugin-root', authority: 'untrusted-extension' } };
            await expect(writeSessionMarker({ trackingKey: tracked.trackingKey, pid: 2222, happySessionId: 's1', startedBy: 'daemon', processStartTimeMs: 4560,
                materializedStateObservationBinding: invalidBinding })).rejects.toBeDefined();
            await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: 2222, happySessionId: 's1', startedBy: 'daemon', processStartTimeMs: 4560 });
            expect(await readSessionMarker(tracked.trackingKey)).toHaveProperty('linuxLaunchUnit', tracked.linuxLaunchUnit);
            expect(await readSessionMarker(tracked.trackingKey)).toHaveProperty('materializedStateObservationBinding', tracked.materializedStateObservationBinding);
            await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: 2222, happySessionId: 's1', startedBy: 'daemon', processStartTimeMs: 9990 });
            const replacement = await readSessionMarker(tracked.trackingKey);
            expect(replacement).not.toHaveProperty('materializedStateObservationBinding');
            expect(buildTrackedSessionFromMarker({ marker: replacement!, startedByFallback: 'reattached' }))
                .not.toHaveProperty('materializedStateObservationBinding');
            expect(replacement?.pid).toBe(2222);
            expect(tracked.processStartTimeMs).toBe(1230);
            await persistAcceptedSpawnMarker({ trackedSession: tracked, processPid: 1111, deviceLocalSecretStorage: storage, readProcessIdentityByPidFn: readIdentity });
            expect(await readSessionMarker(tracked.trackingKey)).toMatchObject({ pid: 1111, processStartTimeMs: 1230 });
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
            await rm(home, { recursive: true, force: true });
        }
    });
});
