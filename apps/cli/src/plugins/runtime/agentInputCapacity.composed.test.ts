import { describe, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import type { EngineAdapterResolution, CreateCliExecutionRunBackendParams, ResolvedCliEngineRegistry } from '@/agent/runtime/registry/engineRegistryTypes';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import type { AgentRuntimeDaemonServiceResponseV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonPluginServiceOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createRunnerDaemonPluginServicesHost } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readExecutionRunOfferedModel } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { TaskProfile } from '@/agent/executionRuns/profiles/task/TaskProfile';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';

describe('Codex runtime input capacity composition', () => {
    it('survives cold daemon acquisition and the retained runner declaration snapshot without model evidence', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir });
        let authority: Awaited<ReturnType<typeof createSessionDaemonAuthorityFixture>> | undefined;
        let source: Awaited<ReturnType<typeof createRunnerAgentSessionRuntimeSource>> = null;
        let servicesHost: ReturnType<typeof createRunnerDaemonPluginServicesHost> | undefined;
        try {
            // This is the actual bundled Codex declaration and executable registration.
            // Neither daemon startup nor the runner snapshot carries executable hooks.
            expect(fixture.registry.agentRuntimesByAgentId.has('codex')).toBe(false);
            expect(fixture.registry.contributes.catalogEntriesById.codex?.resolveRuntimeMaxInputUnicodeCharacters).toBeUndefined();
            const daemon = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
            const daemonResolution = await daemon.resolveForBackendId('codex');
            if (!daemonResolution) throw new Error('Missing admitted Codex runtime');
            expect(daemonResolution.diagnostics).toEqual([]);
            expect(daemonResolution.runtimeOwner.selected?.kind).toBe('plugin_engine');

            const providerSelection = ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'capacity-provider', modelId: 'provider-model',
            });
            const readNativeOfferedModel = vi.fn(async () => { throw new Error('Capacity must not discover native models'); });
            await expect(readExecutionRunOfferedModel({ backendTarget: { kind: 'backend', backendId: 'codex' },
                modelId: providerSelection.modelId, modelSelection: providerSelection, readNativeOfferedModel,
            })).resolves.toBeUndefined();
            const deliveryMode = "brokered" as const;
            const teamSelectionContext = {
            teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 2, agentTargetKey: providerSelection.agentTargetKey, modelId: 'team-model', deliveryMode },
            } as const;
            await expect(readExecutionRunOfferedModel({ backendTarget: { kind: 'backend', backendId: 'codex' },
                modelId: 'team-model', ...teamSelectionContext, readNativeOfferedModel,
            })).resolves.toBeUndefined();
            expect(readNativeOfferedModel).not.toHaveBeenCalled();

            const assertFinalizer = async (engineRegistry: ResolvedCliEngineRegistry) => {
                // Task is a reachable detached profile and does not require native
                // structured-output evidence. Its sizing rejection stops before any
                // provider Session/turn is opened, through the real finalizer.
                const profileCatalog = buildExecutionRunProfileCatalog();
                const sizingRejection = Object.assign(new Error('Profile rejected input after sizing'), {
                    executionRunErrorCode: 'execution_run_not_allowed',
                });
                let finalizedCapacity: number | undefined;
                const sizingTask = { ...TaskProfile, finalizeStartParams: async (input: Parameters<NonNullable<typeof TaskProfile.finalizeStartParams>>[0]) => {
                    finalizedCapacity = await input.resolveMaxInputUnicodeCharacters?.() ?? input.maxInputUnicodeCharacters;
                    throw sizingRejection;
                } };
                const bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
                    happyHomeDir: fixture.happyHomeDir, sendAcp: async () => {},
                    resolveRunReportPolicy: async () => ({ preset: 'important' }),
                    resolveExecutionRunProfileCatalog: () => ({ engineRegistry,
                        profileCatalog: { ...profileCatalog, builtInProfilesByIntent: new Map(profileCatalog.builtInProfilesByIntent).set('task', sizingTask) },
                        readNativeOfferedModel,
                    }),
                });
                try {
                    const started = await bridge.start({ sessionId: null, intent: 'task',
                        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Fit this task.',
                        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
                        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                    });
                    // Task is bounded (startRequest.ts); finalizer refusal settles
                    // its registered Run instead of losing the recovery handle.
                    await vi.waitFor(() => expect(bridge.get(started.runId)).toMatchObject({
                        status: 'failed', error: { code: 'execution_run_not_allowed' },
                    }));
                    expect(finalizedCapacity).toBe(1 << 20);
                    expect(readNativeOfferedModel).not.toHaveBeenCalled();
                } finally { await bridge.dispose(); }
            };

            const assertCapacity = async (resolution: EngineAdapterResolution, label: string, engineRegistry: ResolvedCliEngineRegistry) => {
                const runs: ExecutionRunHostRuntime[] = [];
                try {
                const routes = [
                    { name: 'native', selection: {} },
                    { name: 'provider', selection: { modelId: providerSelection.modelId, modelSelection: providerSelection } },
                    { name: 'team', selection: { modelId: 'team-model', ...teamSelectionContext } },
                ] as const;
                for (const route of routes) {
                    for (const backendMode of ['appServer', 'acp'] as const) {
                        const options = {
                            backendId: 'codex', scope: 'detached', cwd: fixture.happyHomeDir,
                            runId: `${label}-${backendMode}-${route.name}`,
                            permissionMode: 'read_only', ...route.selection,
                            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode } },
                            start: { intent: 'delegate', profileId: 'capacity', runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response' },
                        } satisfies CreateCliExecutionRunBackendParams;
                        const run = resolution.engineAdapter.runtimeCore.createExecutionRunBackend(options);
                        runs.push(run);
                        // Codex rust-v0.163.0's turn-input limit is a runtime fact.
                        await expect(run.prepareInputBudget?.()).resolves.toBe(backendMode === 'appServer' ? 1 << 20 : undefined);
                    }
                }
                await assertFinalizer(engineRegistry);
                } finally { await Promise.all(runs.map(run => run.dispose())); }
            };
            await assertCapacity(daemonResolution, 'daemon', daemon);

            const registration = fixture.registry.agentRuntimesByAgentId.get('codex');
            if (!registration?.hasPrimaryRuntime || !registration.sessionRunnerFactoryBinding) {
                throw new Error('Missing admitted Codex runner binding');
            }
            const binding = registration.sessionRunnerFactoryBinding;
            if ('kind' in binding) throw new Error('Codex must retain its native factory binding');
            // The remote daemon offers no Account services in this fixture.
            // Its real invocation host produces prepare/close responses and
            // availability; no handwritten PluginServices snapshot is involved.
            const unavailable = createUnavailablePluginServices();
            servicesHost = createRunnerDaemonPluginServicesHost({ createInvocation: async () => ({
                services: unavailable, resourceDescriptors: {},
                subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
                authorizeOperation: () => false,
                executeCurrentGlobalAction: unavailable.actions.execute,
                currentGlobalMcp: unavailable.mcp,
                currentGlobalExternalSessions: unavailable.sessions.external,
                dispose() {},
            }) });
            const invocationHost = servicesHost;
            authority = await createSessionDaemonAuthorityFixture({ sessionId: 'capacity-runner',
                runnerRuntimeRoot: await realpath(join(import.meta.dirname, '../../..')),
                retainedAgent: binding,
                execute: async () => { throw new Error('Capacity must not execute an Action'); },
                // The remote daemon has no Voice providers in this capacity
                // fixture; retain the real runner facet bootstrap and parser.
                dispatchService: async request => {
                    if (request.operation.kind === 'voice.authority.snapshot') {
                        return { ok: true, result: { kind: 'voice.authority.snapshot',
                            agentSourceCustody: binding.sourceCustody, providers: [],
                        } } satisfies AgentRuntimeDaemonServiceResponseV1;
                    }
                    if (!authority) throw new Error('Missing capacity fixture authority');
                    const operation = RunnerDaemonPluginServiceOperationV1Schema.parse(request.operation);
                    return { ok: true, result: await invocationHost.dispatch({
                        sessionId: request.context.sessionId, runner: authority.runner, retainedAgent: binding, operation,
                    }) } satisfies AgentRuntimeDaemonServiceResponseV1;
                },
            });
            const authorityFilePath = authority.trackedSession.agentRuntimeDaemonServiceAuthorityFilePath;
            if (!authorityFilePath) throw new Error('Missing runner authority path');
            source = await createRunnerAgentSessionRuntimeSource({
                happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
                authorityFilePath, expectedSessionId: 'capacity-runner', occurrenceId: registration.occurrenceId,
            });
            if (!source) throw new Error('Codex runner authority was not claimed');
            // Match runnerExecutionRunSnapshot: copy the declaration map before the
            // retained runtime has been prepared, then use its live contribution.
            const runner = await resolveCliEngineRegistry({
                contributes: createResolvedContributionRegistry({ agents: [source.agentContribution] }),
                backendId: source.identity.backendId, runnerAgentSessionRuntimeSource: source,
                requireRunnerAgentSessionRuntimeSource: true,
            });
            expect(runner.contributions.catalogEntriesById.codex?.resolveRuntimeMaxInputUnicodeCharacters).toBeUndefined();
            const runnerResolution = await runner.resolveForBackendId('codex');
            if (!runnerResolution) throw new Error('Missing retained Codex runtime');
            await assertCapacity(runnerResolution, 'runner', runner);
            // Demand preparation must not retrofit a competing frozen-map owner.
            expect(runner.contributions.catalogEntriesById.codex?.resolveRuntimeMaxInputUnicodeCharacters).toBeUndefined();
        } finally {
            await source?.retire?.();
            await servicesHost?.dispose();
            await authority?.close();
            await fixture.dispose();
        }
    // Reuse engineRegistry.runnerBootstrap.test.ts's real-runner composition
    // allowance: source-mode acquisition and runner cleanup share this harness.
    }, 180_000);
});
