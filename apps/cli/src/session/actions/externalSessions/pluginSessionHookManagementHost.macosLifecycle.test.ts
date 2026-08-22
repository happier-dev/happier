import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import {
    startQualifiedExternalSessionHookListener,
    type QualifiedExternalSessionHookListener,
    type QualifiedExternalSessionHookTransportIngress,
} from '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import {
    readExternalSessionHookInstallationRecord,
    resolveExternalSessionHookInstallationRecordPath,
} from './hookInstallationConfiguration';
import {
    createPluginSessionHookManagementHost,
} from './pluginSessionHookManagementHost';

const agent = {
    pluginId: 'happier.agent.claude',
    localId: 'claude',
} as const;
const agentId = 'claude';
const machineId = 'machine-macos-lifecycle';
const supportedVersion = '2.1.217';

const cleanupPaths = new Set<string>();
const cleanupListeners = new Set<QualifiedExternalSessionHookListener>();
const cleanupHosts = new Set<
    ReturnType<typeof createPluginSessionHookManagementHost>
>();
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
    if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
    } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    await Promise.all(
        [...cleanupHosts].map(async (host) => {
            await host.dispose();
            cleanupHosts.delete(host);
        }),
    );
    await Promise.all(
        [...cleanupListeners].map(async (listener) => {
            await listener.stop();
            cleanupListeners.delete(listener);
        }),
    );
    await Promise.all(
        [...cleanupPaths].map(async (path) => {
            await rm(path, { recursive: true, force: true });
            cleanupPaths.delete(path);
        }),
    );
    vi.restoreAllMocks();
});

function cliSnapshot(): DetectCliSnapshot {
    return {
        path: '/opt/isolated-agent-bin',
        clis: {
            [agentId]: {
                available: true,
                resolvedPath: '/opt/isolated-agent-bin/claude',
                version: supportedVersion,
            },
        },
        tmux: { available: false },
        windowsTerminal: { available: false },
    };
}

