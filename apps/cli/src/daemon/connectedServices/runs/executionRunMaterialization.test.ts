import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    readConnectedAccountRequestAuthCapabilityFile,
} from '@happier-dev/agents/request-auth';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { ConnectedServiceMaterializationBlockedError } from '../materialize/materializeConnectedServicesForSpawn';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
    createConnectedAccountPurposeBindingOwner,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';

const RUN_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
    },
} as const;

const MATERIALIZE_INPUT = {
    runId: 'run_abc',
    runnerPid: 4242,
    agentId: 'codex',
    connectedServices: RUN_BINDINGS,
    cwd: '/tmp/project',
} as const;

const REQUEST_AUTH_HTTP_PORT = 42427;

/** The immutable Agent contribution a fixture registry admits, i.e. generation G1. */
const AGENT_CONTRIBUTION_IDENTITY = Object.freeze({
    pluginId: 'happier.agent.codex',
    localId: 'codex',
    immutableGenerationId: 'gen-1',
});
const UNKNOWN_ACTIVATION_ID = '00000000-0000-4000-8000-000000000000';

const REQUEST_AUTH_CONTRIBUTIONS = {
    agentDefinitionsById: new Map([['codex', {
        identity: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
        },
        richDefinition: {
            definition: {
                connectedAccounts: [{
                    purpose: 'primary',
                    service: 'openai-codex',
                    materializationKinds: ['httpHeaders'],
                }],
            },
        },
        catalogEntry: {
            connectedAccountRequestAuthUses: [{
                purpose: 'primary',
                materialization: {
                    kind: 'httpHeaders',
                    origin: 'https://api.openai.com',
                    headerNames: ['authorization'],
                },
            }],
        },
    }]]),
} as const;

