import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
    PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
    createFeatureDecision,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionHookInstallationVariant,
    AgentExternalSessionHookResolveInstallationRequest,
    AgentExternalSessionHookResolveInstallationResult,
    AgentExternalSessionHooksContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import type { QualifiedExternalSessionHookListener } from '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import type {
    ExternalSessionHookInstallationInventoryRecord,
    ExternalSessionHookInstallationRecord,
} from './hookInstallationConfiguration';
import {
    createPluginSessionHookManagementActionExecutor,
} from './pluginSessionHookManagementActionExecutor';
import {
    createPluginSessionHookManagementHost,
    type PluginSessionHookManagementHostDependencies,
} from './pluginSessionHookManagementHost';

const transportMocks = vi.hoisted(() => ({
    revokeDurableCredential: vi.fn(async () => undefined),
}));

vi.mock(
    '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport',
    async (importOriginal) => ({
        ...await importOriginal<
            typeof import('@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport')
        >(),
        revokeQualifiedExternalSessionHookDurableCredential:
            transportMocks.revokeDurableCredential,
    }),
);

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: vi.fn(),
}));

vi.mock('@/capabilities/snapshots/cliSnapshot', () => ({
    detectCliSnapshotOnDaemonPath: vi.fn(),
}));

const agent = {
    pluginId: 'happier.agent.fixture',
    localId: 'fixture',
} as const;
const agentId = 'fixture';
const variant = {
    variantId: 'fixture-variant',
    targets: [{
        targetId: 'settings',
        format: 'hook_event_json_arrays_v1',
        collectionId: 'hooks',
    }],
    events: [{
        eventId: 'session-start',
        targetId: 'settings',
        nativeEventName: 'SessionStart',
        command: {
            kind: 'happier_observation_v1',
            shellDialect: 'posix',
        },
    }],
} as const;

function digest(prefix: string, values: readonly string[]): string {
    return `${prefix}:${createHash('sha256')
        .update(JSON.stringify(values))
        .digest('hex')}`;
}

const fixtureHostInstallationId = digest('hook-installation-v1', [
    'machine-1',
    agent.pluginId,
    agent.localId,
]);
const fixturePreviewTargets = [{
    targetId: 'settings',
    absolutePath: '/tmp/agent-settings.json',
    changes: [{
        kind: 'append_json_array_entry' as const,
        collectionId: 'hooks',
        eventId: 'session-start',
        nativeEventName: 'SessionStart',
        entry: {
            matcher: null,
            hooks: [{
                type: 'command' as const,
                command: '/opt/happier hook --fixture',
                timeout: 1,
            }],
        },
    }],
}];
const fixtureExpectedPreviewId = digest('hook-install-preview:v1', [
    JSON.stringify({ targets: fixturePreviewTargets }),
    'generation-1',
    digest('agent-installation-v1', [
        'machine-1',
        agent.pluginId,
        agent.localId,
        digest('agent-executable-v1', ['/bin/fixture', '1.0.0']),
    ]),
    digest('agent-executable-v1', ['/bin/fixture', '1.0.0']),
    JSON.stringify([['settings', 'input-v1:fixture']]),
]);

function inventoryRecord(
    installationId: string,
    state: ExternalSessionHookInstallationInventoryRecord['state'] = 'active',
): ExternalSessionHookInstallationInventoryRecord {
    return {
        machineId: 'machine-1',
        qualifiedAgent: agent,
        installationId,
        variantId: variant.variantId,
        state,
        updatedAtMs: 1,
        revision: 1,
    };
}

function installationRecord(
    state: ExternalSessionHookInstallationRecord['state'] = 'active',
): ExternalSessionHookInstallationRecord {
    return {
        schemaVersion: 1,
        machineId: 'machine-1',
        qualifiedAgent: agent,
        hostInstallationId: fixtureHostInstallationId,
        installationIdentity: digest('agent-installation-v1', [
            'machine-1',
            agent.pluginId,
            agent.localId,
            digest('agent-executable-v1', ['/bin/fixture', '1.0.0']),
        ]),
        executableIdentity:
            digest('agent-executable-v1', ['/bin/fixture', '1.0.0']),
        variantId: variant.variantId,
        targets: [{
            targetId: 'settings',
            absolutePath: '/tmp/agent-settings.json',
            collectionId: 'hooks',
            inputIdentity: 'input-v1:fixture',
        }],
        ownedEntries: [{
            targetId: 'settings',
            collectionId: 'hooks',
            eventId: 'session-start',
            nativeEventName: 'SessionStart',
            entryIdentity: 'entry-identity',
            entry: fixturePreviewTargets[0]!.changes[0]!.entry,
            occurrenceCount: 1,
            entryIndex: 0,
            identicalEntriesBefore: 0,
        }],
        state,
        ingressPrincipalRef: 'installation-principal',
        updatedAtMs: 1,
        revision: 1,
    };
}

function cliSnapshot(): DetectCliSnapshot {
    return {
        path: '/bin',
        clis: {
            [agentId]: {
                available: true,
                resolvedPath: '/bin/fixture',
                version: '1.0.0',
            },
        },
        tmux: { available: false },
        windowsTerminal: { available: false },
    };
}