function registry(input: Readonly<{
    available: boolean;
    hooks: AgentExternalSessionHooksContribution;
    generation?: string;
    retirement?: AbortController;
}>): ResolvedExecutablePluginRuntimeRegistry {
    const retirement = input.retirement ?? new AbortController();
    const runtime = {
        pluginId: agent.pluginId,
        pluginVersion: 'fixture',
        agentId,
        generation: input.generation ?? 'generation-one',
        hasPrimaryRuntime: false as const,
        externalSessions: {} as AgentExternalSessionsContribution,
        externalSessionHooks: input.hooks,
        retirementSignal: retirement.signal,
        isCurrent: () => !retirement.signal.aborted,
    };
    return {
        contributes: {
            agentDefinitionsById: new Map([[
                agentId,
                { id: agentId, identity: agent },
            ]]),
        },
        agentRuntimesByAgentId: new Map(
            input.available ? [[agentId, runtime]] : [],
        ),
        activateContributionsOnDemand: vi.fn(async () => []),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

function hooksContribution(
    settingsPath: string,
): AgentExternalSessionHooksContribution {
    return {
        installationVariants: [{
            variantId: 'claude-session-lifecycle-v1',
            targets: [{
                targetId: 'claude-user-settings',
                format: 'hook_event_json_arrays_v1',
                collectionId: 'claude-user-hooks',
            }],
            events: [
                {
                    eventId: 'claude-session-start',
                    targetId: 'claude-user-settings',
                    nativeEventName: 'SessionStart',
                    command: {
                        kind: 'happier_observation_v1',
                        shellDialect: 'posix',
                        timeoutMs: 500,
                    },
                },
                {
                    eventId: 'claude-stop',
                    targetId: 'claude-user-settings',
                    nativeEventName: 'Stop',
                    command: {
                        kind: 'happier_observation_v1',
                        shellDialect: 'posix',
                        timeoutMs: 500,
                    },
                },
            ],
        }],
        async resolveInstallation(request) {
            if (request.installation.installedVersion !== supportedVersion) {
                return {
                    ok: true,
                    value: {
                        kind: 'unsupported',
                        reason: 'version_unsupported',
                    },
                };
            }
            return {
                ok: true,
                value: {
                    kind: 'supported',
                    variantId: 'claude-session-lifecycle-v1',
                    targets: [{
                        targetId: 'claude-user-settings',
                        absolutePath: settingsPath,
                    }],
                    readiness: { kind: 'ready' },
                },
            };
        },
        async mapHookEvent() {
            return {
                ok: true,
                value: { kind: 'ignored' },
            };
        },
    };
}

function createIngressRecorder() {
    const principals = new Map<string, {
        token: string;
        state: 'disabled' | 'active' | 'revoked';
    }>();
    const createdTokens: string[] = [];
    const enabled: string[] = [];
    const disabled: string[] = [];
    const revoked: string[] = [];
    const ingress: QualifiedExternalSessionHookTransportIngress = {
        createPrincipal(input) {
            if (!input.principalRef || !input.token) {
                throw new Error('Expected a materialized hook principal');
            }
            principals.set(input.principalRef, {
                token: input.token,
                state: 'disabled',
            });
            createdTokens.push(input.token);
            return {
                principalRef: input.principalRef,
                token: input.token,
            };
        },
        readPrincipal(principalRef) {
            const state = principals.get(principalRef)?.state;
            return {
                state: state === 'active' ? 'enabled' : state ?? 'revoked',
            };
        },
        enable(principalRef) {
            const principal = principals.get(principalRef);
            if (principal) principal.state = 'active';
            enabled.push(principalRef);
            return { state: 'active' };
        },
        disable(principalRef) {
            const principal = principals.get(principalRef);
            if (principal) principal.state = 'disabled';
            disabled.push(principalRef);
            return { state: 'disabled' };
        },
        revoke(principalRef) {
            const principal = principals.get(principalRef);
            if (principal) principal.state = 'revoked';
            revoked.push(principalRef);
            return { state: 'revoked' };
        },
        async handleAuthenticatedEvent() {
            return { state: 'ignored' };
        },
    };
    return {
        ingress,
        principals,
        createdTokens,
        enabled,
        disabled,
        revoked,
    };
}

async function listFilesRecursively(root: string): Promise<string[]> {
    const found: string[] = [];
    const visit = async (path: string): Promise<void> => {
        const entries = await readdir(path, {
            encoding: 'utf8',
            withFileTypes: true,
        }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const entry of entries) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) {
                await visit(child);
            } else {
                found.push(child);
            }
        }
    };
    await visit(root);
    return found;
}

