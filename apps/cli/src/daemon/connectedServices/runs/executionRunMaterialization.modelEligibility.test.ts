import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    buildConnectedServiceCredentialRecord,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
    sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import type { ApiClient } from '@/api/api';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { ExecutionRunRejectedStartError } from '@/agent/runtime/bridges/executionRun/errors';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { getConnectedServiceRuntimeAuthAdapter } from '../catalogHooks';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';
import type { ConnectedServiceRunMaterializationHandlerResult } from './materializeContract';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const serviceId = 'happier.agent.codex/openai-codex';
const modelId = 'gpt-6.1-sol';
const memberIds = ['first', 'second', 'third'];
const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const runId = 'composed-model-run';
const runnerPid = 4242;
type Materialization = Extract<ConnectedServiceRunMaterializationHandlerResult, { ok: true }>;

async function createScenario() {
    const root = await mkdtemp(join(tmpdir(), 'happier-run-model-proof-'));
    const baseDir = join(root, 'materialized');
    const credentials = { token: 'test-server-token', encryption: null };
    let currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: { service, groupId: 'pool' }, incarnation: 'pool-row', displayName: 'Pool',
        policy: { autoSwitch: true, maxSwitchesPerTurn: 1, maxSwitchesPerSessionHour: 1 },
        activeConnectedAccountId: memberIds[0], generation: 7, runtimeStateRevision: 0, state: {},
        createdAt: 1, updatedAt: 1,
        members: memberIds.map((connectedAccountId, priority) => ({
            v: 1, connectedAccountId, priority, enabled: true, state: {}, createdAt: 1, updatedAt: 1,
        })),
    });
    const initialGroup = currentGroup;
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service,
        accounts: memberIds.map((accountId) => ({
            ref: { service, accountId }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationReady: true, configurationRevision: null, scopes: [],
        })),
    });
    const records = new Map(memberIds.map((profileId) => [profileId, buildConnectedServiceCredentialRecord({
        now: 1, serviceId: 'openai-codex', profileId, kind: 'oauth', expiresAt: null,
        oauth: { accessToken: `test-access-${profileId}`, refreshToken: `test-refresh-${profileId}`, idToken: null,
            scope: null, tokenType: null, providerAccountId: `test-account-${profileId}`, providerEmail: null },
    })]));
    const credentialReads: string[] = [];
    // The API responses are the external Home/credential transport boundary. Selection,
    // envelope opening, purpose admission, plugin materialization and pool state stay real.
    const api = {
        getAccountEncryptionMode: async () => 'plain',
        getConnectedServiceCredentialPlain: async (input: { profileId: string }) => {
            credentialReads.push(input.profileId);
            return { revisionSemantics: 'revisioned', credentialRevision: revision,
                content: { t: 'plain', v: records.get(input.profileId) } };
        },
    } as unknown as ApiClient;
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController, credentials,
        getAccountEncryptionMode: async () => 'plain',
        readCredential: async ({ ref }) => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: records.get(ref.accountId), randomBytes: (length) => new Uint8Array(length) }),
            metadata: { scopes: [] },
        }),
        configuration: { read: async () => null, secrets: {
            admit: async () => undefined, has: async () => false, read: async () => null,
        } },
    });
    const purposeOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }),
            update: async (mutate) => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('No interactive selection in a finite Run'); },
        resolveTarget: async (target) => ({ displayName: 'Fixture account',
            account: target.kind === 'account' ? target.account
                : { service, accountId: currentGroup.activeConnectedAccountId! },
            ...(target.kind === 'group' ? { group: { groupId: 'pool', generation: currentGroup.generation } } : {}),
        }),
        materializeAccount: async ({ account, request, credentialRevisionBasis, signal }) => {
            const receipt = await established.invokeWithReceipt({ account, operation: { kind: 'materialize', request }, signal });
            credentialRevisionBasis?.captureCredentialRevision(receipt.basis.credentialRevision);
            return receipt.result;
        },
        resolveCredentialRevision: async (account, signal) => established.readCredentialRevision({ account, signal }),
        projectTargetAccounts: async () => { throw new Error('No account listing in this recipe'); },
        assertTargetAccountMaterializable: async () => { throw new Error('No listed account materialization in this recipe'); },
    });
    const runtimeLease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: root, pluginIds: ['happier.agent.codex'], connectedAccounts: purposeOwner,
            qualifiedConnectedAccountEstablishedRuntimeOwner: established,
            resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
                registeredRootId: `composed-run-fixture:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
        }),
    });
    const commits: string[] = [];
    const authAdapter = await getConnectedServiceRuntimeAuthAdapter('codex');
    if (!authAdapter) throw new Error('Admitted Codex classifier unavailable');
    const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
        token: credentials.token, quotaFreshnessMs: 60_000, nowMs: () => 1_000,
        api: {
            readGroup: async () => currentGroup, listAccounts: async () => accounts,
            setActiveAccount: async (input) => {
                commits.push(input.mutation.connectedAccountId);
                currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup,
                    activeConnectedAccountId: input.mutation.connectedAccountId, generation: currentGroup.generation + 1 });
                return currentGroup;
            },
            updateRuntimeState: async (input) => {
                currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup,
                    runtimeStateRevision: currentGroup.runtimeStateRevision + 1,
                    members: currentGroup.members.map((member) => ({ ...member,
                        state: input.patch.runtimeState.memberStates.find((state) => state.connectedAccountId === member.connectedAccountId)?.state ?? member.state,
                    })) });
                return currentGroup;
            },
        },
        applyGeneration: async () => ({ ok: true, mode: 'spawn_next_turn' }),
    });
    const runnerIdentity = {};
    let runnerCurrent = true;
    const bridge = createExecutionRunConnectedServicesBridge({
        resolveAuthForSpawn: (input) => resolveConnectedServiceAuthForSpawn({ ...input,
            activeServerDir: join(root, 'server'), baseDir, credentials, api, nowMs: () => 1_000,
            processEnv: { HOME: root, CODEX_HOME: join(root, 'native-source') },
            qualifiedConnectedAccountApi: { readGroup: async () => currentGroup, listAccounts: async () => accounts },
        }),
        recoverRejectedStart: ({ selection, modelId: requestedModel, isCurrent }) => coordinator.switchAfterClassifiedFailure({
            serviceId: service, groupId: selection.groupId, observedProfileId: selection.activeProfileId,
            reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: requestedModel,
            rejectedStart: true, expectedFailureSource: { profileId: selection.activeProfileId,
                groupGeneration: selection.generation, credentialRevision: selection.credentialRevision!, isCurrent },
        }),
        registerRunTargets() {}, unregisterRunTargets() {},
        resolveRunMaterializedRoot: ({ runKey, agentId }) => resolveConnectedServiceMaterializedRootDir({ baseDir, agentId, materializationKey: runKey }),
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: () => ({ identity: runnerIdentity, parentSessionId: 'actual-parent-session', isCurrent: () => runnerCurrent }),
        acquireAgentPurposeContributions: async ({ agentId }) => {
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            return { contributions: lease.registry.contributes, isCurrent: () => pluginReloadController.isRuntimeRegistryCurrent(lease.registry),
                release: lease.release, resolveAgentContributionIdentity: async () => {
                    const identity = lease.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
                    const sourceCustody = identity && lease.registry.readPluginSourceCustody?.(identity.pluginId);
                    return identity && sourceCustody ? { ...identity, sourceCustody } : null;
                } };
        },
        purposeBindingOwner: purposeOwner, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427, createRedactionLease: () => ({ add() {}, close() {} }),
        clearTerminalCleanupReceipt: async () => undefined,
    });
    const materialize = async (): Promise<Materialization> => {
        const result = await bridge.materialize({ runId, runnerPid, agentId: 'codex', cwd: root, modelId,
            connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } } });
        if (!result.ok) throw Object.assign(new Error(result.errorMessage), { executionRunErrorCode: result.errorCode });
        return result;
    };
    const classification = (materialization: Materialization) => {
        const selection = readConnectedServiceChildSelectionsFromEnv(materialization.env)?.get(serviceId);
        if (selection?.kind !== 'group') throw new Error('Expected materialized pool selection');
        return authAdapter.classifyRuntimeAuthFailure({ providerErrorPath: true,
            error: { message: `model '${modelId}' is not enabled in rustponsesapi` },
            serviceId, profileId: selection.activeProfileId, groupId: selection.groupId,
            sourceAccountIdentity: { groupGeneration: selection.generation, credentialRevision: selection.credentialRevision },
        })!;
    };
    return { bridge, coordinator, materialize, classification, commits, credentialReads,
        group: () => currentGroup, revokeRunner: () => { runnerCurrent = false; },
        reset() { currentGroup = initialGroup; runnerCurrent = true; commits.length = 0; credentialReads.length = 0; },
        release: () => bridge.releaseForRunnerExit({ runnerPid, runnerIdentity }),
        async close() {
            await bridge.releaseForRunnerExit({ runnerPid, runnerIdentity });
            await runtimeLease.release();
            await pluginReloadController.shutdown({ timeoutMs: 5_000 });
            await rm(root, { recursive: true, force: true });
        },
    };
}

describe('composed finite Run model recovery', () => {
    let scenario: Awaited<ReturnType<typeof createScenario>>;
    beforeAll(async () => { scenario = await createScenario(); });
    beforeEach(() => { scenario.reset(); });
    afterEach(async () => { await scenario?.release(); });
    afterAll(async () => { await scenario?.close(); });
    it.each([0, 2, 3])('preserves accepted work or recovers %i explicit rejected members through the composed corridor', async (rejectCount) => {
        let active: Materialization | null = null;
        const requests: AgentExecutionRunOpenRequest[] = [];
        const openedMembers: string[] = [];
        const host = createLazyExecutionRunHostRuntime({
            resolveRuntime: async () => {
                active = await scenario.materialize();
                const materialization = active;
                const failure = scenario.classification(materialization);
                // Prove the admitted Codex materializer produced the native auth read by
                // the Agent process. These are synthetic fixture credentials only.
                const nativeAuth = JSON.parse(await readFile(join(materialization.env.CODEX_HOME!, 'auth.json'), 'utf8'));
                expect(nativeAuth.tokens.account_id).toBe(`test-account-${failure.profileId}`);
                openedMembers.push(failure.profileId!);
                return createNativeAgentExecutionRunHostRuntime({
                    runtime: { executionRuns: { open: async (request) => {
                        requests.push(request);
                        return { send: async () => ({ status: 'admitted' }), stop: async () => ({ status: 'requested' }),
                            watch(listener) {
                                const common = { runId, emittedAtMs: 1 };
                                const event: AgentExecutionRunEvent = rejectCount === 0 || openedMembers.length <= rejectCount
                                    ? { ...common, sequence: 3, kind: 'run-failed', diagnostic: { severity: 'error',
                                        code: 'connected_service_model_start_rejected', details: { runtimeAuthClassification: failure } } }
                                    : { ...common, sequence: 2, kind: 'run-complete' };
                                listener({ ...common, sequence: 1, kind: 'run-start' });
                                if (rejectCount === 0) listener({ ...common, sequence: 2, kind: 'output-delta', channel: 'assistant', text: 'accepted work' });
                                listener(event);
                                return { dispose() {} };
                            },
                            dispose: async () => { await scenario.bridge.release({ runId, runnerPid, activationId: materialization.activationId }); },
                        };
                    } } },
                    lease: { pluginId: service.pluginId, pluginVersion: '1.0.0', agentId: 'codex', localAgentId: 'codex',
                        occurrenceId: 'external-agent-process', isCurrent: () => true },
                    options: { cwd: '/fixture', runId, scope: 'detached', backendId: 'codex', permissionMode: 'read_only',
                        start: { localInputId: 'same-unaccepted-input' } }, supportsResume: false,
                });
            },
            recoverRejectedStart: async (error) => {
                if (!(error instanceof ExecutionRunRejectedStartError) || !active) return false;
                const result = await scenario.bridge.recoverRejectedStart({ runId, runnerPid, activationId: active.activationId,
                    modelId, classification: error.classification });
                if (!result.ok) throw Object.assign(new Error(result.errorMessage), { executionRunErrorCode: result.errorCode });
                return true;
            },
        });
        try {
            if (rejectCount === 3) await expect(host.provisionRuntime({ initialPrompt: 'unchanged input' })).rejects.toMatchObject({
                executionRunErrorCode: 'connected_service_run_model_unavailable', message: expect.stringContaining(modelId),
            });
            else {
                await host.provisionRuntime({ initialPrompt: 'unchanged input' });
                if (rejectCount === 0) await expect(host.waitForTurnCompletion?.()).rejects.toThrow();
                else await host.waitForTurnCompletion?.();
            }
            const expectedMembers = rejectCount === 0 ? ['first'] : memberIds;
            expect(openedMembers).toEqual(expectedMembers);
            expect(scenario.credentialReads).toEqual(expectedMembers);
            expect(scenario.commits).toEqual(rejectCount === 0 ? [] : ['second', 'third']);
            expect(requests.map((request) => request.kind === 'create' && { input: request.input, localInputId: request.localInputId }))
                .toEqual(expectedMembers.map(() => ({ input: { text: 'unchanged input' }, localInputId: 'same-unaccepted-input' })));
            expect(scenario.group().members.slice(0, rejectCount).every((member) => member.state.modelUnavailableUntilMsByModelId?.[modelId] === 86_401_000)).toBe(true);
            if (rejectCount === 0) {
                expect(scenario.group().runtimeStateRevision).toBe(0);
                await expect(scenario.coordinator.switchAfterClassifiedFailure({
                    serviceId: service, groupId: 'pool', observedProfileId: 'first', reason: 'plan',
                    limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: modelId,
                    switchesThisTurn: 1, sessionSwitchesThisHour: 1,
                })).resolves.toMatchObject({ status: 'switch_limit_reached' });
                expect(requests).toHaveLength(1);
                expect(scenario.commits).toEqual([]);
            }
        } finally { await host.dispose(); }
    });

    it('refuses stale activation and mismatched retained member evidence before any pool write', async () => {
        try {
            const active = await scenario.materialize();
            const failure = scenario.classification(active);
            const request = { runId, runnerPid, activationId: active.activationId, modelId, classification: failure };
            await expect(scenario.bridge.recoverRejectedStart({ ...request,
                activationId: '00000000-0000-4000-8000-000000000000' })).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_activation_stale',
            });
            await expect(scenario.bridge.recoverRejectedStart({ ...request,
                classification: { ...failure, profileId: 'second' } })).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_materialization_blocked',
            });
            scenario.revokeRunner();
            await expect(scenario.bridge.recoverRejectedStart(request)).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_activation_stale',
            });
            expect(scenario.commits).toEqual([]);
            expect(scenario.group().runtimeStateRevision).toBe(0);
        } finally { await scenario.release(); }
    });
});