function createFixture(input: Readonly<{
    cold?: boolean;
    currentAgentWithoutHooks?: Readonly<{
        agentId: string;
        identity: Readonly<{ pluginId: string; localId: string }>;
        cold?: boolean;
    }>;
    listener?: Promise<QualifiedExternalSessionHookListener>;
    isFeatureEnabled?: () => boolean;
    installationVariant?: AgentExternalSessionHookInstallationVariant;
    duplicateAgentDefinition?: boolean;
    dependencyOverrides?: Partial<PluginSessionHookManagementHostDependencies>;
}> = {}) {
    let current = true;
    const retirement = new AbortController();
    const selectedVariant = input.installationVariant ?? variant;
    const resolveInstallation = vi.fn(async (
        _request: AgentExternalSessionHookResolveInstallationRequest,
    ): Promise<AgentExternalSessionHookResolveInstallationResult> => ({
        ok: true,
        value: {
            kind: 'supported',
            variantId: selectedVariant.variantId,
            targets: [{
                targetId: 'settings',
                absolutePath: '/tmp/agent-settings.json',
            }],
            readiness: { kind: 'ready' },
        },
    }));
    const hooks: AgentExternalSessionHooksContribution = {
        installationVariants: [selectedVariant],
        resolveInstallation,
        mapHookEvent: vi.fn(async () => ({
            ok: true as const,
            value: { kind: 'ignored' as const },
        })),
    };
    const runtime = {
        pluginId: agent.pluginId,
        pluginVersion: '1.0.0',
        agentId,
        generation: 'generation-1',
        hasPrimaryRuntime: false as const,
        externalSessions: {} as AgentExternalSessionsContribution,
        externalSessionHooks: hooks,
        retirementSignal: retirement.signal,
        isCurrent: () => current,
    };
    type FixtureRuntime = Omit<
        typeof runtime,
        'agentId' | 'externalSessionHooks'
    > & Readonly<{
        agentId: string;
        externalSessionHooks?: typeof hooks;
    }>;
    const runtimes = new Map<string, FixtureRuntime>();
    if (!input.cold) runtimes.set(agentId, runtime);
    const unsupported = input.currentAgentWithoutHooks;
    const unsupportedRuntime = unsupported
        ? {
            ...runtime,
            agentId: unsupported.agentId,
            externalSessionHooks: undefined,
        }
        : null;
    const activate = vi.fn(async () => {
        runtimes.set(agentId, runtime);
        if (unsupportedRuntime) {
            runtimes.set(unsupportedRuntime.agentId, unsupportedRuntime);
        }
        return [];
    });
    const agentDefinitionsById = new Map<string, Readonly<{
        id: string;
        identity: Readonly<{ pluginId: string; localId: string }>;
    }>>([[
        agentId,
        { id: agentId, identity: agent },
    ]]);
    if (unsupported && unsupportedRuntime) {
        agentDefinitionsById.set(unsupported.agentId, {
            id: unsupported.agentId,
            identity: unsupported.identity,
        });
        if (!unsupported.cold) {
            runtimes.set(unsupported.agentId, unsupportedRuntime);
        }
    }
    if (input.duplicateAgentDefinition) {
        agentDefinitionsById.set(
            'happier.agent.fixture/agents/duplicate',
            {
                id: 'happier.agent.fixture/agents/duplicate',
                identity: agent,
            },
        );
    }
    const registry = {
        contributes: {
            agentDefinitionsById,
        },
        agentRuntimesByAgentId: runtimes,
        activateContributionsOnDemand: activate,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const release = vi.fn(async () => undefined);
    const createOrReuseCredential = vi.fn(async () => ({
        installationPrincipalRef: 'installation-principal',
        eventPrincipalRef: 'event-principal',
        eventId: 'session-start',
        secretFile: '/tmp/session-start.secret',
    }));
    const restoreCredential = vi.fn<
        QualifiedExternalSessionHookListener['restoreCredential']
    >(async () => ({
        state: 'restored',
        credential: {
            installationPrincipalRef: 'installation-principal',
            eventPrincipalRef: 'event-principal',
            eventId: 'session-start',
            secretFile: '/tmp/session-start.secret',
        },
    }));
    const readCredentialState = vi.fn<
        QualifiedExternalSessionHookListener['readCredentialState']
    >(() => ({ state: 'enabled' }));
    const listener = {
        port: 1234,
        createOrReuseCredential,
        restoreCredential,
        rotateCredential: vi.fn(createOrReuseCredential),
        readCredentialState,
        enable: vi.fn(() => ({ state: 'active' })),
        disable: vi.fn(() => ({ state: 'disabled' })),
        disableDurableCredential: vi.fn(() => ({ state: 'disabled' })),
        revokeDurableCredential: vi.fn(async () => undefined),
        buildOwnedEntry: vi.fn(() => ({
            matcher: null,
            hooks: [{
                type: 'command' as const,
                command: '/opt/happier hook --fixture',
                timeout: 1,
            }],
        })),
        buildOwnedEntryPreview: vi.fn(() => ({
            matcher: null,
            hooks: [{
                type: 'command' as const,
                command: '/opt/happier hook --fixture',
                timeout: 1,
            }],
        })),
        stop: vi.fn(async () => undefined),
    } satisfies QualifiedExternalSessionHookListener;
    const detectCliSnapshot = vi.fn(async () => cliSnapshot());
    const readInventoryPage = vi.fn(async () => ({
        ok: true as const,
        records: [] as ExternalSessionHookInstallationInventoryRecord[],
        diagnostics: [],
    }));
    const readInstallationRecord = vi.fn(async () => installationRecord());
    const readConfigSnapshot = vi.fn(async () => ({
        ok: true as const,
        snapshot: {
            targets: [{
                targetId: 'settings',
                absolutePath: '/tmp/agent-settings.json',
                collectionId: 'hooks',
                inputIdentity: 'input-v1:fixture',
            }],
        },
    }));
    const applyInstallationAction = vi.fn(async () => ({
        ok: true as const,
        state: 'installed_enabled' as const,
        changedConfiguration: false,
        revision: 2,
    }));
    const dependencies: PluginSessionHookManagementHostDependencies = {
        acquireRuntimeRegistryLease: async () => ({ registry, release }),
        detectCliSnapshot,
        readInventoryPage,
        readInstallationRecord,
        readConfigSnapshot,
        applyInstallationAction,
        ...input.dependencyOverrides,
    };
    const listenerPromise = input.listener ?? Promise.resolve(listener);
    const host = createPluginSessionHookManagementHost({
        machineId: 'machine-1',
        activeServerDir: '/tmp/happier-host-test',
        listener: listenerPromise,
        ...(input.isFeatureEnabled
            ? { isFeatureEnabled: input.isFeatureEnabled }
            : {}),
        dependencies,
    });
    return {
        host,
        listener,
        runtime,
        registry,
        retirement,
        release,
        activate,
        resolveInstallation,
        detectCliSnapshot,
        readInventoryPage: dependencies.readInventoryPage,
        readInstallationRecord: dependencies.readInstallationRecord,
        readConfigSnapshot: dependencies.readConfigSnapshot,
        applyInstallationAction: dependencies.applyInstallationAction,
        setCurrent(value: boolean) {
            current = value;
        },
    };
}

describe('createPluginSessionHookManagementHost', () => {
    it('keeps passive mount and reconnect inventory launch-free', async () => {
        const cold = createFixture({ cold: true });
        await expect(cold.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [],
        });
        await expect(cold.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [],
        });
        expect(cold.activate).not.toHaveBeenCalled();
        expect(cold.detectCliSnapshot).not.toHaveBeenCalled();
        expect(cold.resolveInstallation).not.toHaveBeenCalled();
    });

    it('projects a current Agent without custody as passive not-installed truth without activating or resolving it', async () => {
        const fixture = createFixture();

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                agent,
                status: { state: 'not_installed' },
            }],
        });

        expect(fixture.activate).not.toHaveBeenCalled();
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    });

    it('projects a current External Sessions Agent without hook support as passive unsupported truth', async () => {
        const unsupportedAgent = {
            pluginId: 'happier.agent.fixture',
            localId: 'without-hooks',
        } as const;
        const fixture = createFixture({
            currentAgentWithoutHooks: {
                agentId: 'without-hooks',
                identity: unsupportedAgent,
            },
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [
                {
                    agent,
                    status: { state: 'not_installed' },
                },
                {
                    agent: unsupportedAgent,
                    status: {
                        state: 'unsupported',
                        reason: 'installation_unsupported',
                    },
                },
            ],
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent: unsupportedAgent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [
                {
                    agent: unsupportedAgent,
                    status: {
                        state: 'unsupported',
                        reason: 'installation_unsupported',
                    },
                },
            ],
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent: unsupportedAgent,
        })).resolves.toEqual({
            ok: false,
            diagnostic: {
                code: 'installation_unsupported',
                retryable: false,
            },
        });

        expect(fixture.activate).not.toHaveBeenCalled();
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();

        const cold = createFixture({
            cold: true,
            currentAgentWithoutHooks: {
                agentId: 'without-hooks',
                identity: unsupportedAgent,
                cold: true,
            },
        });
        await expect(cold.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent: unsupportedAgent,
        })).resolves.toEqual({
            ok: false,
            diagnostic: {
                code: 'installation_unsupported',
                retryable: false,
            },
        });
        expect(cold.activate).toHaveBeenCalledOnce();
        expect(cold.detectCliSnapshot).not.toHaveBeenCalled();
        expect(cold.resolveInstallation).not.toHaveBeenCalled();
    });

    it('activates and resolves exactly one cold-Agent install preview and fails closed when activation fails', async () => {
        const cold = createFixture({ cold: true });
        await expect(cold.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'not_installed',
                    installPreview: {
                        previewId: expect.stringMatching(
                            /^hook-install-preview:v1:[0-9a-f]{64}$/u,
                        ),
                        targets: [{
                            targetId: 'settings',
                            absolutePath: '/tmp/agent-settings.json',
                            changes: [{
                                kind: 'append_json_array_entry',
                                collectionId: 'hooks',
                                eventId: 'session-start',
                                nativeEventName: 'SessionStart',
                                entry: {
                                    matcher: null,
                                    hooks: [{
                                        type: 'command',
                                        command:
                                            '/opt/happier hook --fixture',
                                        timeout: 1,
                                    }],
                                },
                            }],
                        }],
                    },
                },
            }],
        });
        expect(cold.activate).toHaveBeenCalledOnce();
        expect(cold.resolveInstallation).toHaveBeenCalledOnce();

        const failed = createFixture({
            cold: true,
            dependencyOverrides: {
                acquireRuntimeRegistryLease: async () => ({
                    registry: {
                        contributes: {
                            agentDefinitionsById: new Map([[
                                agentId,
                                { id: agentId, identity: agent },
                            ]]),
                        },
                        agentRuntimesByAgentId: new Map(),
                        activateContributionsOnDemand: async () => {
                            throw new Error('activation failed');
                        },
                    } as unknown as ResolvedExecutablePluginRuntimeRegistry,
                    release: async () => undefined,
                }),
            },
        });
        await expect(failed.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'operation_failed' },
        });
    });

    it('fails install preview before readiness when custody already exists or appears during activation', async () => {
        const existing = createFixture({
            cold: true,
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [
                        inventoryRecord(
                            fixtureHostInstallationId,
                            'disabled',
                        ),
                    ],
                    diagnostics: [],
                })),
            },
        });
        await expect(existing.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'concurrent_edit' },
        });
        expect(existing.activate).not.toHaveBeenCalled();
        expect(existing.detectCliSnapshot).not.toHaveBeenCalled();
        expect(existing.resolveInstallation).not.toHaveBeenCalled();

        let inventoryRead = 0;
        const appeared = createFixture({
            cold: true,
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => {
                    inventoryRead += 1;
                    return {
                        ok: true as const,
                        records: inventoryRead === 1
                            ? []
                            : [inventoryRecord(
                                fixtureHostInstallationId,
                                'disabled',
                            )],
                        diagnostics: [],
                    };
                }),
            },
        });
        await expect(appeared.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'concurrent_edit' },
        });
        expect(appeared.activate).toHaveBeenCalledOnce();
        expect(appeared.detectCliSnapshot).not.toHaveBeenCalled();
        expect(appeared.resolveInstallation).not.toHaveBeenCalled();
    });

    it('does not publish a stale install preview when custody appears during the sole Agent resolve', async () => {
        let custodyPresent = false;
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: custodyPresent
                        ? [inventoryRecord(fixtureHostInstallationId, 'disabled')]
                        : [],
                    diagnostics: [],
                })),
            },
        });
        fixture.resolveInstallation.mockImplementationOnce(async () => {
            custodyPresent = true;
            return {
                ok: true,
                value: {
                    kind: 'supported',
                    variantId: variant.variantId,
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                    }],
                    readiness: { kind: 'ready' },
                },
            };
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'concurrent_edit' },
        });

        expect(fixture.resolveInstallation).toHaveBeenCalledOnce();
    });

    it('propagates caller cancellation into the Agent installation-resolution signal', async () => {
        const fixture = createFixture();
        const caller = new AbortController();

        await fixture.host.status({
            machineId: 'machine-1',
            intent: 'install_preview',
            agent,
        }, { signal: caller.signal });

        const resolutionRequest = fixture.resolveInstallation.mock.calls[0]?.[0];
        if (!resolutionRequest) throw new Error('expected installation resolution');
        expect(resolutionRequest.signal.aborted).toBe(false);
        caller.abort();
        expect(resolutionRequest.signal.aborted).toBe(true);
    });

    it('fails the whole status request when the authoritative registry is unavailable', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                acquireRuntimeRegistryLease: async () => {
                    throw new Error('registry unavailable');
                },
            },
        });
        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            limit: 50,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'operation_failed' },
        });
    });

    it('resolves installed Agent readiness against its exact durable custody', async () => {
        const records = [inventoryRecord(fixtureHostInstallationId)];
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: async () => ({
                    ok: true,
                    records,
                    diagnostics: [],
                }),
            },
        });
        const result = await fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        });
        expect(result).toMatchObject({ ok: true, rows: { length: 1 } });
        expect(fixture.detectCliSnapshot).toHaveBeenCalledOnce();
        expect(fixture.resolveInstallation).toHaveBeenCalledOnce();
    });

    it('waits for a concurrent Disable and rechecks the resulting custody instead of resolving stale active state', async () => {
        let record = installationRecord('active');
        let releaseDisable!: () => void;
        const disableGate = new Promise<void>((resolve) => {
            releaseDisable = resolve;
        });
        const disableStarted = vi.fn();
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(async () => record),
                applyInstallationAction: vi.fn(async (request) => {
                    if (request.action !== 'disable') {
                        throw new Error(`Unexpected action ${request.action}`);
                    }
                    disableStarted();
                    await disableGate;
                    record = {
                        ...record,
                        state: 'disabled',
                        revision: record.revision + 1,
                    };
                    return {
                        ok: true as const,
                        state: 'installed_disabled' as const,
                        changedConfiguration: false,
                        revision: record.revision,
                    };
                }),
            },
        });

        const disabling = fixture.host.disable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        });
        await vi.waitFor(() => expect(disableStarted).toHaveBeenCalledOnce());
        const rechecking = fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();

        releaseDisable();
        await expect(disabling).resolves.toMatchObject({
            ok: true,
            status: { state: 'installed_disabled' },
        });
        await expect(rechecking).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'installed_disabled',
                    installationId: fixtureHostInstallationId,
                },
            }],
        });
        expect(fixture.resolveInstallation).toHaveBeenCalledOnce();
    });

    it('point-queries only the selected installation when one Agent has two durable rows', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [
                        inventoryRecord('installation-other', 'disabled'),
                        inventoryRecord(
                            fixtureHostInstallationId,
                            'disabled',
                        ),
                    ],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
            },
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'installed_disabled',
                    installationId: fixtureHostInstallationId,
                },
            }],
            nextCursor: null,
        });

        expect(fixture.readInventoryPage).not.toHaveBeenCalled();
        expect(fixture.readInstallationRecord).toHaveBeenCalledTimes(3);
        expect(fixture.resolveInstallation).toHaveBeenCalledOnce();
        expect(fixture.resolveInstallation.mock.calls[0]![0])
            .toHaveProperty('custody');
    });

    it.each([
        [
            'missing record',
            null,
        ],
        [
            'cross-machine record',
            {
                ...installationRecord('disabled'),
                machineId: 'machine-2',
            },
        ],
        [
            'cross-Agent record',
            {
                ...installationRecord('disabled'),
                qualifiedAgent: {
                    pluginId: agent.pluginId,
                    localId: 'other',
                },
            },
        ],
        [
            'mismatched installation id',
            {
                ...installationRecord('disabled'),
                hostInstallationId: 'installation-other',
            },
        ],
    ])(
        'rejects an installation point query with a %s before activation or Agent work',
        async (_reason, record) => {
            const fixture = createFixture({
                cold: true,
                dependencyOverrides: {
                    readInstallationRecord: vi.fn(async () => record),
                },
            });

            await expect(fixture.host.status({
                machineId: 'machine-1',
                intent: 'installation_recheck',
                agent,
                installationId: fixtureHostInstallationId,
            })).resolves.toMatchObject({
                ok: false,
                diagnostic: { code: 'installation_replaced' },
            });

            expect(fixture.activate).not.toHaveBeenCalled();
            expect(fixture.readInventoryPage).not.toHaveBeenCalled();
            expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
            expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        },
    );

    it('rejects ambiguous and retired exact Agent generations before Agent work', async () => {
        const ambiguous = createFixture({ duplicateAgentDefinition: true });
        await expect(ambiguous.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: false,
        });
        expect(ambiguous.activate).not.toHaveBeenCalled();
        expect(ambiguous.detectCliSnapshot).not.toHaveBeenCalled();
        expect(ambiguous.resolveInstallation).not.toHaveBeenCalled();

        const retired = createFixture();
        retired.setCurrent(false);
        retired.retirement.abort();
        await expect(retired.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: false,
        });
        expect(retired.activate).not.toHaveBeenCalled();
        expect(retired.detectCliSnapshot).not.toHaveBeenCalled();
        expect(retired.resolveInstallation).not.toHaveBeenCalled();
    });

    it('reports an active installation as installation-bound needs-attention when listener startup failed', async () => {
        const fixture = createFixture({
            listener: Promise.reject(new Error('listener unavailable')),
            dependencyOverrides: {
                readInventoryPage: async () => ({
                    ok: true,
                    records: [inventoryRecord(fixtureHostInstallationId)],
                    diagnostics: [],
                }),
            },
        });
        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                    diagnostic: { code: 'listener_unavailable' },
                },
            }],
        });
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
    });

    it('rejects an active installation recheck before Agent readiness when its ingress principal is not enabled', async () => {
        const fixture = createFixture();
        fixture.listener.readCredentialState.mockReturnValue({
            state: 'revoked',
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                    diagnostic: { code: 'listener_unavailable' },
                },
            }],
            nextCursor: null,
        });

        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    });

    it('hydrates every inventory page without config writes and queues one reload pass', async () => {
        let pass = 0;
        let releaseFirstPage!: () => void;
        const firstPage = new Promise<void>((resolve) => {
            releaseFirstPage = resolve;
        });
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async ({ cursor }) => {
                    if (!cursor && pass === 0) {
                        pass += 1;
                        await firstPage;
                    }
                    return {
                        ok: true as const,
                        records: [],
                        diagnostics: [],
                    };
                }),
            },
        });

        const firstHydration = fixture.host.hydrate();
        const queuedHydration = fixture.host.hydrate();
        releaseFirstPage();
        await Promise.all([firstHydration, queuedHydration]);

        expect(fixture.readInventoryPage).toHaveBeenCalledTimes(2);
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    });

    it('does not truncate hydration after fifty advancing inventory pages', async () => {
        let page = 0;
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => {
                    page += 1;
                    return {
                        ok: true as const,
                        records: [],
                        diagnostics: [],
                        ...(page < 51 ? { nextCursor: `page-${page + 1}` } : {}),
                    };
                }),
            },
        });
        await fixture.host.hydrate();
        expect(fixture.readInventoryPage).toHaveBeenCalledTimes(51);
    });

    it('restores without file mutation on bootstrap and rotates only for a compatible plugin reload', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(fixtureHostInstallationId)],
                    diagnostics: [],
                })),
            },
        });
        await fixture.host.hydrate({ reason: 'bootstrap' });
        expect(fixture.listener.restoreCredential).toHaveBeenCalledOnce();
        expect(fixture.listener.createOrReuseCredential).not.toHaveBeenCalled();
        expect(fixture.listener.rotateCredential).not.toHaveBeenCalled();
        expect(fixture.listener.enable).toHaveBeenCalledOnce();
        expect(fixture.activate).not.toHaveBeenCalled();
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();

        fixture.listener.enable.mockClear();
        await fixture.host.hydrate({ reason: 'plugin_reload' });
        expect(fixture.listener.restoreCredential).toHaveBeenCalledTimes(2);
        expect(fixture.listener.rotateCredential).toHaveBeenCalledOnce();
        expect(fixture.listener.enable).toHaveBeenCalledOnce();
        expect(fixture.activate).not.toHaveBeenCalled();
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
    });

    it('keeps disabled custody passive across bootstrap and reload', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(
                        fixtureHostInstallationId,
                        'disabled',
                    )],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
            },
        });

        await fixture.host.hydrate({ reason: 'bootstrap' });
        await fixture.host.hydrate({ reason: 'plugin_reload' });

        expect(fixture.activate).not.toHaveBeenCalled();
        expect(fixture.detectCliSnapshot).not.toHaveBeenCalled();
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        expect(fixture.listener.restoreCredential).not.toHaveBeenCalled();
        expect(fixture.listener.rotateCredential).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
    });

    it('projects only exact owned custody into installed status readiness and never auto-enables', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(
                        fixtureHostInstallationId,
                        'disabled',
                    )],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
            },
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'installed_disabled',
                    installationId: fixtureHostInstallationId,
                },
            }],
        });

        expect(fixture.resolveInstallation).toHaveBeenCalledWith(
            expect.objectContaining({
                custody: {
                    variantId: variant.variantId,
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                        entries: [{
                            eventId: 'session-start',
                            nativeEventName: 'SessionStart',
                            entryIndex: 0,
                            entry:
                                fixturePreviewTargets[0]!.changes[0]!.entry,
                        }],
                    }],
                },
            }),
        );
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it.each([
        [
            'changed target bytes',
            vi.fn(async () => ({
                ok: true as const,
                snapshot: {
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                        collectionId: 'hooks',
                        inputIdentity: 'input-v1:changed',
                    }],
                },
            })),
        ],
        [
            'a target read failure',
            vi.fn(async () => {
                throw new Error('read failed');
            }),
        ],
    ])(
        'does not invoke installed readiness after %s',
        async (_reason, readConfigSnapshot) => {
            const fixture = createFixture({
                dependencyOverrides: {
                    readInventoryPage: vi.fn(async () => ({
                        ok: true as const,
                        records: [inventoryRecord(
                            fixtureHostInstallationId,
                            'disabled',
                        )],
                        diagnostics: [],
                    })),
                    readInstallationRecord: vi.fn(
                        async () => installationRecord('disabled'),
                    ),
                    readConfigSnapshot,
                },
            });

            await expect(fixture.host.status({
                machineId: 'machine-1',
                intent: 'installation_recheck',
                agent,
                installationId: fixtureHostInstallationId,
            })).resolves.toMatchObject({
                ok: true,
                rows: [{
                    status: {
                        state: 'needs_attention',
                        installationId: fixtureHostInstallationId,
                        diagnostic: {
                            code:
                                'hook_installation_reconciliation_required',
                        },
                    },
                }],
            });

            expect(readConfigSnapshot).toHaveBeenCalledOnce();
            expect(fixture.resolveInstallation).not.toHaveBeenCalled();
            expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
            expect(fixture.listener.enable).not.toHaveBeenCalled();
        },
    );

    it('does not invoke installation readiness when the generation retires during the current-fact fence', async () => {
        let fixture!: ReturnType<typeof createFixture>;
        const readConfigSnapshot = vi.fn(async () => {
            fixture.setCurrent(false);
            fixture.retirement.abort();
            return {
                ok: true as const,
                snapshot: {
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                        collectionId: 'hooks',
                        inputIdentity: 'input-v1:fixture',
                    }],
                },
            };
        });
        fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(
                        fixtureHostInstallationId,
                        'disabled',
                    )],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
                readConfigSnapshot,
            },
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                },
            }],
        });
        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    });

    it('requires every custodied target identity to match before invoking readiness', async () => {
        const secondTargetVariant = {
            variantId: 'fixture-two-target-variant',
            targets: [
                ...variant.targets,
                {
                    targetId: 'secondary',
                    format: 'hook_event_json_arrays_v1' as const,
                    collectionId: 'secondary-hooks',
                },
            ],
            events: [
                ...variant.events,
                {
                    eventId: 'session-stop',
                    targetId: 'secondary',
                    nativeEventName: 'SessionStop',
                    command: {
                        kind: 'happier_observation_v1' as const,
                        shellDialect: 'posix' as const,
                    },
                },
            ],
        } satisfies AgentExternalSessionHookInstallationVariant;
        const firstRecord = installationRecord('disabled');
        const record = {
            ...firstRecord,
            variantId: secondTargetVariant.variantId,
            targets: [
                ...firstRecord.targets,
                {
                    targetId: 'secondary',
                    absolutePath: '/tmp/agent-secondary.json',
                    collectionId: 'secondary-hooks',
                    inputIdentity: 'input-v1:secondary',
                },
            ],
            ownedEntries: [
                ...firstRecord.ownedEntries,
                {
                    targetId: 'secondary',
                    collectionId: 'secondary-hooks',
                    eventId: 'session-stop',
                    nativeEventName: 'SessionStop',
                    entryIdentity: 'secondary-entry-identity',
                    entry: fixturePreviewTargets[0]!.changes[0]!.entry,
                    occurrenceCount: 1,
                    entryIndex: 3,
                    identicalEntriesBefore: 0,
                },
            ],
        } satisfies ExternalSessionHookInstallationRecord;
        const fixture = createFixture({
            installationVariant: secondTargetVariant,
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(
                        fixtureHostInstallationId,
                        'disabled',
                    )],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(async () => record),
                readConfigSnapshot: vi.fn(async () => ({
                    ok: true as const,
                    snapshot: {
                        targets: [
                            {
                                targetId: 'settings',
                                absolutePath: '/tmp/agent-settings.json',
                                collectionId: 'hooks',
                                inputIdentity: 'input-v1:fixture',
                            },
                            {
                                targetId: 'secondary',
                                absolutePath: '/tmp/agent-secondary.json',
                                collectionId: 'secondary-hooks',
                                inputIdentity: 'input-v1:changed',
                            },
                        ],
                    },
                })),
            },
        });

        await expect(fixture.host.status({
            machineId: 'machine-1',
            intent: 'installation_recheck',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                    diagnostic: {
                        code:
                            'hook_installation_reconciliation_required',
                    },
                },
            }],
        });

        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    });

    it('stages install disabled, retains attention with custody, and does not enable ingress', async () => {
        let installed = false;
        const actions: string[] = [];
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(async () => (
                    installed ? installationRecord('disabled') : null
                )),
                applyInstallationAction: vi.fn(async (request) => {
                    actions.push(request.action);
                    if (request.action === 'install') installed = true;
                    return {
                        ok: true as const,
                        state: 'installed_disabled' as const,
                        changedConfiguration: request.action === 'install',
                        revision: 2,
                    };
                }),
            },
        });
        fixture.resolveInstallation
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    kind: 'supported',
                    variantId: variant.variantId,
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                    }],
                    readiness: { kind: 'ready' },
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    kind: 'supported',
                    variantId: variant.variantId,
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                    }],
                    readiness: {
                        kind: 'needs_attention',
                        diagnostic: {
                            code: 'hooks_require_approval',
                            severity: 'warning',
                        },
                    },
                },
            });

        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        })).resolves.toEqual({
            ok: true,
            status: {
                state: 'needs_attention',
                installationId: fixtureHostInstallationId,
                diagnostic: {
                    code: 'hooks_require_approval',
                    severity: 'warning',
                },
            },
        });

        expect(actions).toEqual(['install']);
        expect(fixture.resolveInstallation).toHaveBeenCalledTimes(2);
        expect(fixture.resolveInstallation.mock.calls[0]![0]).not
            .toHaveProperty('custody');
        expect(fixture.resolveInstallation.mock.calls[1]![0])
            .toHaveProperty('custody');
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it('stages install disabled and activates only after the custody re-probe is ready', async () => {
        let installed = false;
        const actions: string[] = [];
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(async () => (
                    installed ? installationRecord('disabled') : null
                )),
                applyInstallationAction: vi.fn(async (request) => {
                    actions.push(request.action);
                    if (request.action === 'install') installed = true;
                    return {
                        ok: true as const,
                        state: request.action === 'enable'
                            ? 'installed_enabled' as const
                            : 'installed_disabled' as const,
                        changedConfiguration: request.action === 'install',
                        revision: 2,
                    };
                }),
            },
        });

        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        })).resolves.toMatchObject({
            ok: true,
            status: {
                state: 'installed_enabled',
                installationId: fixtureHostInstallationId,
            },
        });

        expect(actions).toEqual(['install', 'enable']);
        expect(fixture.resolveInstallation).toHaveBeenCalledTimes(2);
        expect(fixture.resolveInstallation.mock.calls[1]![0])
            .toHaveProperty('custody');
        expect(fixture.listener.enable).toHaveBeenCalledOnce();
    });

    it('explicit Enable keeps disabled custody when readiness still needs attention', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
            },
        });
        fixture.resolveInstallation.mockResolvedValueOnce({
            ok: true,
            value: {
                kind: 'supported',
                variantId: variant.variantId,
                targets: [{
                    targetId: 'settings',
                    absolutePath: '/tmp/agent-settings.json',
                }],
                readiness: {
                    kind: 'needs_attention',
                    diagnostic: {
                        code: 'hooks_require_approval',
                        severity: 'warning',
                    },
                },
            },
        });

        await expect(fixture.host.enable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toEqual({
            ok: true,
            status: {
                state: 'needs_attention',
                installationId: fixtureHostInstallationId,
                diagnostic: {
                    code: 'hooks_require_approval',
                    severity: 'warning',
                },
            },
        });

        expect(fixture.resolveInstallation.mock.calls[0]![0])
            .toHaveProperty('custody');
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it('keeps explicit Enable disabled when current target identity no longer matches custody', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(
                    async () => installationRecord('disabled'),
                ),
                readConfigSnapshot: vi.fn(async () => ({
                    ok: true as const,
                    snapshot: {
                        targets: [{
                            targetId: 'settings',
                            absolutePath: '/tmp/agent-settings.json',
                            collectionId: 'hooks',
                            inputIdentity: 'input-v1:changed',
                        }],
                    },
                })),
            },
        });

        await expect(fixture.host.enable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toEqual({
            ok: true,
            status: {
                state: 'needs_attention',
                installationId: fixtureHostInstallationId,
                diagnostic: {
                    code: 'hook_installation_reconciliation_required',
                    severity: 'error',
                },
            },
        });

        expect(fixture.resolveInstallation).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it('keeps staged Install disabled when its post-write target identity no longer matches custody', async () => {
        let installed = false;
        const actions: string[] = [];
        const readConfigSnapshot = vi.fn()
            .mockResolvedValueOnce({
                ok: true as const,
                snapshot: {
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                        collectionId: 'hooks',
                        inputIdentity: 'input-v1:fixture',
                    }],
                },
            })
            .mockResolvedValueOnce({
                ok: true as const,
                snapshot: {
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/tmp/agent-settings.json',
                        collectionId: 'hooks',
                        inputIdentity: 'input-v1:changed',
                    }],
                },
            });
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: vi.fn(async () => (
                    installed ? installationRecord('disabled') : null
                )),
                readConfigSnapshot,
                applyInstallationAction: vi.fn(async (request) => {
                    actions.push(request.action);
                    if (request.action === 'install') installed = true;
                    return {
                        ok: true as const,
                        state: 'installed_disabled' as const,
                        changedConfiguration: request.action === 'install',
                        revision: 2,
                    };
                }),
            },
        });

        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        })).resolves.toEqual({
            ok: true,
            status: {
                state: 'needs_attention',
                installationId: fixtureHostInstallationId,
                diagnostic: {
                    code: 'hook_installation_reconciliation_required',
                    severity: 'error',
                },
            },
        });

        expect(actions).toEqual(['install']);
        expect(readConfigSnapshot).toHaveBeenCalledTimes(2);
        expect(fixture.resolveInstallation).toHaveBeenCalledOnce();
        expect(fixture.resolveInstallation.mock.calls[0]![0]).not
            .toHaveProperty('custody');
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it.each(['install', 'enable'] as const)(
        'keeps %s custody disabled when the readiness callback rejects',
        async (action) => {
            let installed = action === 'enable';
            const actions: string[] = [];
            const fixture = createFixture({
                dependencyOverrides: {
                    readInstallationRecord: vi.fn(async () => (
                        installed ? installationRecord('disabled') : null
                    )),
                    applyInstallationAction: vi.fn(async (request) => {
                        actions.push(request.action);
                        if (request.action === 'install') installed = true;
                        return {
                            ok: true as const,
                            state: 'installed_disabled' as const,
                            changedConfiguration:
                                request.action === 'install',
                            revision: 2,
                        };
                    }),
                },
            });
            if (action === 'install') {
                fixture.resolveInstallation
                    .mockResolvedValueOnce({
                        ok: true,
                        value: {
                            kind: 'supported',
                            variantId: variant.variantId,
                            targets: [{
                                targetId: 'settings',
                                absolutePath:
                                    '/tmp/agent-settings.json',
                            }],
                            readiness: { kind: 'ready' },
                        },
                    })
                    .mockRejectedValueOnce(
                        new Error('readiness unavailable'),
                    );
            } else {
                fixture.resolveInstallation.mockRejectedValueOnce(
                    new Error('readiness unavailable'),
                );
            }

            const response = action === 'install'
                ? await fixture.host.install({
                    machineId: 'machine-1',
                    agent,
                    expectedPreviewId: fixtureExpectedPreviewId,
                })
                : await fixture.host.enable({
                    machineId: 'machine-1',
                    agent,
                    installationId: fixtureHostInstallationId,
                });

            expect(response).toEqual({
                ok: true,
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                    diagnostic: {
                        code: 'operation_failed',
                        severity: 'error',
                    },
                },
            });
            expect(actions).toEqual(
                action === 'install' ? ['install'] : [],
            );
            expect(fixture.listener.enable).not.toHaveBeenCalled();
        },
    );

    it('keeps bootstrap missing credentials and reload rotation failures non-admitted without mutating custody', async () => {
        const missing = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(fixtureHostInstallationId)],
                    diagnostics: [],
                })),
            },
        });
        missing.listener.restoreCredential.mockResolvedValue({
            state: 'unavailable',
            reason: 'missing',
        });
        missing.listener.readCredentialState.mockReturnValue({
            state: 'revoked',
        });
        await missing.host.hydrate({ reason: 'bootstrap' });
        expect(missing.listener.createOrReuseCredential).not.toHaveBeenCalled();
        expect(missing.listener.enable).not.toHaveBeenCalled();
        expect(missing.applyInstallationAction).not.toHaveBeenCalled();
        await expect(missing.host.status({
            machineId: 'machine-1',
            intent: 'passive_inventory',
            agent,
            limit: 50,
        })).resolves.toMatchObject({
            ok: true,
            rows: [{
                status: {
                    state: 'needs_attention',
                    installationId: fixtureHostInstallationId,
                    diagnostic: { code: 'listener_unavailable' },
                },
            }],
        });

        const reload = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(fixtureHostInstallationId)],
                    diagnostics: [],
                })),
            },
        });
        reload.listener.rotateCredential.mockRejectedValue(
            new Error('rotation failed'),
        );
        await reload.host.hydrate({ reason: 'plugin_reload' });
        expect(reload.listener.enable).not.toHaveBeenCalled();
        expect(reload.listener.disable).toHaveBeenCalled();
        expect(reload.applyInstallationAction).not.toHaveBeenCalled();
    });

    it('disposal awaits an active hydration page and prevents every later effect', async () => {
        let releasePage!: () => void;
        const page = new Promise<void>((resolve) => {
            releasePage = resolve;
        });
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => {
                    await page;
                    return {
                        ok: true as const,
                        records: [inventoryRecord(fixtureHostInstallationId)],
                        diagnostics: [],
                    };
                }),
            },
        });
        const hydration = fixture.host.hydrate();
        await vi.waitFor(() => {
            expect(fixture.readInventoryPage).toHaveBeenCalledOnce();
        });
        const disposal = fixture.host.dispose();
        releasePage();
        await Promise.all([hydration, disposal]);

        expect(fixture.listener.createOrReuseCredential).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
        expect(fixture.release).toHaveBeenCalledOnce();
        await fixture.host.hydrate();
        expect(fixture.readInventoryPage).toHaveBeenCalledOnce();
    });

    it('disposal during credential hydration disables the late principal and leaks no lease', async () => {
        let releaseCredential!: () => void;
        const credentialGate = new Promise<void>((resolve) => {
            releaseCredential = resolve;
        });
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: [inventoryRecord(fixtureHostInstallationId)],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(
                    async () => installationRecord(),
                ),
            },
        });
        fixture.listener.restoreCredential.mockImplementation(
            async () => {
                await credentialGate;
                return {
                    state: 'restored' as const,
                    credential: {
                        installationPrincipalRef: 'installation-principal',
                        eventPrincipalRef: 'event-principal',
                        eventId: 'session-start',
                        secretFile: '/tmp/session-start.secret',
                    },
                };
            },
        );
        const hydration = fixture.host.hydrate();
        await vi.waitFor(() => {
            expect(
                fixture.listener.restoreCredential,
            ).toHaveBeenCalledOnce();
        });
        const disposal = fixture.host.dispose();
        releaseCredential();
        await Promise.all([hydration, disposal]);

        expect(fixture.listener.enable).not.toHaveBeenCalled();
        expect(fixture.listener.disable).toHaveBeenCalledWith(
            'event-principal',
        );
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it('commits disabled custody before disabling ingress and leaves ingress unchanged on write failure', async () => {
        const order: string[] = [];
        const fixture = createFixture({
            dependencyOverrides: {
                applyInstallationAction: vi.fn(async () => {
                    order.push('custody');
                    return {
                        ok: true as const,
                        state: 'installed_disabled' as const,
                        changedConfiguration: false,
                        revision: 2,
                    };
                }),
            },
        });
        fixture.listener.disableDurableCredential.mockImplementation(() => {
            order.push('ingress');
            return { state: 'disabled' };
        });
        await expect(fixture.host.disable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            status: { state: 'installed_disabled' },
        });
        expect(order).toEqual(['custody', 'ingress']);

        const failed = createFixture({
            dependencyOverrides: {
                applyInstallationAction: async () => ({
                    ok: false,
                    code: 'write_failed',
                }),
            },
        });
        await failed.host.disable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        });
        expect(failed.listener.disableDurableCredential).not.toHaveBeenCalled();

        const listenerUnavailable = createFixture({
            listener: Promise.reject(new Error('listener unavailable')),
            dependencyOverrides: {
                applyInstallationAction: async () => ({
                    ok: true,
                    state: 'installed_disabled',
                    changedConfiguration: false,
                    revision: 2,
                }),
            },
        });
        await expect(listenerUnavailable.host.disable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: true,
            status: { state: 'installed_disabled' },
        });
    });

    it('revokes all newly-created install credentials when commit throws', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: async () => null,
                applyInstallationAction: async () => {
                    throw new Error('commit failed');
                },
            },
        });
        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'operation_failed' },
        });
        expect(fixture.listener.revokeDurableCredential).toHaveBeenCalledWith({
            qualifiedContributionId: agent,
            hostInstallationId: expect.any(String),
            installationPrincipalRef: 'installation-principal',
            eventId: 'session-start',
        });
    });

    it('rejects a stale install preview before credential, config, or custody effects', async () => {
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: async () => null,
            },
        });
        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId:
                `hook-install-preview:v1:${'0'.repeat(64)}`,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'concurrent_edit', retryable: true },
        });
        expect(fixture.listener.createOrReuseCredential).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
        expect(fixture.listener.enable).not.toHaveBeenCalled();
    });

    it('rejects a different expected preview when an otherwise-current installation already exists', async () => {
        const fixture = createFixture();

        await expect(fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: `hook-install-preview:v1:${'0'.repeat(64)}`,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'concurrent_edit', retryable: true },
        });

        expect(fixture.listener.createOrReuseCredential).not.toHaveBeenCalled();
        expect(fixture.applyInstallationAction).not.toHaveBeenCalled();
    });

    it('does not publish install or enable ingress after its runtime lease retires', async () => {
        const install = createFixture({
            dependencyOverrides: {
                readInstallationRecord: async () => null,
                applyInstallationAction: vi.fn(async () => {
                    install.setCurrent(false);
                    return {
                        ok: true as const,
                        state: 'installed_enabled' as const,
                        changedConfiguration: true,
                        revision: 2,
                    };
                }),
            },
        });
        await expect(install.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'installation_replaced' },
        });
        expect(install.listener.enable).not.toHaveBeenCalled();

        const enable = createFixture({
            dependencyOverrides: {
                applyInstallationAction: vi.fn(async () => {
                    enable.setCurrent(false);
                    return {
                        ok: true as const,
                        state: 'installed_enabled' as const,
                        changedConfiguration: false,
                        revision: 2,
                    };
                }),
            },
        });
        await expect(enable.host.enable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'installation_replaced' },
        });
        expect(enable.listener.enable).not.toHaveBeenCalled();
    });

    it.each(['install', 'enable'] as const)(
        'fails %s inside the custody commit when the feature turns off',
        async (action) => {
            let enabled = true;
            const applyInstallationAction: PluginSessionHookManagementHostDependencies[
                'applyInstallationAction'
            ] = vi.fn(async (request) => {
                enabled = false;
                return request.isCurrent && !await request.isCurrent()
                    ? {
                        ok: false as const,
                        code: 'generation_mismatch' as const,
                    }
                    : {
                        ok: true as const,
                        state: 'installed_enabled' as const,
                        changedConfiguration: false,
                        revision: 2,
                    };
            });
            const fixture = createFixture({
                isFeatureEnabled: () => enabled,
                dependencyOverrides: {
                    applyInstallationAction,
                    ...(action === 'install'
                        ? {
                            readInstallationRecord:
                                async () => null,
                        }
                        : {}),
                },
            });

            const response = action === 'install'
                ? await fixture.host.install({
                    machineId: 'machine-1',
                    agent,
                    expectedPreviewId: fixtureExpectedPreviewId,
                })
                : await fixture.host.enable({
                    machineId: 'machine-1',
                    agent,
                    installationId: fixtureHostInstallationId,
                });
            expect(response).toMatchObject({
                ok: false,
                diagnostic: { code: 'installation_replaced' },
            });
            expect(fixture.listener.enable).not.toHaveBeenCalled();
        },
    );

    it('aborts and drains an install in custody commit before listener shutdown', async () => {
        let enteredCommit!: () => void;
        const commitEntered = new Promise<void>((resolve) => {
            enteredCommit = resolve;
        });
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => {
            releaseCommit = resolve;
        });
        const applyInstallationAction: PluginSessionHookManagementHostDependencies[
            'applyInstallationAction'
        ] = vi.fn(async (request) => {
            enteredCommit();
            await commitGate;
            return request.isCurrent && !await request.isCurrent()
                ? {
                    ok: false as const,
                    code: 'generation_mismatch' as const,
                }
                : {
                    ok: true as const,
                    state: 'installed_enabled' as const,
                    changedConfiguration: false,
                    revision: 2,
                };
        });
        const fixture = createFixture({
            dependencyOverrides: {
                applyInstallationAction,
                readInstallationRecord: async () => null,
            },
        });
        const install = fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        });
        await commitEntered;
        const disposal = fixture.host.dispose();
        releaseCommit();
        await expect(install).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'installation_replaced' },
        });
        await disposal;
        expect(fixture.listener.enable).not.toHaveBeenCalled();
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it('threads caller cancellation into the canonical custody currentness fence', async () => {
        let enteredCommit!: () => void;
        const commitEntered = new Promise<void>((resolve) => {
            enteredCommit = resolve;
        });
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => {
            releaseCommit = resolve;
        });
        const applyInstallationAction: PluginSessionHookManagementHostDependencies[
            'applyInstallationAction'
        ] = vi.fn(async (request) => {
            enteredCommit();
            await commitGate;
            return request.isCurrent && !await request.isCurrent()
                ? { ok: false as const, code: 'generation_mismatch' as const }
                : {
                    ok: true as const,
                    state: 'installed_enabled' as const,
                    changedConfiguration: false,
                    revision: 2,
                };
        });
        const fixture = createFixture({
            dependencyOverrides: {
                applyInstallationAction,
                readInstallationRecord: async () => null,
            },
        });
        const caller = new AbortController();
        const install = fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        }, { signal: caller.signal });
        await commitEntered;
        caller.abort(new Error('caller canceled'));
        releaseCommit();

        await expect(install).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'installation_replaced' },
        });
        expect(fixture.listener.enable).not.toHaveBeenCalled();
        await fixture.host.dispose();
    });

    it('uninstalls custody before listener-independent credential cleanup when listener startup failed', async () => {
        const order: string[] = [];
        transportMocks.revokeDurableCredential.mockImplementation(
            async () => {
                order.push('credential');
            },
        );
        const fixture = createFixture({
            listener: Promise.reject(new Error('listener unavailable')),
            dependencyOverrides: {
                applyInstallationAction: vi.fn(async (request) => {
                    order.push(request.action);
                    return {
                        ok: true as const,
                        state: request.action === 'disable'
                            ? 'installed_disabled' as const
                            : 'not_installed' as const,
                        changedConfiguration: true,
                        revision: 2,
                    };
                }),
            },
        });
        await expect(fixture.host.uninstall({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toEqual({
            ok: true,
            status: { state: 'not_installed' },
        });
        expect(order).toEqual(['disable', 'credential', 'uninstall']);
        expect(transportMocks.revokeDurableCredential).toHaveBeenCalledWith({
            activeServerDir: '/tmp/happier-host-test',
            qualifiedContributionId: agent,
            hostInstallationId: fixtureHostInstallationId,
            installationPrincipalRef: 'installation-principal',
            eventId: 'session-start',
        });
    });

    it('keeps disabled custody retryable when durable credential revoke fails', async () => {
        const actions: string[] = [];
        transportMocks.revokeDurableCredential
            .mockRejectedValueOnce(new Error('revoke failed'))
            .mockResolvedValue(undefined);
        const fixture = createFixture({
            listener: Promise.reject(new Error('listener unavailable')),
            dependencyOverrides: {
                applyInstallationAction: vi.fn(async (request) => {
                    actions.push(request.action);
                    return {
                        ok: true as const,
                        state: request.action === 'disable'
                            ? 'installed_disabled' as const
                            : 'not_installed' as const,
                        changedConfiguration:
                            request.action === 'uninstall',
                        revision: 2,
                    };
                }),
            },
        });

        await expect(fixture.host.uninstall({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toMatchObject({
            ok: false,
            diagnostic: { code: 'operation_failed', retryable: true },
        });
        expect(actions).toEqual(['disable']);

        await expect(fixture.host.uninstall({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        })).resolves.toEqual({
            ok: true,
            status: { state: 'not_installed' },
        });
        expect(actions).toEqual(['disable', 'disable', 'uninstall']);
    });

    it('keeps repeated install credentials idempotent and does not rotate without a verified replacement', async () => {
        let recordExists = false;
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => {
            releaseCommit = resolve;
        });
        const applyInstallationAction = vi.fn(async (request) => {
            await commitGate;
            recordExists = true;
            return {
                ok: true as const,
                state: request.action === 'enable'
                    ? 'installed_enabled' as const
                    : 'installed_disabled' as const,
                changedConfiguration: request.action === 'install',
                revision: 2,
            };
        });
        const fixture = createFixture({
            dependencyOverrides: {
                readInstallationRecord: async () => (
                    recordExists ? installationRecord('disabled') : null
                ),
                applyInstallationAction,
            },
        });
        const first = fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        });
        await vi.waitFor(() => {
            expect(applyInstallationAction).toHaveBeenCalledOnce();
        });
        const second = fixture.host.install({
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        });
        expect(fixture.listener.createOrReuseCredential).toHaveBeenCalledOnce();
        releaseCommit();
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ ok: true }),
            expect.objectContaining({ ok: true }),
        ]);

        expect(fixture.listener.createOrReuseCredential).toHaveBeenCalledOnce();
        expect(applyInstallationAction).toHaveBeenCalledTimes(2);
        expect(
            fixture.listener.revokeDurableCredential,
        ).not.toHaveBeenCalled();
        expect(fixture.listener.rotateCredential).not.toHaveBeenCalled();
    });

    it('keeps the same accepted Install idempotent through the public action executor after custody exists', async () => {
        let record: ExternalSessionHookInstallationRecord | null = null;
        let configInputIdentity = 'input-v1:fixture';
        const applyInstallationAction = vi.fn<
            PluginSessionHookManagementHostDependencies[
                'applyInstallationAction'
            ]
        >(async (request) => {
            if (request.action === 'install') {
                record = installationRecord('disabled');
                return {
                    ok: true,
                    state: 'installed_disabled',
                    changedConfiguration: true,
                    revision: 1,
                };
            }
            if (request.action === 'enable') {
                record = {
                    ...record!,
                    state: 'active',
                    revision: 2,
                };
                return {
                    ok: true,
                    state: 'installed_enabled',
                    changedConfiguration: false,
                    revision: 2,
                };
            }
            throw new Error(`Unexpected action ${request.action}`);
        });
        const fixture = createFixture({
            dependencyOverrides: {
                readInventoryPage: vi.fn(async () => ({
                    ok: true as const,
                    records: record
                        ? [inventoryRecord(
                            fixtureHostInstallationId,
                            record.state,
                        )]
                        : [],
                    diagnostics: [],
                })),
                readInstallationRecord: vi.fn(async () => record),
                readConfigSnapshot: vi.fn(async () => ({
                    ok: true as const,
                    snapshot: {
                        targets: [{
                            targetId: 'settings',
                            absolutePath: '/tmp/agent-settings.json',
                            collectionId: 'hooks',
                            inputIdentity: configInputIdentity,
                        }],
                    },
                })),
                applyInstallationAction,
            },
        });
        const executor = createPluginSessionHookManagementActionExecutor({
            machineId: 'machine-1',
            readFeatureDecision: () => createFeatureDecision({
                featureId: PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 1,
                scope: {
                    scopeKind: 'runtime',
                    machineId: 'machine-1',
                },
            }),
            host: fixture.host,
        });
        const request = {
            machineId: 'machine-1',
            agent,
            expectedPreviewId: fixtureExpectedPreviewId,
        } as const;

        const first = await executor.execute(
            'plugins.sessionHooks.install',
            request,
        );
        const replay = await executor.execute(
            'plugins.sessionHooks.install',
            request,
        );
        configInputIdentity = 'input-v1:concurrent';
        const concurrent = await executor.execute(
            'plugins.sessionHooks.install',
            request,
        );
        configInputIdentity = 'input-v1:fixture';
        record = {
            ...record!,
            installationIdentity: digest(
                'agent-installation-v1',
                ['replaced-installation'],
            ),
        };
        const replaced = await executor.execute(
            'plugins.sessionHooks.install',
            request,
        );

        expect(first).toEqual({
            ok: true,
            result: {
                ok: true,
                status: {
                    state: 'installed_enabled',
                    installationId: fixtureHostInstallationId,
                },
            },
        });
        expect(replay).toEqual(first);
        expect(concurrent).toEqual({
            ok: true,
            result: {
                ok: false,
                diagnostic: {
                    code: 'concurrent_edit',
                    retryable: true,
                },
            },
        });
        expect(replaced).toEqual({
            ok: true,
            result: {
                ok: false,
                diagnostic: {
                    code: 'installation_replaced',
                    retryable: false,
                },
            },
        });
        expect(applyInstallationAction).toHaveBeenCalledTimes(2);
        expect(
            applyInstallationAction.mock.calls.map(([call]) => call.action),
        ).toEqual(['install', 'enable']);
        expect(fixture.listener.createOrReuseCredential).toHaveBeenCalledOnce();
        expect(fixture.listener.enable).toHaveBeenCalledOnce();
        expect(fixture.listener.rotateCredential).not.toHaveBeenCalled();
        expect(fixture.listener.revokeDurableCredential).not.toHaveBeenCalled();
    });

    it('serializes Enable before Uninstall so cleanup cannot be followed by principal recreation', async () => {
        const actions: string[] = [];
        let releaseEnable!: () => void;
        const enableGate = new Promise<void>((resolve) => {
            releaseEnable = resolve;
        });
        const applyInstallationAction: PluginSessionHookManagementHostDependencies[
            'applyInstallationAction'
        ] = vi.fn(async (request) => {
            actions.push(request.action);
            if (request.action === 'enable') await enableGate;
            return {
                ok: true as const,
                state: request.action === 'uninstall'
                    ? 'not_installed' as const
                    : request.action === 'disable'
                        ? 'installed_disabled' as const
                        : 'installed_enabled' as const,
                changedConfiguration:
                    request.action === 'uninstall',
                revision: 2,
            };
        });
        const fixture = createFixture({
            dependencyOverrides: { applyInstallationAction },
        });
        const enabling = fixture.host.enable({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        });
        await vi.waitFor(() => {
            expect(actions).toEqual(['enable']);
        });
        const uninstalling = fixture.host.uninstall({
            machineId: 'machine-1',
            agent,
            installationId: fixtureHostInstallationId,
        });
        expect(
            fixture.listener.revokeDurableCredential,
        ).not.toHaveBeenCalled();
        releaseEnable();
        await expect(Promise.all([enabling, uninstalling])).resolves.toEqual([
            expect.objectContaining({ ok: true }),
            expect.objectContaining({ ok: true }),
        ]);
        expect(actions).toEqual(['enable', 'disable', 'uninstall']);
        expect(
            fixture.listener.revokeDurableCredential,
        ).toHaveBeenCalledOnce();
    });
});