describe.runIf(process.platform === 'darwin')(
    'External Sessions hook management macOS lifecycle',
    () => {
        it('preserves isolated Agent bytes and custody across install, disable, enable, restart, plugin absence, and uninstall', async () => {
            const root = await mkdtemp(join(tmpdir(), 'happier-cv6-macos-'));
            cleanupPaths.add(root);
            const activeServerDir = join(root, 'active-server');
            const claudeConfigDir = join(root, 'isolated-claude', '.claude');
            const settingsPath = join(claudeConfigDir, 'settings.json');
            process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

            await mkdir(claudeConfigDir, { recursive: true });

            const firstIngress = createIngressRecorder();
            const firstListener =
                await startQualifiedExternalSessionHookListener({
                    activeServerDir,
                    ingress: firstIngress.ingress,
                    nodeExecutable: process.execPath,
                    forwarderScript: join(
                        process.cwd(),
                        'scripts',
                        'session_hook_forwarder.cjs',
                    ),
                });
            cleanupListeners.add(firstListener);
            const detectCliSnapshot = vi.fn(async () => cliSnapshot());
            const contribution = hooksContribution(settingsPath);
            const resolveInstallation =
                vi.spyOn(contribution, 'resolveInstallation');
            const mapHookEvent = vi.spyOn(contribution, 'mapHookEvent');
            const firstRetirement = new AbortController();
            const firstRegistry = registry({
                available: true,
                hooks: contribution,
                retirement: firstRetirement,
            });
            const firstHost = createPluginSessionHookManagementHost({
                machineId,
                activeServerDir,
                listener: Promise.resolve(firstListener),
                dependencies: {
                    acquireRuntimeRegistryLease: async () => ({
                        registry: firstRegistry,
                        release: async () => undefined,
                    }),
                    detectCliSnapshot,
                },
            });
            cleanupHosts.add(firstHost);

            const malformed = Buffer.concat([
                Buffer.from('{"foreign":"', 'utf8'),
                Buffer.from([0xff]),
                Buffer.from('"}', 'utf8'),
            ]);
            await writeFile(settingsPath, malformed);

            const malformedStatus = await firstHost.status({
                machineId,
                intent: 'install_preview',
                agent,
            });
            expect(malformedStatus).toMatchObject({
                ok: false,
                diagnostic: { code: 'invalid_config' },
            });
            expect(await readFile(settingsPath)).toEqual(malformed);
            expect(firstIngress.createdTokens).toEqual([]);

            const foreignByteMarker = 'foreign-byte-marker-åß界';
            const foreignConfig = {
                untouched: {
                    source: 'foreign',
                    bytes: foreignByteMarker,
                    nested: ['Vibe Island', 'Orca', 'Superset'],
                },
                hooks: {
                    ForeignEvent: [{
                        matcher: 'foreign',
                        hooks: [{
                            type: 'command',
                            command: 'foreign-command --preserve',
                            timeout: 9,
                        }],
                    }],
                },
            };
            await writeFile(
                settingsPath,
                `${JSON.stringify(foreignConfig, null, 2)}\n`,
                'utf8',
            );

            const beforePassive = await readFile(settingsPath);
            const detectionCountBeforePassive =
                detectCliSnapshot.mock.calls.length;
            await firstHost.hydrate({ reason: 'bootstrap' });
            await firstHost.hydrate({ reason: 'plugin_reload' });
            expect(await readFile(settingsPath)).toEqual(beforePassive);
            expect(detectCliSnapshot).toHaveBeenCalledTimes(
                detectionCountBeforePassive,
            );
            expect(firstIngress.createdTokens).toEqual([]);

            const firstStatus = await firstHost.status({
                machineId,
                intent: 'install_preview',
                agent,
            });
            expect(firstStatus.ok).toBe(true);
            if (!firstStatus.ok) throw new Error('Expected hook inventory');
            const firstPreviewStatus = firstStatus.rows[0]?.status;
            expect(firstPreviewStatus?.state).toBe('not_installed');
            if (
                firstPreviewStatus?.state !== 'not_installed'
                || !firstPreviewStatus.installPreview
            ) {
                throw new Error('Expected install preview');
            }
            const stopChange = firstPreviewStatus.installPreview.targets
                .flatMap((target) => target.changes)
                .find((change) => change.nativeEventName === 'Stop');
            if (!stopChange) throw new Error('Missing Stop preview');

            const withIdenticalForeignPredecessor = {
                ...foreignConfig,
                hooks: {
                    ...foreignConfig.hooks,
                    Stop: [stopChange.entry],
                },
            };
            await writeFile(
                settingsPath,
                `${JSON.stringify(withIdenticalForeignPredecessor, null, 2)}\n`,
                'utf8',
            );

            const currentStatus = await firstHost.status({
                machineId,
                intent: 'install_preview',
                agent,
            });
            if (!currentStatus.ok) throw new Error('Expected hook inventory');
            const previewStatus = currentStatus.rows[0]?.status;
            if (
                previewStatus?.state !== 'not_installed'
                || !previewStatus.installPreview
            ) {
                throw new Error('Expected current install preview');
            }

            const installInput = {
                machineId,
                agent,
                expectedPreviewId: previewStatus.installPreview.previewId,
            } as const;
            const installed = await firstHost.install(installInput);
            expect(installed).toMatchObject({
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: expect.any(String),
                },
            });
            if (!installed.ok || !('installationId' in installed.status)) {
                throw new Error('Expected installed hook custody');
            }
            const installationId = installed.status.installationId;

            const acceptedReplay = await firstHost.install(installInput);
            expect(acceptedReplay).toEqual(installed);

            const recordPath =
                resolveExternalSessionHookInstallationRecordPath({
                    activeServerDir,
                    qualifiedAgent: agent,
                    hostInstallationId: installationId,
                });
            const installedRecord =
                await readExternalSessionHookInstallationRecord(recordPath);
            expect(installedRecord?.state).toBe('active');
            expect(installedRecord?.ownedEntries.find(
                (entry) => entry.nativeEventName === 'Stop',
            )).toMatchObject({
                entryIndex: 1,
                occurrenceCount: 1,
            });

            const installedBytes = await readFile(settingsPath);
            const installedConfig = JSON.parse(
                installedBytes.toString('utf8'),
            ) as {
                untouched: unknown;
                hooks: Record<string, unknown[]>;
            };
            expect(installedConfig.untouched).toEqual(
                withIdenticalForeignPredecessor.untouched,
            );
            expect(installedConfig.hooks.ForeignEvent).toEqual(
                withIdenticalForeignPredecessor.hooks.ForeignEvent,
            );
            expect(installedConfig.hooks.Stop).toEqual([
                stopChange.entry,
                stopChange.entry,
            ]);

            const tokensBeforeReload = new Set(firstIngress.createdTokens);
            await firstHost.hydrate({ reason: 'plugin_reload' });
            expect(await readFile(settingsPath)).toEqual(installedBytes);
            expect(
                firstIngress.createdTokens.some(
                    (token) => !tokensBeforeReload.has(token),
                ),
            ).toBe(true);

            const mutation = { machineId, agent, installationId } as const;
            await expect(firstHost.disable(mutation)).resolves.toMatchObject({
                ok: true,
                status: { state: 'installed_disabled', installationId },
            });
            expect(await readFile(settingsPath)).toEqual(installedBytes);
            await expect(firstHost.enable(mutation)).resolves.toMatchObject({
                ok: true,
                status: { state: 'installed_enabled', installationId },
            });
            expect(await readFile(settingsPath)).toEqual(installedBytes);
            const durableRecordBeforeRestart =
                await readExternalSessionHookInstallationRecord(recordPath);
            const durableRecordBytesBeforeRestart = await readFile(recordPath);
            expect(durableRecordBeforeRestart).toMatchObject({
                hostInstallationId: installationId,
                state: 'active',
            });
            expect(JSON.parse(
                durableRecordBytesBeforeRestart.toString('utf8'),
            )).toEqual(durableRecordBeforeRestart);
            const resolveInstallationCallsBeforeRestart =
                resolveInstallation.mock.calls.length;
            firstRetirement.abort();
            expect(await readFile(recordPath)).toEqual(
                durableRecordBytesBeforeRestart,
            );

            const credentialFilesBeforeRestart =
                (await listFilesRecursively(activeServerDir))
                    .filter((path) => path.endsWith('.secret'));
            expect(credentialFilesBeforeRestart).toHaveLength(2);

            await firstHost.dispose();
            cleanupHosts.delete(firstHost);
            await firstListener.stop();
            cleanupListeners.delete(firstListener);

            const secondIngress = createIngressRecorder();
            const secondListener =
                await startQualifiedExternalSessionHookListener({
                    activeServerDir,
                    ingress: secondIngress.ingress,
                    nodeExecutable: process.execPath,
                    forwarderScript: join(
                        process.cwd(),
                        'scripts',
                        'session_hook_forwarder.cjs',
                    ),
                });
            cleanupListeners.add(secondListener);
            const unavailableRegistry = registry({
                available: false,
                hooks: contribution,
            });
            const unavailableDetect = vi.fn(async () => cliSnapshot());
            const restartedHost = createPluginSessionHookManagementHost({
                machineId,
                activeServerDir,
                listener: Promise.resolve(secondListener),
                dependencies: {
                    acquireRuntimeRegistryLease: async () => ({
                        registry: unavailableRegistry,
                        release: async () => undefined,
                    }),
                    detectCliSnapshot: unavailableDetect,
                },
            });
            cleanupHosts.add(restartedHost);

            const beforeRestartReads = await readFile(settingsPath);
            await restartedHost.hydrate({ reason: 'bootstrap' });
            await restartedHost.hydrate({ reason: 'plugin_reload' });
            const unavailableStatus = await restartedHost.status({
                machineId,
                intent: 'passive_inventory',
                agent,
                limit: 50,
            });
            expect(unavailableStatus).toMatchObject({
                ok: true,
                rows: [{
                    status: {
                        state: 'unavailable',
                        installationId,
                    },
                }],
            });
            expect(await readFile(settingsPath)).toEqual(beforeRestartReads);
            expect(await readFile(recordPath)).toEqual(
                durableRecordBytesBeforeRestart,
            );
            await expect(
                readExternalSessionHookInstallationRecord(recordPath),
            ).resolves.toEqual(durableRecordBeforeRestart);
            expect(unavailableDetect).not.toHaveBeenCalled();
            expect(secondIngress.createdTokens).toEqual([]);
            expect(resolveInstallation).toHaveBeenCalledTimes(
                resolveInstallationCallsBeforeRestart,
            );
            expect(mapHookEvent).not.toHaveBeenCalled();

            await expect(restartedHost.uninstall(mutation)).resolves.toEqual({
                ok: true,
                status: { state: 'not_installed' },
            });
            const afterUninstallBytes = await readFile(settingsPath);
            const afterUninstall = JSON.parse(
                afterUninstallBytes.toString('utf8'),
            ) as {
                untouched: unknown;
                hooks: Record<string, unknown[]>;
            };
            expect(afterUninstall.untouched).toEqual(
                withIdenticalForeignPredecessor.untouched,
            );
            expect(afterUninstall.hooks.ForeignEvent).toEqual(
                withIdenticalForeignPredecessor.hooks.ForeignEvent,
            );
            expect(afterUninstall.hooks.Stop).toEqual([stopChange.entry]);
            expect(afterUninstall.hooks.SessionStart).toEqual([]);
            expect(afterUninstallBytes.includes(
                Buffer.from(JSON.stringify(foreignByteMarker), 'utf8'),
            )).toBe(true);
            expect(resolveInstallation).toHaveBeenCalledTimes(
                resolveInstallationCallsBeforeRestart,
            );
            expect(mapHookEvent).not.toHaveBeenCalled();
            expect(
                await readExternalSessionHookInstallationRecord(recordPath),
            ).toBeNull();
            expect(
                (await listFilesRecursively(activeServerDir))
                    .filter((path) => path.endsWith('.secret')),
            ).toEqual([]);
            expect(secondIngress.revoked).toHaveLength(2);
            expect(new Set(secondIngress.revoked).size).toBe(2);

            await expect(restartedHost.uninstall(mutation)).resolves
                .toMatchObject({
                    ok: false,
                    diagnostic: { code: 'installation_replaced' },
                });
            expect(secondIngress.revoked).toHaveLength(2);

            await restartedHost.dispose();
            cleanupHosts.delete(restartedHost);
            await secondListener.stop();
            cleanupListeners.delete(secondListener);
        });
    },
);
