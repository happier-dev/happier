/**
 * Composed attached-Run Team credential journey (`teams-lane-10/PLAN.md` §2.3:
 * "Use one open per running Session provider binding, or per independently
 * owned Execution Run binding.").
 *
 * Real owners, end to end: `createExecutionRunBridgeRuntime` → Run provider
 * launch → the Session client's Run host adapter → the parent Session's
 * native runtime → the Runner Agent source → the runner's daemon-service
 * client → the daemon's `startDaemonSessionControlRuntime` dispatcher guard.
 *
 * Only true boundaries are substituted: the Run's Agent (the plugin runtime
 * whose launch is the Agent process), the loopback HTTP hop between runner and
 * daemon (routed into the real dispatcher), the Home broker open (network), the
 * OS process-identity read, and the Home/session network reads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { resolveExecutionRunChildSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { reloadConfiguration } from '@/configuration';
import { PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY } from '@/daemon/agentRuntime/runnerManagedProviderPublicHandoff.fixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import {
    composeAttachedRunJourney,
    PARENT_AGENT_ID,
    PARENT_AGENT_TARGET_KEY,
    RUN_AGENT_ID,
    RUN_AGENT_TARGET_KEY,
} from './attachedRunBrokerComposition.composed.testkit';

const testState = vi.hoisted(() => ({
    controlInputs: new Map<number, unknown>(),
    nextControlPort: 44_310,
    readProcessIdentityByPid: vi.fn(),
    sessionInteractionHosts: [] as unknown[],
}));

// The daemon's loopback HTTP server is the boundary: its dispatcher input is
// captured and every runner request below is routed into it.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async (input: unknown) => {
        const port = testState.nextControlPort;
        testState.nextControlPort += 1;
        testState.controlInputs.set(port, input);
        return {
            port,
            stop: vi.fn(async () => {
                testState.controlInputs.delete(port);
            }),
        };
    }),
}));

// OS boundary: process identity of the runner.
vi.mock('@/daemon/processIdentity', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
    readProcessIdentityByPid: testState.readProcessIdentityByPid,
}));

// Home network reads (never reached for a live plain Session in this journey,
// but the Session open may consult them).
vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc: vi.fn(async () => {
        throw new Error('No Session RPC is part of this journey');
    }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: vi.fn(async () => ({
        mode: 'plain' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
    })),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId, encryptionMode: 'plain' })),
    fetchSessionByIdCompat: vi.fn(async () => null),
}));
vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>(),
    resolveManagedCliReleaseChannel: vi.fn(async () => ({ ringId: 'stable' as const })),
}));

// Observes (never replaces) the Session client's Execution Run registration so
// the test can reach the exact Run host binding production hands the bridge.
vi.mock('@/rpc/handlers/executionRuns', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/rpc/handlers/executionRuns')>();
    return {
        ...actual,
        registerExecutionRunHandlers: (
            ...args: Parameters<typeof actual.registerExecutionRunHandlers>
        ) => {
            testState.sessionInteractionHosts.push(
                (args[1] as { sessionInteractionHost?: unknown }).sessionInteractionHost,
            );
            return actual.registerExecutionRunHandlers(...args);
        },
    };
});

vi.mock('@/ui/logger', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/ui/logger')>();
    const quietMethods = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
        ...actual,
        logger: new Proxy(actual.logger, {
            get(target, property, receiver) {
                if (property in quietMethods) return Reflect.get(quietMethods, property);
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

describe('attached Execution Run Team credential binding (composed runner → daemon)', () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    let journey: Awaited<ReturnType<typeof composeAttachedRunJourney>>;

    // The process-wide registry has one terminal lifetime. Both contracts use
    // the same real composition and release it only after the suite finishes.
    beforeAll(async () => {
        journey = await composeAttachedRunJourney({
            cleanups,
            parentDeliveryMode: 'brokered',
            testState,
            envScope,
            withOptionalPromptAsset: true,
        });
    }, 180_000);

    afterAll(async () => {
        while (cleanups.length > 0) {
            await cleanups.pop()?.();
        }
        testState.controlInputs.clear();
        testState.sessionInteractionHosts.length = 0;
        testState.readProcessIdentityByPid.mockReset();
        vi.unstubAllGlobals();
        envScope.restore();
        reloadConfiguration();
    });

    it('opens independently selected and applied-parent inherited Team Runs through installed Session controls; unavailable applied state refuses before launch', async () => {
        const {
            sessionId,
            session,
            tracked,
            homeCleanups,
            openTeamCredentialProviderBinding,
            runAgent,
            startRun,
            runOpenOperations,
        } = journey;

        // --- 1. A brokered Run on B, in another Team, for another Agent and model. ---
        const selectionB: TeamCredentialProviderModelSelectionV1 = {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-b',
            teamId: 'team-b',
            expectedResourceRevision: 5,
            agentTargetKey: RUN_AGENT_TARGET_KEY,
            modelId: 'model-b' as TeamCredentialProviderModelSelectionV1['modelId'],
            deliveryMode: 'brokered',
        };
        const runB = await startRun('run-b', selectionB);
        expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(2);
        expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId,
            teamId: 'team-b',
            resourceId: 'resource-b',
            expectedResourceRevision: 5,
            deliveryMode: 'brokered',
            agentId: RUN_AGENT_ID,
            agentTargetKey: RUN_AGENT_TARGET_KEY,
            modelId: 'model-b',
            consumer: { kind: 'execution_run', executionRunId: 'run-b' },
        }));
        // What crossed the runner → daemon HTTP boundary is the Run's own selection.
        expect(runOpenOperations().at(-1)).toMatchObject({
            resourceId: 'resource-b',
            modelId: 'model-b',
            teamId: 'team-b',
            deliveryMode: 'brokered',
            agentId: RUN_AGENT_ID,
        });
        // And the Run's Agent process launched on exactly that binding.
        expect(runAgent.launches.at(-1)).toMatchObject({
            runId: 'run-b',
            providerBinding: { source: { kind: 'team_resource', resourceId: 'resource-b' }, model: { id: 'model-b' } },
            env: { [PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY]: 'scoped-brokered-resource-b' },
        });

        // --- 1b. A Run that selected nothing inherits the parent's live custody. ---
        // `PLAN.md` §2.3: "An attached Run consumes its existing host/runtime custody."
        const resolveInherited = (available: boolean) => {
            const applied = journey.readAppliedTeamCredentialModel();
            if (!applied) throw new Error('Expected the parent runtime\'s applied Team selection');
            return resolveExecutionRunChildSelection({
                lifecycle: 'attached', backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
                parent: available ? {
                    status: 'applied', backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
                    modelId: applied.modelId, teamCredentialModel: applied, connectedServices: null,
                } : { status: 'unavailable' },
            });
        };
        const inherited = resolveInherited(true);
        expect(inherited.selectionSource).toBe('inherited');
        const runInherit = await startRun('run-inherit', inherited.teamCredentialModel, PARENT_AGENT_ID);
        expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(3);
        expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId,
            teamId: 'team-a',
            resourceId: 'resource-a',
            expectedResourceRevision: 3,
            deliveryMode: 'brokered',
            agentId: PARENT_AGENT_ID,
            agentTargetKey: PARENT_AGENT_TARGET_KEY,
            modelId: 'model-a',
            consumer: { kind: 'execution_run', executionRunId: 'run-inherit' },
        }));
        // Host admission resolves omissions once; materialization consumes that
        // exact selection, just as it does for an explicit child choice.
        expect(runOpenOperations().at(-1)).toMatchObject({ teamId: 'team-a', deliveryMode: 'brokered' });
        expect(runAgent.launches.at(-1)).toMatchObject({
            runId: 'run-inherit',
            providerBinding: { source: { kind: 'team_resource', resourceId: 'resource-a' } },
            env: { [PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY]: 'scoped-brokered-resource-a' },
        });

        // --- 2. A later parent edit: the Home moves the parent Session to C. ---
        // The production writer (`setSessionModel` → V2 intent CAS). An active
        // Session answers `restart_required`; its runtime keeps custody of A.
        const editParentSelection = (ref: Readonly<{
            resourceId: string;
            teamId: string;
            expectedResourceRevision: number;
            modelId: string;
        }>) => {
            const candidate = createModelIntentV2MetadataCasCandidate({
                selection: {
                    v: 2,
                    updatedAt: 0,
                    ref: {
                        source: 'team_resource',
                        ...ref,
                        deliveryMode: 'brokered',
                        agentTargetKey: PARENT_AGENT_TARGET_KEY,
                    },
                } as Parameters<typeof createModelIntentV2MetadataCasCandidate>[0]['selection'],
            });
            session.updateMetadata((current) => candidate.update(current!));
            expect(candidate.readState().accepted).toBe(true);
        };
        editParentSelection({
            resourceId: 'resource-c',
            teamId: 'team-c',
            expectedResourceRevision: 4,
            modelId: 'model-c',
        });

        // --- 2b. Model the applied-state reader reporting unavailable during
        // the transition. Admission refuses before any broker or Agent effect;
        // the reader's transition detection is covered at its own boundary. ---
        const opensBeforeRefusal = openTeamCredentialProviderBinding.mock.calls.length;
        const launchesBeforeRefusal = runAgent.launches.length;
        const daemonOpsBeforeRefusal = runOpenOperations().length;
        expect(() => resolveInherited(false)).toThrowError(expect.objectContaining({ code: 'execution_run_parent_selection_unavailable' }));
        expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(opensBeforeRefusal);
        expect(runAgent.launches).toHaveLength(launchesBeforeRefusal);
        expect(runOpenOperations()).toHaveLength(daemonOpsBeforeRefusal);

        // --- 3. A direct Run on D after the edit, and B reopened: neither moves. ---
        const selectionD: TeamCredentialProviderModelSelectionV1 = {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-d',
            teamId: 'team-d',
            expectedResourceRevision: 2,
            agentTargetKey: RUN_AGENT_TARGET_KEY,
            modelId: 'model-d' as TeamCredentialProviderModelSelectionV1['modelId'],
            deliveryMode: 'direct',
        };
        const runD = await startRun('run-d', selectionD);
        expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            teamId: 'team-d',
            resourceId: 'resource-d',
            expectedResourceRevision: 2,
            deliveryMode: 'direct',
            agentId: RUN_AGENT_ID,
            modelId: 'model-d',
            consumer: { kind: 'execution_run', executionRunId: 'run-d' },
        }));
        expect(runAgent.launches.at(-1)).toMatchObject({
            runId: 'run-d',
            providerBinding: { source: { resourceId: 'resource-d' }, model: { id: 'model-d' } },
            env: { [PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY]: 'scoped-direct-resource-d' },
        });

        const runB2 = await startRun('run-b2', selectionB);
        expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            teamId: 'team-b',
            resourceId: 'resource-b',
            deliveryMode: 'brokered',
            agentId: RUN_AGENT_ID,
            modelId: 'model-b',
            consumer: { kind: 'execution_run', executionRunId: 'run-b2' },
        }));
        // Only the inheriting Run opened the parent's A, and only before the
        // edit; no Run ever opened the parent's new C.
        expect(openTeamCredentialProviderBinding.mock.calls
            .map(([input]) => input as Readonly<{ resourceId: string; consumer?: unknown }>)
            .filter((input) => input.consumer)
            .map((input) => input.resourceId)).toEqual(['resource-b', 'resource-a', 'resource-d', 'resource-b']);
        // And no Run rewrote its parent: the daemon still tracks A, the Home still says C.
        expect(tracked.spawnOptions).toMatchObject({
            modelSelection: { ref: { modelId: 'model-a' } },
            teamCredentialBindings: [{ resourceId: 'resource-a', teamId: 'team-a' }],
        });
        expect(session.getMetadataSnapshot()).toMatchObject({
            modelSelectionIntentV2: { ref: { resourceId: 'resource-c', modelId: 'model-c' } },
        });

        // --- 4. Unavailable applied state also refuses a model-only transition
        // on the same resource, with no native fallback. ---
        editParentSelection({
            resourceId: 'resource-a',
            teamId: 'team-a',
            expectedResourceRevision: 3,
            modelId: 'model-a2',
        });
        expect(() => resolveInherited(false)).toThrowError(expect.objectContaining({ code: 'execution_run_parent_selection_unavailable' }));
        expect(runAgent.launches).toHaveLength(launchesBeforeRefusal + 2);

        // Each Run releases its own binding through the daemon when it ends.
        const releasedBefore = homeCleanups.filter((cleanup) => cleanup.mock.calls.length > 0).length;
        await runB.dispose();
        await runInherit.dispose();
        await runD.dispose();
        await runB2.dispose();
        expect(homeCleanups.filter((cleanup) => cleanup.mock.calls.length > 0).length).toBe(releasedBefore + 4);
        expect(homeCleanups[0]).not.toHaveBeenCalled();

        // A Home refusal travels through the real runner/daemon transport. A
        // missing installed opener would instead report connection_not_found.
        const launchesBeforeHomeRefusal = runAgent.launches.length;
        openTeamCredentialProviderBinding.mockRejectedValueOnce(createProviderErrorV1('provider_authorization_changed'));
        await expect(startRun('run-inherited-home-refusal', inherited.teamCredentialModel, PARENT_AGENT_ID))
            .rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(runOpenOperations().at(-1)).toMatchObject({
            resourceId: 'resource-a', modelId: 'model-a',
            consumer: { kind: 'execution_run', executionRunId: 'run-inherited-home-refusal' },
        });
        expect(runAgent.launches).toHaveLength(launchesBeforeHomeRefusal);
    }, 180_000);

    it('SESSIONOPEN optional prompt asset producer retains available AUTO assets and reports unavailable optional extras', async () => {
        const { sessionId, promptBridge, daemonRequests } = journey;

        if (!promptBridge) throw new Error('Expected the real Runner prompt contributions bridge');
        const prompt = await promptBridge.resolvePrompt({ sessionId });
        expect(prompt.optionalPromptAssetsUnavailable).toBe(true);
        expect(prompt.promptAssetBlocks).toEqual([expect.objectContaining({
            id: 'plugin_prompt_asset.acme.public-handoff-agent/available-startup',
            scope: 'first_turn',
            text: expect.stringContaining('fixtureAgentGeneration = "G"'),
        })]);
        expect(daemonRequests.some(request => request.operation.kind === 'turn_contributions.resolve'
            && request.operation.request.kind === 'prompt'
            && request.operation.request.selectedAsset === undefined)).toBe(true);
        const excludedPrompt = await promptBridge.resolvePrompt({
            sessionId,
            excludePluginIds: ['acme.public-handoff-agent'],
        });
        expect(excludedPrompt.optionalPromptAssetsUnavailable).toBeUndefined();
        expect(excludedPrompt.promptAssetBlocks).toEqual([]);
    }, 180_000);
});