function createBridge(overrides: Partial<Parameters<typeof createExecutionRunConnectedServicesBridge>[0]> = {}) {
    const cleanupOnExit = vi.fn();
    const resolveAuthForSpawn = vi.fn(async () => ({
        env: { CODEX_HOME: '/materialized/run_abc/codex-home', [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]' },
        cleanupOnFailure: null,
        cleanupOnExit,
        connectedServicesBindings: RUN_BINDINGS,
        targetMaterializedRoot: '/materialized/run_abc/codex',
    }));
    const registerRunTargets = vi.fn();
    const unregisterRunTargets = vi.fn();
    const runnerIdentity = Object.freeze({ kind: 'tracked-runner' });
    const bridge = createExecutionRunConnectedServicesBridge({
        resolveAuthForSpawn: resolveAuthForSpawn as never,
        registerRunTargets,
        unregisterRunTargets,
        resolveRunMaterializedRoot: () => '/materialized/run_abc/codex',
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: () => ({
            identity: runnerIdentity,
            parentSessionId: 'session-1',
            isCurrent: () => true,
        }),
        acquireAgentPurposeContributions: async () => ({
            contributions: { agentDefinitionsById: new Map() },
            resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
            isCurrent: () => true,
            release: async () => undefined,
        }),
        purposeBindingOwner: {
            activatePurposeBindings: vi.fn(),
        } as never,
        requestAuthRegistry: {
            activate: vi.fn(),
            retire: vi.fn(),
        } as never,
        resolveRequestAuthHttpPort: () => REQUEST_AUTH_HTTP_PORT,
        createRedactionLease: () => ({
            add: vi.fn(),
            close: vi.fn(),
        }),
        ...overrides,
    });
    return {
        bridge,
        resolveAuthForSpawn,
        registerRunTargets,
        unregisterRunTargets,
        cleanupOnExit,
        runnerIdentity,
    };
}

describe('createExecutionRunConnectedServicesBridge', () => {
    it.each([
        {
            caseName: 'contributed Agent stays on qualified request-auth authority',
            contributions: REQUEST_AUTH_CONTRIBUTIONS,
            expectsLegacyCompatibility: false,
        },
        {
            caseName: 'legacy catalog Agent retains service-keyed compatibility',
            contributions: {
                ...REQUEST_AUTH_CONTRIBUTIONS,
                catalogEntriesById: {
                    codex: { connectedServiceIds: ['openai-codex'] as const },
                },
            },
            expectsLegacyCompatibility: true,
        },
    ])('$caseName', async ({
        contributions,
        expectsLegacyCompatibility,
    }) => {
        const materializedRoot = '/materialized/run_abc/codex';
        const capabilityPath = `${materializedRoot}/request-auth/capability.json`;
        const cleanupOrder: string[] = [];
        let activatedRunSubject:
            | Readonly<{ isCurrent(): boolean }>
            | null = null;
        const purposeLease = {
            subjectId: 'execution-run:run_abc/runner:4242/agent:codex',
            isCurrent: () => activatedRunSubject?.isCurrent() ?? true,
            resolvePurposeBinding: vi.fn(() => ({
                purpose: {
                    consumer: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    purpose: 'primary',
                },
                target: {
                    kind: 'account',
                    account: {
                        service: {
                            pluginId: 'happier.agent.codex',
                            localId: 'openai-codex',
                        },
                        accountId: 'profile_1',
                    },
                },
            })),
            listPurposeBindings: vi.fn(() => []),
            dispose: vi.fn(() => {
                cleanupOrder.push('purpose');
            }),
        };
        const activatePurposeBindings = vi.fn((input) => {
            activatedRunSubject = input.subject;
            return purposeLease;
        });
        const capturedSubject:
            { current:
            | Readonly<{
                subjectId: string;
                legacyServiceKeyedCompatibility?: true;
                isCurrent(): boolean;
                resolvePurposeUse(rawPurpose: unknown): unknown;
            }>
            | null } = { current: null };
        const requestAuthRegistry = {
            activate: vi.fn(async ({ subject }) => {
                capturedSubject.current = subject;
                expect(subject.subjectId).toBe(
                    purposeLease.subjectId,
                );
                return {
                    path: capabilityPath,
                    materializationId: 'run_abc',
                    subjectScopeDigest: 'a'.repeat(64),
                    capabilityDigest: 'b'.repeat(64),
                };
            }),
            retire: vi.fn(async () => {
                cleanupOrder.push('capability');
            }),
        };
        const cleanupOnExit = vi.fn(() => {
            cleanupOrder.push('filesystem');
        });
        const resolveAuthForSpawn = vi.fn(async (input) => {
            const qualifiedPurposeBindingSnapshot =
                input.resolveQualifiedPurposeBindingSnapshot(RUN_BINDINGS);
            const requestAuthPurposeBindings =
                qualifiedPurposeBindingSnapshot?.bindings ?? [];
            return {
                env: {
                    CODEX_HOME: '/materialized/run_abc/codex-home',
                    [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                        capabilityPath,
                },
                cleanupOnFailure: null,
                cleanupOnExit,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: materializedRoot,
                requestAuthPurposeBindings,
                qualifiedPurposeBindingSnapshot,
            };
        });
        let generationCurrent = true;
        const { bridge } = createBridge({
            resolveAuthForSpawn: resolveAuthForSpawn as never,
            acquireAgentPurposeContributions: async () => ({
                contributions,
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => generationCurrent,
                release: async () => undefined,
            }),
            purposeBindingOwner: {
                activatePurposeBindings,
            } as never,
            requestAuthRegistry: requestAuthRegistry as never,
        });

        const result = await bridge.materialize(MATERIALIZE_INPUT);

        expect(result).toMatchObject({
            ok: true,
            env: {
                [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                    capabilityPath,
            },
        });
        expect(activatePurposeBindings).toHaveBeenCalledWith({
            subject: expect.objectContaining({
                kind: 'execution_run',
                runId: 'run_abc',
                runnerPid: 4242,
                agentId: 'codex',
                isCurrent: expect.any(Function),
            }),
            purposes: [{
                consumer: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                purpose: 'primary',
            }],
            bindings: [expect.objectContaining({
                target: expect.objectContaining({ kind: 'account' }),
            })],
        });
        expect(requestAuthRegistry.activate).toHaveBeenCalledWith({
            subject: expect.objectContaining({
                subjectId: purposeLease.subjectId,
            }),
            materializedRootDir: materializedRoot,
            materializationId: 'run_abc',
            httpPort: REQUEST_AUTH_HTTP_PORT,
        });
        if (expectsLegacyCompatibility) {
            expect(
                capturedSubject.current?.legacyServiceKeyedCompatibility,
            ).toBe(true);
        } else {
            expect(capturedSubject.current).not.toHaveProperty(
                'legacyServiceKeyedCompatibility',
            );
        }
        expect(capturedSubject.current?.resolvePurposeUse({
            consumer: {
                pluginId: 'happier.agent.codex',
                localId: 'codex',
            },
            purpose: 'primary',
        })).toMatchObject({
            binding: {
                target: {
                    kind: 'account',
                },
            },
        });
        generationCurrent = false;
        expect(capturedSubject.current?.isCurrent()).toBe(false);

        if (!result.ok) throw new Error('expected materialization to succeed');
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: true });
        expect(purposeLease.dispose).toHaveBeenCalledOnce();
        expect(requestAuthRegistry.retire).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual([
            'purpose',
            'capability',
            'filesystem',
        ]);
    });

    it('preserves native run environment while snapshotting the declared purpose as explicitly unbound', async () => {
        const nativeBindings = {
            v: 1 as const,
            bindingsByServiceId: {
                'openai-codex': { source: 'native' as const },
            },
        };
        const activatePurposeBindings = vi.fn(() => ({
            subjectId: 'execution-run:run_abc/runner:4242/agent:codex',
            isCurrent: () => true,
            resolvePurposeBinding: () => null,
            listPurposeBindings: () => [],
            dispose: vi.fn(),
        }));
        const requestAuthRegistry = {
            activate: vi.fn(),
            retire: vi.fn(),
        };
        const resolveAuthForSpawn = vi.fn(async (input) => {
            const qualifiedPurposeBindingSnapshot =
                input.resolveQualifiedPurposeBindingSnapshot(nativeBindings);
            expect(qualifiedPurposeBindingSnapshot?.bindings).toEqual([]);
            return {
                env: { NATIVE_AGENT_ENV: 'unchanged' },
                cleanupOnFailure: null,
                cleanupOnExit: vi.fn(),
                connectedServicesBindings: nativeBindings,
                targetMaterializedRoot: null,
                requestAuthPurposeBindings: [],
                qualifiedPurposeBindingSnapshot,
            };
        });
        const { bridge } = createBridge({
            resolveAuthForSpawn: resolveAuthForSpawn as never,
            acquireAgentPurposeContributions: async () => ({
                contributions: REQUEST_AUTH_CONTRIBUTIONS,
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => true,
                release: async () => undefined,
            }),
            purposeBindingOwner: {
                activatePurposeBindings,
            } as never,
            requestAuthRegistry: requestAuthRegistry as never,
        });

        const result = await bridge.materialize({
            ...MATERIALIZE_INPUT,
            connectedServices: nativeBindings,
        });

        expect(result).toMatchObject({
            ok: true,
            env: { NATIVE_AGENT_ENV: 'unchanged' },
        });
        expect(activatePurposeBindings).toHaveBeenCalledWith({
            subject: expect.objectContaining({
                kind: 'execution_run',
                runId: 'run_abc',
                runnerPid: 4242,
                agentId: 'codex',
            }),
            purposes: [{
                consumer: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                purpose: 'primary',
            }],
            bindings: [],
        });
        expect(requestAuthRegistry.activate).not.toHaveBeenCalled();
    });

    it('resolves via the canonical spawn-auth owner with a run-scoped key and registers run targets', async () => {
        const { bridge, resolveAuthForSpawn, registerRunTargets } = createBridge();

        const result = await bridge.materialize(MATERIALIZE_INPUT);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        expect(result.env.CODEX_HOME).toBe('/materialized/run_abc/codex-home');
        expect(result.registration).toEqual({
            v: 1,
            activationId: result.activationId,
            runKey: 'run_abc',
            agentId: 'codex',
            // The routing id alone cannot say which build the runner is executing; the exact
            // contribution generation is what restart adoption later demands correspondence with.
            agentContribution: AGENT_CONTRIBUTION_IDENTITY,
            materializationKey: 'run_abc',
            connectedServicesBindings: RUN_BINDINGS,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
            },
            sessionDirectory: '/tmp/project',
            materializedRoot: '/materialized/run_abc/codex',
        });
        expect(JSON.stringify(result.registration)).not.toContain('codex-home');
        expect(resolveAuthForSpawn).toHaveBeenCalledTimes(1);
        expect((resolveAuthForSpawn.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
            agentId: 'codex',
            materializationKey: 'run_abc',
            connectedServicesBindingsRaw: RUN_BINDINGS,
        });
        expect(registerRunTargets).toHaveBeenCalledWith({
            runKey: 'run_abc',
            runnerPid: 4242,
            agentId: 'codex',
            materializationKey: 'run_abc',
            connectedServicesBindingsRaw: RUN_BINDINGS,
            sessionDirectory: '/tmp/project',
            sessionId: 'session-1',
            connectedServiceSelectionsEnv: expect.objectContaining({
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
            }),
        });
    });

    it('fails closed when the agent id is not a catalog agent (no resolver call)', async () => {
        const { bridge, resolveAuthForSpawn, registerRunTargets } = createBridge();

        const result = await bridge.materialize({ ...MATERIALIZE_INPUT, agentId: 'not-a-real-agent' });

        expect(result.ok).toBe(false);
        expect(resolveAuthForSpawn).not.toHaveBeenCalled();
        expect(registerRunTargets).not.toHaveBeenCalled();
    });

    it('maps blocked materialization to a fail-closed blocked result', async () => {
        const { bridge, registerRunTargets } = createBridge({
            resolveAuthForSpawn: (async () => {
                throw new ConnectedServiceMaterializationBlockedError([{
                    code: 'connected_service_credential_missing',
                    providerId: 'openai',
                    serviceId: 'openai-codex',
                    reason: 'credential missing',
                    severity: 'error',
                }] as never);
            }) as never,
        });

        const result = await bridge.materialize(MATERIALIZE_INPUT);

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
        expect(registerRunTargets).not.toHaveBeenCalled();
    });

    it('fails closed when the resolver resolves no connected auth for a connected selection', async () => {
        const { bridge } = createBridge({ resolveAuthForSpawn: (async () => null) as never });

        const result = await bridge.materialize(MATERIALIZE_INPUT);

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
    });

    it('does not admit a one-shot legacy-unfenced materialization to the run registry', async () => {
        const cleanupOnFailure = vi.fn();
        const { bridge, registerRunTargets } = createBridge({
            resolveAuthForSpawn: (async () => ({
                env: {
                    CODEX_HOME: '/materialized/run_abc/codex-home',
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
                },
                cleanupOnFailure,
                cleanupOnExit: null,
                connectedServicesBindings: RUN_BINDINGS,
                ongoingRuntimeRegistrationAllowed: false as const,
            })) as never,
        });

        await expect(bridge.materialize(MATERIALIZE_INPUT)).resolves.toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
        expect(cleanupOnFailure).toHaveBeenCalledOnce();
        expect(registerRunTargets).not.toHaveBeenCalled();
    });

    it('release unregisters run targets and runs the retained cleanup exactly once', async () => {
        const { bridge, unregisterRunTargets, cleanupOnExit } = createBridge();

        const result = await bridge.materialize(MATERIALIZE_INPUT);
        if (!result.ok) throw new Error('expected materialization to succeed');
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: true });
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: false });

        expect(unregisterRunTargets).toHaveBeenCalledWith('run_abc');
        expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    });

    it('does not let a stale runner PID release the current run authority or targets', async () => {
        const { bridge, unregisterRunTargets, cleanupOnExit } = createBridge();

        const result = await bridge.materialize(MATERIALIZE_INPUT);
        if (!result.ok) throw new Error('expected materialization to succeed');
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 9999,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: false });

        expect(unregisterRunTargets).not.toHaveBeenCalled();
        expect(cleanupOnExit).not.toHaveBeenCalled();
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: true });
    });

    it('retires only the exact tracked runner identity observed at parent exit', async () => {
        const {
            bridge,
            runnerIdentity,
            unregisterRunTargets,
            cleanupOnExit,
        } = createBridge();
        const result = await bridge.materialize(MATERIALIZE_INPUT);
        if (!result.ok) throw new Error('expected materialization to succeed');

        await bridge.releaseForRunnerExit({
            runnerPid: 4242,
            runnerIdentity: Object.freeze({ kind: 'replacement-runner' }),
        });
        expect(unregisterRunTargets).not.toHaveBeenCalled();
        expect(cleanupOnExit).not.toHaveBeenCalled();

        await bridge.releaseForRunnerExit({
            runnerPid: 4242,
            runnerIdentity,
        });
        expect(unregisterRunTargets).toHaveBeenCalledWith('run_abc');
        expect(cleanupOnExit).toHaveBeenCalledOnce();
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        }))
            .resolves.toEqual({ ok: true, released: false });
    });

    it('waits for a resolve-pending exited runner attempt and cleans its root and contribution lease', async () => {
        let finishResolution!: () => void;
        let markResolutionStarted!: () => void;
        const resolutionStarted = new Promise<void>((resolve) => {
            markResolutionStarted = resolve;
        });
        const resolutionGate = new Promise<void>((resolve) => {
            finishResolution = resolve;
        });
        const runnerIdentity = Object.freeze({ kind: 'exiting-runner' });
        let runnerCurrent = true;
        const exactRootCleanup = vi.fn();
        const createAdoptedRootCleanup = vi.fn(() => exactRootCleanup);
        const contributionRelease = vi.fn(async () => undefined);
        const { bridge, registerRunTargets } = createBridge({
            captureRunnerIdentity: () => ({
                identity: runnerIdentity,
                parentSessionId: 'session-1',
                isCurrent: () => runnerCurrent,
            }),
            acquireAgentPurposeContributions: async () => ({
                contributions: { agentDefinitionsById: new Map() },
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => true,
                release: contributionRelease,
            }),
            resolveAuthForSpawn: (async () => {
                markResolutionStarted();
                await resolutionGate;
                return {
                    env: { CODEX_HOME: '/materialized/run_abc/codex-home' },
                    cleanupOnFailure: null,
                    cleanupOnExit: null,
                    connectedServicesBindings: RUN_BINDINGS,
                    targetMaterializedRoot: '/materialized/run_abc/codex',
                };
            }) as never,
            createAdoptedRootCleanup,
        });

        const materialization = bridge.materialize(MATERIALIZE_INPUT);
        await resolutionStarted;
        runnerCurrent = false;
        let exitCleanupSettled = false;
        const exitCleanup = bridge.releaseForRunnerExit({
            runnerPid: 4242,
            runnerIdentity,
        }).then(() => {
            exitCleanupSettled = true;
        });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(exitCleanupSettled).toBe(false);

        finishResolution();
        await expect(materialization).resolves.toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
        await exitCleanup;
        expect(createAdoptedRootCleanup).toHaveBeenCalledWith({
            runKey: 'run_abc',
            agentId: 'codex',
            materializedRoot: '/materialized/run_abc/codex',
        });
        expect(exactRootCleanup).toHaveBeenCalledOnce();
        expect(contributionRelease).toHaveBeenCalledOnce();
        expect(registerRunTargets).not.toHaveBeenCalled();
    });

    it('cleans materialized root and contribution when post-resolution setup fails', async () => {
        const cleanupOnFailure = vi.fn();
        const contributionRelease = vi.fn(async () => undefined);
        const { bridge, registerRunTargets } = createBridge({
            resolveAuthForSpawn: (async () => ({
                env: { CODEX_HOME: '/materialized/run_abc/codex-home' },
                cleanupOnFailure,
                cleanupOnExit: vi.fn(),
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: '/materialized/run_abc/codex',
            })) as never,
            resolveRunMaterializedRoot: () => {
                throw new Error('root lookup failed');
            },
            acquireAgentPurposeContributions: async () => ({
                contributions: { agentDefinitionsById: new Map() },
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => true,
                release: contributionRelease,
            }),
        });

        await expect(bridge.materialize(MATERIALIZE_INPUT)).resolves.toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
        expect(cleanupOnFailure).toHaveBeenCalledOnce();
        expect(contributionRelease).toHaveBeenCalledOnce();
        expect(registerRunTargets).not.toHaveBeenCalled();
    });

    it('unregisters a possibly-partial target registration and uses failure cleanup before admission', async () => {
        const cleanupOnFailure = vi.fn();
        const cleanupOnExit = vi.fn();
        const contributionRelease = vi.fn(async () => undefined);
        const unregisterRunTargets = vi.fn();
        const { bridge } = createBridge({
            resolveAuthForSpawn: (async () => ({
                env: { CODEX_HOME: '/materialized/run_abc/codex-home' },
                cleanupOnFailure,
                cleanupOnExit,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: '/materialized/run_abc/codex',
            })) as never,
            registerRunTargets: () => {
                throw new Error('partial registration failed');
            },
            unregisterRunTargets,
            acquireAgentPurposeContributions: async () => ({
                contributions: { agentDefinitionsById: new Map() },
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => true,
                release: contributionRelease,
            }),
        });

        await expect(bridge.materialize(MATERIALIZE_INPUT)).resolves.toMatchObject({
            ok: false,
            errorCode: 'connected_service_run_materialization_blocked',
        });
        expect(unregisterRunTargets).toHaveBeenCalledWith('run_abc');
        expect(cleanupOnFailure).toHaveBeenCalledOnce();
        expect(cleanupOnExit).not.toHaveBeenCalled();
        expect(contributionRelease).toHaveBeenCalledOnce();
    });

    it('fully cleans prior same-key ownership before starting replacement materialization', async () => {
        let finishOldCleanup!: () => void;
        const oldCleanup = new Promise<void>((resolve) => {
            finishOldCleanup = resolve;
        });
        const resolveAuthForSpawn = vi.fn()
            .mockResolvedValueOnce({
                env: { CODEX_HOME: '/materialized/run_abc/old' },
                cleanupOnFailure: null,
                cleanupOnExit: () => oldCleanup,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: '/materialized/run_abc/codex',
            })
            .mockResolvedValueOnce({
                env: { CODEX_HOME: '/materialized/run_abc/new' },
                cleanupOnFailure: null,
                cleanupOnExit: vi.fn(),
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: '/materialized/run_abc/codex',
            });
        const { bridge } = createBridge({
            resolveAuthForSpawn: resolveAuthForSpawn as never,
        });
        await bridge.materialize(MATERIALIZE_INPUT);

        const replacement = bridge.materialize(MATERIALIZE_INPUT);
        await Promise.resolve();
        await Promise.resolve();
        expect(resolveAuthForSpawn).toHaveBeenCalledTimes(1);

        finishOldCleanup();
        await expect(replacement).resolves.toMatchObject({ ok: true });
        expect(resolveAuthForSpawn).toHaveBeenCalledTimes(2);
    });

    it('does not let stale same-PID cleanup retire a replacement activation', async () => {
        const { bridge, unregisterRunTargets } = createBridge();
        const first = await bridge.materialize(MATERIALIZE_INPUT);
        const second = await bridge.materialize(MATERIALIZE_INPUT);
        if (!first.ok || !second.ok) {
            throw new Error('expected both materializations to succeed');
        }
        const firstActivationId =
            first.activationId;
        const secondActivationId =
            second.activationId;

        unregisterRunTargets.mockClear();
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: firstActivationId,
        })).resolves.toEqual({ ok: true, released: false });
        expect(unregisterRunTargets).not.toHaveBeenCalled();

        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: secondActivationId,
        })).resolves.toEqual({ ok: true, released: true });
        expect(unregisterRunTargets).toHaveBeenCalledOnce();
    });

    it('serializes concurrent same-key materialization through one exact activation owner', async () => {
        let releaseFirstResolution!: () => void;
        let markFirstResolutionEntered!: () => void;
        const firstResolutionEntered = new Promise<void>((resolve) => {
            markFirstResolutionEntered = resolve;
        });
        const firstResolutionGate = new Promise<void>((resolve) => {
            releaseFirstResolution = resolve;
        });
        const firstCleanup = vi.fn();
        const secondCleanup = vi.fn();
        const resolveAuthForSpawn = vi.fn(async () => {
            const attempt = resolveAuthForSpawn.mock.calls.length;
            if (attempt === 1) {
                markFirstResolutionEntered();
                await firstResolutionGate;
            }
            return {
                env: {
                    CODEX_HOME:
                        `/materialized/run_abc/attempt-${attempt}`,
                },
                cleanupOnFailure: null,
                cleanupOnExit:
                    attempt === 1 ? firstCleanup : secondCleanup,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot:
                    '/materialized/run_abc/codex',
            };
        });
        const { bridge, unregisterRunTargets } = createBridge({
            resolveAuthForSpawn: resolveAuthForSpawn as never,
        });

        const firstPromise = bridge.materialize(MATERIALIZE_INPUT);
        await firstResolutionEntered;
        const secondPromise = bridge.materialize(MATERIALIZE_INPUT);
        await Promise.resolve();
        await Promise.resolve();
        expect(resolveAuthForSpawn).toHaveBeenCalledTimes(1);

        releaseFirstResolution();
        const first = await firstPromise;
        const second = await secondPromise;
        if (!first.ok || !second.ok) {
            throw new Error('expected both materializations to succeed');
        }
        const firstActivationId =
            first.activationId;
        const secondActivationId =
            second.activationId;
        expect(firstActivationId).not.toBe(secondActivationId);
        expect(firstCleanup).toHaveBeenCalledOnce();
        expect(secondCleanup).not.toHaveBeenCalled();

        unregisterRunTargets.mockClear();
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: firstActivationId,
        })).resolves.toEqual({ ok: true, released: false });
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: secondActivationId,
        })).resolves.toEqual({ ok: true, released: true });
        expect(unregisterRunTargets).toHaveBeenCalledOnce();
        expect(secondCleanup).toHaveBeenCalledOnce();
    });

    it('release is a safe no-op for unknown runs', async () => {
        const { bridge, unregisterRunTargets } = createBridge();

        await expect(bridge.release({
            runId: 'run_unknown',
            runnerPid: 1,
            activationId: UNKNOWN_ACTIVATION_ID,
        }))
            .resolves.toEqual({ ok: true, released: false });
        expect(unregisterRunTargets).not.toHaveBeenCalled();
    });

    it('shares concurrent cleanup, retains failure for retry, and deletes only after success', async () => {
        let rejectFirst!: (error: Error) => void;
        const first = new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const cleanup = vi.fn()
            .mockImplementationOnce(() => first)
            .mockResolvedValueOnce(undefined);
        const { bridge } = createBridge({
            resolveAuthForSpawn: (async () => ({
                env: { CODEX_HOME: '/materialized/run_abc/codex-home' },
                cleanupOnFailure: null,
                cleanupOnExit: cleanup,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: '/materialized/run_abc/codex',
            })) as never,
        });
        const result = await bridge.materialize(MATERIALIZE_INPUT);
        if (!result.ok) throw new Error('expected materialization to succeed');

        const releaseInput = {
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: result.activationId,
        };
        const releaseOne = bridge.release(releaseInput);
        const releaseTwo = bridge.release(releaseInput);
        rejectFirst(new Error('busy'));
        await expect(Promise.all([releaseOne, releaseTwo])).resolves.toEqual([
            { ok: true, released: false },
            { ok: true, released: true },
        ]);
        await expect(bridge.release(releaseInput))
            .resolves.toEqual({ ok: true, released: false });
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('passively adopts exact cleanup state without running it', async () => {
        const adoptedCleanup = vi.fn(async () => undefined);
        const { bridge, registerRunTargets } = createBridge({
            createAdoptedRootCleanup: ({ materializedRoot }) =>
                materializedRoot === '/materialized/run_abc/codex' ? adoptedCleanup : null,
        });
        const registration = {
            v: 1 as const,
            activationId: '11111111-1111-4111-8111-111111111111',
            runKey: 'run_abc',
            agentId: 'codex' as const,
            agentContribution: AGENT_CONTRIBUTION_IDENTITY,
            materializationKey: 'run_abc',
            connectedServicesBindings: RUN_BINDINGS,
            connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]' },
            sessionDirectory: '/tmp/project',
            materializedRoot: '/materialized/run_abc/codex',
        };

        await expect(bridge.adoptLiveMaterialization({
            runId: 'different-run',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: registration,
        })).resolves.toBe(false);

        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_abc',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: registration,
        })).resolves.toBe(true);
        expect(adoptedCleanup).not.toHaveBeenCalled();
        expect(registerRunTargets).toHaveBeenCalledWith(expect.objectContaining({
            runKey: 'run_abc',
            runnerPid: 4242,
            sessionId: 'session-1',
        }));
    });

    it('rotates the old capability during exact restart adoption and retires the new authority on release', async () => {
        const materializedRoot = await mkdtemp(
            join(tmpdir(), 'happier-run-request-auth-'),
        );
        const capabilityPath =
            `${materializedRoot}/request-auth/capability.json`;
        const binding = {
            purpose: {
                consumer: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                purpose: 'primary',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: {
                        pluginId: 'happier.agent.codex',
                        localId: 'openai-codex',
                    },
                    accountId: 'profile_1',
                },
            },
        };
        const use = {
            purpose: binding.purpose,
            materialization: {
                kind: 'httpHeaders' as const,
                origin: 'https://api.openai.com',
                headerNames: ['authorization'],
            },
        };
        const oldRegistry =
            createConnectedAccountRequestAuthSubjectRegistry();
        const oldDescriptor = await oldRegistry.activate({
            subject: {
                subjectId: 'old-daemon/run_abc',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => ({ binding, use }),
                listPurposeUses: () => [{ binding, use }],
            },
            materializedRootDir: materializedRoot,
            materializationId: 'run_abc',
            httpPort: REQUEST_AUTH_HTTP_PORT,
        });
        const oldDocument =
            await readConnectedAccountRequestAuthCapabilityFile(
                capabilityPath,
            );
        if (!oldDocument) {
            throw new Error('expected old capability');
        }

        let storeValue: QualifiedConnectedAccountPurposeBindingsV1 = {
            v: 1,
            bindings: [],
        };
        const purposeBindingOwner =
            createConnectedAccountPurposeBindingOwner({
                store: {
                    read: async () => storeValue,
                    update: async (mutate) => {
                        storeValue = mutate(storeValue);
                        return storeValue;
                    },
                    subscribe: () => ({ dispose: () => undefined }),
                },
                selectTarget: async () => binding.target,
                resolveTarget: async () => ({
                    displayName: 'Profile 1',
                    account: binding.target.account,
                }),
                materializeAccount: async () => ({
                    kind: 'environment',
                    env: {},
                }),
                async projectTargetAccounts() {
                    throw new Error('target-scoped listing is outside execution-run adoption');
                },
                async assertTargetAccountMaterializable() {
                    throw new Error('listed-account materialization is outside execution-run adoption');
                },
            });
        const restartedRegistry =
            createConnectedAccountRequestAuthSubjectRegistry();
        const adoptedCleanup = vi.fn(async () => undefined);
        const { bridge } = createBridge({
            resolveRunMaterializedRoot: () => materializedRoot,
            createAdoptedRootCleanup: () => adoptedCleanup,
            acquireAgentPurposeContributions: async () => ({
                contributions: REQUEST_AUTH_CONTRIBUTIONS,
                resolveAgentContributionIdentity: async () => AGENT_CONTRIBUTION_IDENTITY,
                isCurrent: () => true,
                release: async () => undefined,
            }),
            purposeBindingOwner,
            requestAuthRegistry: restartedRegistry,
        });
        const registration = {
            v: 1 as const,
            activationId: '22222222-2222-4222-8222-222222222222',
            runKey: 'run_abc',
            agentId: 'codex' as const,
            agentContribution: AGENT_CONTRIBUTION_IDENTITY,
            materializationKey: 'run_abc',
            connectedServicesBindings: RUN_BINDINGS,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
            },
            sessionDirectory: '/tmp/project',
            materializedRoot,
        };

        try {
            await expect(bridge.adoptLiveMaterialization({
                runId: 'run_abc',
                runnerPid: 4242,
                sessionId: 'session-1',
                persistedLaunch: registration,
            })).resolves.toBe(true);
            const currentDocument =
                await readConnectedAccountRequestAuthCapabilityFile(
                    capabilityPath,
                );
            expect(currentDocument?.capability).toBeTruthy();
            expect(currentDocument?.capability).not.toBe(
                oldDocument.capability,
            );
            expect(
                restartedRegistry.authenticate(oldDocument.capability),
            ).toBeNull();
            expect(
                restartedRegistry.authenticate(currentDocument?.capability),
            ).toMatchObject({
                subjectId: 'execution-run:run_abc/runner:4242/agent:codex',
            });
            expect(adoptedCleanup).not.toHaveBeenCalled();

            await expect(bridge.release({
                runId: 'run_abc',
                runnerPid: 4242,
                activationId: registration.activationId,
            })).resolves.toEqual({ ok: true, released: true });
            expect(
                restartedRegistry.authenticate(currentDocument?.capability),
            ).toBeNull();
            expect(
                await readConnectedAccountRequestAuthCapabilityFile(
                    capabilityPath,
                ),
            ).toBeNull();
            expect(adoptedCleanup).toHaveBeenCalledOnce();
        } finally {
            await oldRegistry.retire(oldDescriptor).catch(() => undefined);
            await rm(materializedRoot, { recursive: true, force: true });
        }
    });

    // Restart adoption reconstructs purposes and request-auth uses from the registry current at
    // restart. Accepting a live G1 runner while deriving G2 declarations would run Agent code
    // against a different credential/request-auth ABI, so the two must correspond exactly.
    it.each([
        {
            label: 'the Agent generation moved from G1 to G2',
            currentIdentity: { ...AGENT_CONTRIBUTION_IDENTITY, immutableGenerationId: 'gen-2' },
            launched: AGENT_CONTRIBUTION_IDENTITY,
        },
        {
            label: 'the Agent now comes from a different plugin',
            currentIdentity: { ...AGENT_CONTRIBUTION_IDENTITY, pluginId: 'someone.else.codex' },
            launched: AGENT_CONTRIBUTION_IDENTITY,
        },
        {
            label: 'the registry can no longer prove any generation',
            currentIdentity: null,
            launched: AGENT_CONTRIBUTION_IDENTITY,
        },
        {
            label: 'the persisted record never proved a generation',
            currentIdentity: AGENT_CONTRIBUTION_IDENTITY,
            launched: undefined,
        },
    ])('refuses restart adoption when $label', async ({ currentIdentity, launched }) => {
        const activatePurposeBindings = vi.fn();
        const requestAuthRegistry = { activate: vi.fn(), retire: vi.fn() };
        const release = vi.fn(async () => undefined);
        const { bridge, registerRunTargets } = createBridge({
            acquireAgentPurposeContributions: async () => ({
                contributions: REQUEST_AUTH_CONTRIBUTIONS,
                resolveAgentContributionIdentity: async () => currentIdentity,
                isCurrent: () => true,
                release,
            }),
            purposeBindingOwner: { activatePurposeBindings } as never,
            requestAuthRegistry: requestAuthRegistry as never,
        });

        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_abc',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: {
                v: 1 as const,
                activationId: '33333333-3333-4333-8333-333333333333',
                runKey: 'run_abc',
                agentId: 'codex' as const,
                ...(launched ? { agentContribution: launched } : {}),
                materializationKey: 'run_abc',
                connectedServicesBindings: RUN_BINDINGS,
                connectedServiceSelectionsEnv: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
                },
                sessionDirectory: '/tmp/project',
                materializedRoot: null,
            },
        })).resolves.toBe(false);

        expect(activatePurposeBindings).not.toHaveBeenCalled();
        expect(requestAuthRegistry.activate).not.toHaveBeenCalled();
        expect(registerRunTargets).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalled();
    });

    it('retains exact adopted-root cleanup when authority activation is rejected', async () => {
        const adoptedCleanup = vi.fn(async () => undefined);
        const activatePurposeBindings = vi.fn();
        const requestAuthRegistry = { activate: vi.fn(), retire: vi.fn() };
        const release = vi.fn(async () => undefined);
        const {
            bridge,
            registerRunTargets,
            runnerIdentity,
            unregisterRunTargets,
        } = createBridge({
            createAdoptedRootCleanup: ({ materializedRoot }) =>
                materializedRoot === '/materialized/run_abc/codex'
                    ? adoptedCleanup
                    : null,
            acquireAgentPurposeContributions: async () => ({
                contributions: REQUEST_AUTH_CONTRIBUTIONS,
                resolveAgentContributionIdentity: async () => ({
                    ...AGENT_CONTRIBUTION_IDENTITY,
                    immutableGenerationId: 'gen-2',
                }),
                isCurrent: () => true,
                release,
            }),
            purposeBindingOwner: { activatePurposeBindings } as never,
            requestAuthRegistry: requestAuthRegistry as never,
        });
        const registration = {
            v: 1 as const,
            activationId: '44444444-4444-4444-8444-444444444444',
            runKey: 'run_abc',
            agentId: 'codex' as const,
            agentContribution: AGENT_CONTRIBUTION_IDENTITY,
            materializationKey: 'run_abc',
            connectedServicesBindings: RUN_BINDINGS,
            connectedServiceSelectionsEnv: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
            },
            sessionDirectory: '/tmp/project',
            materializedRoot: '/materialized/run_abc/codex',
        };

        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_abc',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: registration,
        })).resolves.toBe(false);

        // A rejected authority adoption is cleanup-only: it must not activate
        // targets, purpose bindings, or fresh request-auth capability state.
        expect(activatePurposeBindings).not.toHaveBeenCalled();
        expect(requestAuthRegistry.activate).not.toHaveBeenCalled();
        expect(registerRunTargets).not.toHaveBeenCalled();
        expect(adoptedCleanup).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();

        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: registration.activationId,
        })).resolves.toEqual({ ok: true, released: true });
        await bridge.releaseForRunnerExit({
            runnerPid: 4242,
            runnerIdentity,
        });

        expect(unregisterRunTargets).not.toHaveBeenCalled();
        expect(adoptedCleanup).toHaveBeenCalledOnce();
    });

    it('refuses a conflicting live run key without displacing incumbent cleanup custody', async () => {
        const incumbentCleanup = vi.fn(async () => undefined);
        const createAdoptedRootCleanup = vi.fn(() =>
            vi.fn(async () => undefined),
        );
        const incumbentRunnerIdentity = Object.freeze({
            kind: 'incumbent-runner',
        });
        const conflictingRunnerIdentity = Object.freeze({
            kind: 'conflicting-runner',
        });
        const { bridge } = createBridge({
            captureRunnerIdentity: ({ runnerPid }) => ({
                identity: runnerPid === 4242
                    ? incumbentRunnerIdentity
                    : conflictingRunnerIdentity,
                parentSessionId: 'session-1',
                isCurrent: () => true,
            }),
            createAdoptedRootCleanup,
            resolveAuthForSpawn: async () => ({
                env: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[]',
                },
                cleanupOnFailure: null,
                cleanupOnExit: incumbentCleanup,
                connectedServicesBindings: RUN_BINDINGS,
                targetMaterializedRoot: null,
            }),
        });
        const incumbent = await bridge.materialize(MATERIALIZE_INPUT);
        if (!incumbent.ok) throw new Error('expected incumbent materialization');

        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_abc',
            runnerPid: 4343,
            sessionId: 'session-1',
            persistedLaunch: {
                ...incumbent.registration,
                materializedRoot: '/materialized/conflicting-run/codex',
            },
        })).resolves.toBe(false);

        // The collision cannot safely become a second owner under the same
        // run key. It must neither manufacture an unowned cleanup closure nor
        // evict the incumbent's exact release/exit cleanup.
        expect(createAdoptedRootCleanup).not.toHaveBeenCalled();
        await expect(bridge.release({
            runId: 'run_abc',
            runnerPid: 4242,
            activationId: incumbent.activationId,
        })).resolves.toEqual({ ok: true, released: true });
        expect(incumbentCleanup).toHaveBeenCalledOnce();
    });

    // A predecessor-shaped record carries no Agent generation at all, so it is unproven by
    // construction. Its runner keeps running; it simply does not receive fresh authority.
    it('refuses to upgrade a predecessor-shaped record into fresh request-auth authority', async () => {
        const { bridge, registerRunTargets } = createBridge();
        const predecessorLaunch = {
            v: 1 as const,
            runKey: 'execution_run:11111111-1111-4111-8111-111111111111',
            agentId: 'codex',
            connectedServicesBindings: RUN_BINDINGS,
            runtimeAccountIdentitySelections: [],
            connectedServiceSelectionsJson: JSON.stringify([{
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'profile_1',
            }]),
            sessionDirectory: '/tmp/project',
            materializedRoot: null,
        };

        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_not-a-uuid',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: predecessorLaunch,
        })).resolves.toBe(false);
        await expect(bridge.adoptLiveMaterialization({
            runId: 'run_22222222-2222-4222-8222-222222222222',
            runnerPid: 4242,
            sessionId: 'session-1',
            persistedLaunch: predecessorLaunch,
        })).resolves.toBe(false);
        expect(registerRunTargets).not.toHaveBeenCalled();
    });
});
