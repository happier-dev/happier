import * as React from 'react';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
const operationRpc = vi.hoisted(() => vi.fn());
// Daemon RPC is the observation transport boundary; all Action and outcome logic stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: operationRpc }));
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1,
    createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReadControllerV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { DeploymentEnvironmentDeleteInputV1Schema, DeploymentTargetUnlinkInputV1Schema, DeploymentTeardownActionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HappyError } from '@/utils/errors/errors';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { act, createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ renderCustomModals: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
const { useDeploymentEnvironmentDeletion } = await import('./useDeploymentEnvironmentDeletion');
await import('@/sync/ops/actions/defaultActionExecutor');
const shown = { mounted: true, visible: true, focused: true };
const hidden = { mounted: true, visible: false, focused: false };
const controllers: ReturnType<typeof createDeploymentReadControllerV1>[] = [];
beforeEach(() => homes.reset());
afterEach(async () => { await standardCleanup(); controllers.splice(0).forEach(controller => controller.retire()); await homes.reset(); });

async function setup() {
    const serverId = await homes.addHome({ name: 'Environment removal', serverUrl: 'https://environment-removal.test',
        serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'owner', currentAccount: true });
    const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
        serverId: `srv_${'d'.repeat(32)}` }) });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
    return { serverId, lifetime, detail, actions };
}

describe('Environment deletion client over the Action owner', () => {
    it('replaces the selected first runtime link through the same confirmed Link Action', async () => {
        const f = await setup();
        const inputs: unknown[] = [];
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.targets.link',
            machineId: f.detail.environment.controllerMachineId, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: input => {
                inputs.push(input);
                return { ok: true, environmentId: f.detail.environment.id, revision: f.detail.environment.revision + 1,
                    targetLinkId: 'replacement-link', targetLinkRevision: 1 };
            } });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => { expect(await hook.getCurrent().link({ machineId: 'replacement-machine',
            installationId: 'replacement-installation' }, { confirmed: true })).toEqual({ kind: 'linked', targetLinkId: 'replacement-link' }); });
        const selected = f.detail.targetLinks.find(row => row.targetLink.id === f.detail.environment.runtimeTargetLinkId)!.targetLink;
        expect(inputs).toEqual([expect.objectContaining({ environmentId: f.detail.environment.id,
            expectedRevision: f.detail.environment.revision, replacesLinkId: selected.id,
            expectedTargetLinkRevision: selected.revision,
            machines: [{ machineId: 'replacement-machine', installationId: 'replacement-installation' }] })]);
    });

    it('deletes a never-deployed Compose Environment through its confirmed signed requester without interactive review', async () => {
        const f = await setup();
        delete f.detail.targetLinks[0]!.targetLink.activeDeploymentId;
        const effects: unknown[] = [];
        const observed: Array<Readonly<{ stage: string; ok?: boolean; code?: string; errorClass?: string }>> = [];
        // Home storage is IO; the real receiving Action policy admits the original
        // request. The native preparation owner is covered by teardown.native.test.ts.
        const storage = async (actionId: string, input: unknown) => {
            if (actionId === 'deployments.environments.get') return { ok: true as const,
                environment: f.detail.environment, targetLinks: f.detail.targetLinks.map(item => item.targetLink) };
            expect(actionId).toBe('deployments.teardown');
            effects.push(input);
            return { ok: true as const, environmentId: f.detail.environment.id,
                revision: f.detail.environment.revision + 1, nothingDeployed: true, environmentRemoved: true };
        };
        const receiver = createActionExecutor({ deploymentAction: storage,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(storage) });
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId: f.detail.environment.controllerMachineId, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', failure: result => result && typeof result === 'object'
                && 'ok' in result && result.ok === false && 'errorCode' in result && typeof result.errorCode === 'string'
                ? { errorCode: result.errorCode, error: result.errorCode } : null,
            execute: async (input, transport) => {
                const binding = transport.authorization.binding;
                if (!('authentication' in binding)) throw new Error('Expected Account root');
                const result = await receiver.execute('deployments.teardown', input, {
                    surface: transport.invocation.surface,
                    authority: resolveInvocationAuthority({ credential: binding.authentication.kind,
                        surface: transport.invocation.surface, actionId: 'deployments.teardown' }),
                    actionCaller: transport.invocation.caller,
                    presentUserConfirmation: transport.invocation.presentUserConfirmation,
                    serverId: f.serverId, serverIdentityId: f.detail.environment.serverId,
                    runtimeAccountId: binding.accountId, actionRequestId: transport.requestId,
                    externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                    originalActionEnvelope: transport.envelope, interactivePresentation: 'unavailable',
                });
                observed.push({ stage: 'receiver', ok: result.ok, ...(!result.ok ? { code: result.errorCode } : {}) });
                return result.ok ? result.result : result;
            } });
        const actions = { ...f.actions, teardown: async (...args: Parameters<typeof f.actions.teardown>) => {
            try { return await f.actions.teardown(...args); }
            catch (error) {
                observed.push({ stage: 'action', errorClass: error instanceof Error ? error.name : typeof error,
                    ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) });
                throw error;
            }
        } };
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions,
            controller: null, demand: shown }));
        await act(async () => {
            const result = await hook.getCurrent().stopAndRemove(null, undefined, []);
            expect(result, JSON.stringify({ result, observed })).toEqual({ kind: 'deleted', detached: false });
        });
        expect(effects).toEqual([expect.objectContaining({ environmentId: f.detail.environment.id,
            targetLinkId: f.detail.environment.runtimeTargetLinkId, removeEnvironment: true, volumes: [] })]);
        expect(homes.artifacts(f.serverId).list()).toHaveLength(0);
    });

    it.each(['environment', 'target'] as const)('names paged Domains in the one %s remove confirmation and keeps failed retirement on that sheet', async subject => {
        const f = await setup();
        const { ModalProvider } = await import('@/modal');
        const { showDeploymentDispositionSheet } = await import('./DeploymentDispositionSheet');
        const reads: Array<string | undefined> = [];
        const controller = createDeploymentReadControllerV1({ scope: { ...f.lifetime.scope,
            projectSourceId: f.detail.environment.projectSourceId }, transport: {
            listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: f.detail }),
            listHistory: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            readReceipt: async () => ({ ok: false, failure: { code: 'deployment_unavailable', retryable: false } }),
            listDomains: async (_scope, _id, query) => {
                reads.push(query.cursor);
                const hostname = query.cursor ? 'second.example.test' : 'tools.example.test';
                return { ok: true, value: { items: [{ domain: { v: 1, id: hostname, environmentId: f.detail.environment.id,
                    targetLinkId: 'target-a', revision: 1, state: 'active', contentArtifactId: `content-${hostname}`,
                    contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 },
                    title: hostname, content: { hostname, target: { service: 'web', containerPort: 3000 },
                        healthCheck: { path: '/', expectStatus: 200 } } }], nextCursor: query.cursor ? null : 'second' } };
            },
        } });
        controllers.push(controller);
        const done = vi.fn();
        const refusal = { errorCode: 'deployment_domain_native_unavailable', error: 'deployment_domain_native_unavailable',
            details: { environmentId: f.detail.environment.id, domainId: 'tools', domainHostname: 'tools.example.test',
                step: 'removeDomain', partial: true, requiredFact: 'domainIngress', remedy: 'Restore ingress and retry Stop and remove.' } };
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId: f.detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: () => refusal, failure: () => refusal });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        const screen = await renderScreen(React.createElement(ModalProvider));
        expect(reads).toEqual([]);
        await act(async () => { showDeploymentDispositionSheet({ subject: subject === 'environment'
                ? { kind: 'environment' } : { kind: 'target', targetLinkId: 'target-a' }, name: 'IT Tools',
            machine: 'Server', running: true, canRemove: true, domains: { controller, environmentId: f.detail.environment.id },
            run: () => hook.getCurrent().stopAndRemove(subject === 'target' ? 'target-a' : null),
            onApproval: () => { throw new Error('Already confirmed'); }, onDone: done }); });
        expect(reads).toEqual([]);
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('tools.example.test');
        await screen.pressByTestIdAsync('project-deployments.disposition.domains.next');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('second.example.test');
        expect(reads).toEqual([undefined, 'second']);
        await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
        expect(screen.getTextContent()).toContain('Restore ingress and retry Stop and remove.');
        expect(screen.getTextContent()).toContain('tools.example.test');
        expect(screen.findByTestId('project-deployments.disposition')).not.toBeNull();
        expect(done).not.toHaveBeenCalled();
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it('projects an absent active deployment as null for disposition reviews', async () => {
        const f = await setup();
        const detail = { ...f.detail, targetLinks: f.detail.targetLinks.map(item => ({ ...item,
            targetLink: { ...item.targetLink, activeDeploymentId: undefined } })) };
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        expect(hook.getCurrent().review.retainedTargets[0]?.activeDeploymentId).toBeNull();
    });

    it.each([false, true])('submits settled-teardown or explicit-detach choice through the same irreversible Action (detach %s)', async detach => {
        const f = await setup();
        let received: ReturnType<typeof DeploymentEnvironmentDeleteInputV1Schema.parse> | undefined;
        homes.answer(f.serverId, `POST /v1/deployments/environments/${f.detail.environment.id}/delete`, { select: body => {
            received = DeploymentEnvironmentDeleteInputV1Schema.parse(body);
            return { body: { ok: true, environmentId: f.detail.environment.id,
                revision: f.detail.environment.revision + 1, detached: detach } };
        } });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => { expect(await hook.getCurrent().deleteEnvironment(detach ? { kind: 'detachKeepRunning' }
            : { kind: 'afterTeardown', deploymentIds: ['complete-teardown'] }, {
                presentUserConfirmation: { actionId: 'deployments.environments.delete' }, actionRequestId: 'reviewed-delete',
            })).toEqual({ kind: 'deleted', detached: detach }); });
        expect(received?.expectedRevision).toBe(f.detail.environment.revision);
        expect(received?.requestKey).toBe('reviewed-delete');
        expect(received?.detachKeepRunning).toBe(detach ? true : undefined);
        expect(received?.teardownDeploymentIds).toEqual(detach ? undefined : ['complete-teardown']);
        expect(hook.getCurrent().busy).toBe(false);
        expect(hook.getCurrent().review.deleteSpec.irreversible).toBe(true);
        expect(hook.getCurrent().review.volumeEffect).toBe('notTouchedByDisposition');
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it('keeps deployment_in_progress as a deletion refusal without observing an unrelated receipt', async () => {
        const f = await setup();
        const initial = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'running', operation: 'deploy' }) });
        const deploymentId = initial.deployment.id;
        let observed = initial;
        let reads = 0;
        const controller = createDeploymentReadControllerV1({ scope: { ...f.lifetime.scope,
            projectSourceId: f.detail.environment.projectSourceId }, transport: {
            listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
            readEnvironment: async () => ({ ok: true, value: f.detail }),
            // The receipt transport is the true observation boundary; the controller and hook are real.
            readReceipt: async () => { reads += 1; return { ok: true, value: observed }; },
        } });
        controllers.push(controller);
        homes.answer(f.serverId, `POST /v1/deployments/environments/${f.detail.environment.id}/delete`, { status: 409,
            body: { ok: false, error: 'deployment_in_progress', deploymentId, href: '/retained-receipt' } });
        const hook = await renderHook((demand: DeploymentReadDemandV1) => useDeploymentEnvironmentDeletion({
            environmentId: f.detail.environment.id, lifetime: f.lifetime,
            snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions, controller, demand,
        }), { initialProps: hidden });
        await act(async () => { expect(await hook.getCurrent().deleteEnvironment({ kind: 'detachKeepRunning' }, {
            presentUserConfirmation: { actionId: 'deployments.environments.delete' },
        })).toMatchObject({ kind: 'refused', code: 'deployment_in_progress',
            failure: { errorCode: 'deployment_in_progress', details: { deploymentId } } }); });
        expect(reads).toBe(0);
        await hook.rerender(shown);
        expect(hook.getCurrent().receipt.value).toBeNull();
        expect(reads).toBe(0);
        controller.invalidate({ environmentId: 'unrelated', deploymentId: 'another-receipt' });
        await flushHookEffects();
        expect(reads).toBe(0);
        observed = createDeploymentReceiptDetailV1({ deployment: { ...initial.deployment, state: 'succeeded' } });
        controller.invalidate({ environmentId: f.detail.environment.id, deploymentId });
        await flushHookEffects();
        expect(hook.getCurrent().receipt.value).toBeNull();
        expect(reads).toBe(0);
        // Settlement observation never silently retries an irreversible disposition.
        expect(homes.requestsFor(`/v1/deployments/environments/${f.detail.environment.id}/delete`)).toHaveLength(1);
    });

    it('submits unlink with exact link revisions and keeps typed teardown-required refusal visible', async () => {
        const f = await setup();
        const link = f.detail.targetLinks[0]!.targetLink;
        homes.answer(f.serverId, `POST /v1/deployments/environments/${f.detail.environment.id}/targets/${link.id}/unlink`, {
            status: 409, select: body => {
                const input = DeploymentTargetUnlinkInputV1Schema.parse(body);
                expect(input.expectedTargetLinkRevision).toBe(link.revision);
                expect(input.detachKeepRunning).toBeUndefined();
                return { body: { ok: false, error: 'deployment_teardown_required' } };
            },
        });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => { expect(await hook.getCurrent().unlink(link.id, { kind: 'afterTeardown' }, {
            presentUserConfirmation: { actionId: 'deployments.targets.unlink' },
        })).toMatchObject({ kind: 'refused', code: 'deployment_teardown_required' }); });
        expect(hook.getCurrent().outcome).toMatchObject({ kind: 'refused', code: 'deployment_teardown_required' });
    });

    it.each(['not-yet-listed', 'list-disconnected', 'join-disconnected', 'observer-cancelled'] as const)(
        'follows the original teardown after response loss while observation is %s', async observation => {
        const f = await setup();
        actionOperationStore.reset();
        const machineId = f.detail.environment.controllerMachineId!;
        let retained: ActionOperationSnapshotV1 | undefined;
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId, installationId: 'installation-controller', tokenEpoch: 0, requesterInvocation: 'required',
            execute: raw => {
                const input = DeploymentTeardownActionInputV1Schema.parse(raw);
                if (input.requestKey === undefined) throw new Error('Expected a keyed teardown');
                retained = { version: 1, operationId: 'late-teardown', revision: 1, actionId: 'deployments.teardown',
                    requestId: computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
                        input.serverId, input.environmentId, input.requestKey,
                    ]), state: 'running', scope: { accountId: 'owner', machineId }, title: 'Stop and remove',
                    createdAt: 1, startedAt: 2, cancellation: 'supported' };
                throw new TypeError('net::ERR_NETWORK_CHANGED');
            } });
        let available = false;
        let observed = false;
        operationRpc.mockImplementation(async (params: { method: string }) => {
            if (!available && (params.method === ACTION_OPERATION_RPC_METHODS_V2.get || observation !== 'join-disconnected')) {
                observed = true;
                if (observation !== 'not-yet-listed') throw createRpcCallError({
                    error: 'Socket disconnected', errorCode: 'MACHINE_RPC_UNREACHABLE' });
                return { items: [], nextCursor: null };
            }
            if (params.method === ACTION_OPERATION_RPC_METHODS_V2.list) return { items: [retained], nextCursor: null };
            return { kind: 'found', operation: { ...retained, revision: 2, state: 'succeeded', settledAt: 3,
                result: { ok: true, environmentId: f.detail.environment.id, revision: f.detail.environment.revision + 1,
                    deploymentId: 'late-receipt', deploymentRevision: 1, state: 'succeeded', environmentRemoved: true } } };
        });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        let completed = false;
        let pending!: ReturnType<ReturnType<typeof hook.getCurrent>['stopAndRemove']>;
        await act(async () => {
            pending = hook.getCurrent().stopAndRemove(null).then(result => { completed = true; return result; });
            await waitForHomeGovernance(() => expect(observed).toBe(true));
            await flushHookEffects();
        });
        expect(completed).toBe(false);
        expect(hook.getCurrent().busy).toBe(true);
        if (observation === 'observer-cancelled') {
            await act(async () => {
                hook.getCurrent().cancel();
                expect(await pending).toMatchObject({ kind: 'refused', code: 'cancelled' });
            });
            const callsAfterCancel = operationRpc.mock.calls.length;
            publishHomeAccountChange(f.serverId, undefined, { source: 'connected' });
            await flushHookEffects();
            expect(operationRpc.mock.calls).toHaveLength(callsAfterCancel);
            expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
            actionOperationStore.reset();
            return;
        }
        available = true;
        // Credential admission promotes the Home profile to its published identity.
        const observationServerId = resolveServerProfileScopeIdForIdentifier(f.serverId);
        await act(async () => {
            if (observation === 'not-yet-listed') {
                await consumeActionOperationSnapshotPush({
                    update: { type: 'action-operation-updated', machineId, content: { t: 'plain', v: retained! } },
                    accountId: 'owner', accountEncryptionMode: 'plain', sourceServerId: observationServerId,
                    readSnapshot: operationId => getActionOperation({ serverId: observationServerId, accountId: 'owner', machineId, operationId }),
                });
            } else publishHomeAccountChange(f.serverId, undefined, { source: 'connected' });
            if (observation === 'not-yet-listed') {
                expect([...actionOperationStore.getSnapshot().operationsByKey.values()].map(operation => ({
                    serverId: operation.serverId, requestId: operation.snapshot.requestId,
                }))).toEqual([{ serverId: observationServerId, requestId: retained!.requestId }]);
            }
            await waitForHomeGovernance(() => expect(completed).toBe(true));
            expect(await pending).toEqual({ kind: 'deleted', detached: false });
        });
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        actionOperationStore.reset();
    });

    it.each(['succeeded', 'failed', 'cancelled'] as const)('ends the removed Environment spinner from its settled record while the terminal-read reply is lost (%s)', async settlement => {
        const f = await setup();
        const machineId = f.detail.environment.controllerMachineId!;
        let operationRequestId: string | undefined;
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: raw => {
                const input = DeploymentTeardownActionInputV1Schema.parse(raw);
                if (input.requestKey === undefined) throw new Error('Expected a keyed teardown');
                operationRequestId = computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
                    input.serverId, input.environmentId, input.requestKey,
                ]);
                throw new TypeError('net::ERR_NETWORK_CHANGED');
            } });
        const reply = createDeferred<unknown>();
        let readSignal: AbortSignal | undefined;
        let retained: ActionOperationSnapshotV1 | undefined;
        operationRpc.mockImplementation((params: { method: string; signal?: AbortSignal }) => {
            if (params.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
                retained = { version: 1, operationId: 'removed-environment', revision: 1,
                    actionId: 'deployments.teardown', requestId: operationRequestId, state: 'running',
                    scope: { accountId: 'owner', machineId }, title: 'Stop and remove',
                    createdAt: 1, startedAt: 2, cancellation: 'supported' };
                return Promise.resolve({ items: [retained], nextCursor: null });
            }
            expect(params.method).toBe(ACTION_OPERATION_RPC_METHODS_V2.get);
            readSignal = params.signal;
            return reply.promise;
        });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        let completed = false;
        const caller = new AbortController();
        const pending = hook.getCurrent().stopAndRemove(null, { signal: caller.signal }).then(result => { completed = true; return result; });
        let settled: ActionOperationSnapshotV1 | undefined;
        try {
            await act(async () => { await waitForHomeGovernance(() => expect(readSignal).toBeDefined()); });
            expect(hook.getCurrent().busy).toBe(true);
            vi.useFakeTimers();
            await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
            expect(completed).toBe(false);
            settled = { ...retained!, revision: 2, state: settlement, settledAt: 3,
                ...(settlement === 'succeeded' ? { result: {
                    ok: true, environmentId: f.detail.environment.id, revision: f.detail.environment.revision + 3,
                    deploymentId: 'teardown-1', deploymentRevision: 1, state: 'succeeded', environmentRemoved: true } }
                    : settlement === 'failed' ? { error: { errorCode: 'deployment_conflict', error: 'deployment_conflict' } } : {}) };
            await act(async () => {
                const serverId = resolveServerProfileScopeIdForIdentifier(f.serverId);
                const { result: _result, ...summary } = settled!;
                actionOperationStore.reconcileMachineProjection({ serverId, accountId: 'owner', machineId,
                    snapshots: [summary], knownOperationKeys: new Set() });
                expect(completed).toBe(false);
                await consumeActionOperationSnapshotPush({ accountId: 'owner', accountEncryptionMode: 'plain',
                    sourceServerId: serverId,
                    update: { type: 'action-operation-updated', machineId, content: { t: 'plain', v: settled! } },
                    readSnapshot: async () => ({ kind: 'found', operation: settled! }) });
                await flushHookEffects();
            });
            expect(completed).toBe(true);
            expect(await pending).toMatchObject(settlement === 'succeeded' ? { kind: 'deleted', detached: false }
                : { kind: 'refused', code: settlement === 'failed' ? 'deployment_conflict' : 'cancelled' });
            expect(hook.getCurrent().busy).toBe(false);
            expect(readSignal?.aborted).toBe(true);
            expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
            caller.abort();
            reply.resolve({ kind: 'found', operation: settled ?? retained });
            await pending;
            actionOperationStore.reset();
        }
    });

    it.each(['succeeded', 'succeeded-summary', 'failed', 'unrelated'] as const)('settles a lost teardown response from its exact retained operation (%s)', async settlement => {
        const f = await setup();
        const machineId = f.detail.environment.controllerMachineId!;
        let requestId: string | undefined;
        let operationRequestId: string | undefined;
        let effects = 0;
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: (raw, context) => {
                const input = DeploymentTeardownActionInputV1Schema.parse(raw);
                if (input.requestKey === undefined) throw new Error('Expected a keyed teardown');
                // The live host retains the Environment intent, not this HTTP envelope id.
                operationRequestId = computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
                    input.serverId, input.environmentId, input.requestKey,
                ]);
                requestId = context.requestId; effects++;
                throw new TypeError('net::ERR_NETWORK_CHANGED');
            } });
        const calls: string[] = [];
        operationRpc.mockImplementation(async (params: { method: string; payload: unknown }) => {
            calls.push(params.method);
            const retained: ActionOperationSnapshotV1 = { version: 1, operationId: 'retained-teardown', revision: 1,
                actionId: 'deployments.teardown', requestId: settlement === 'unrelated' ? 'another-click' : operationRequestId,
                state: settlement === 'succeeded-summary' ? 'succeeded' : 'running',
                ...(settlement === 'succeeded-summary' ? { settledAt: 3 } : {}),
                scope: { accountId: 'owner', machineId }, title: 'Stop and remove',
                createdAt: 1, startedAt: 2, cancellation: 'supported' };
            if (params.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
                expect(requestId).not.toBe(operationRequestId);
                expect(params.payload).toEqual({ requestIdentity: { actionId: 'deployments.teardown', requestId: operationRequestId } });
                return { items: [retained], nextCursor: null };
            }
            expect(params.payload).toEqual({ operationId: retained.operationId, waitForTerminal: true });
            return { kind: 'found', operation: settlement === 'failed'
                ? { ...retained, revision: 2, state: 'failed', settledAt: 3,
                    error: { errorCode: 'deployment_conflict', error: 'deployment_conflict', effectAttempted: false } }
                : { ...retained, revision: 2, state: 'succeeded', settledAt: 3, result: {
                    ok: true, environmentId: f.detail.environment.id, revision: f.detail.environment.revision + 3,
                    deploymentId: 'teardown-1', deploymentRevision: 1, state: 'succeeded', environmentRemoved: true } } };
        });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => {
            expect(await hook.getCurrent().stopAndRemove(null)).toMatchObject(settlement === 'succeeded' || settlement === 'succeeded-summary'
                ? { kind: 'deleted', detached: false }
                : { kind: 'refused', code: settlement === 'failed' ? 'deployment_conflict' : 'outcome_unknown' });
        });
        expect(effects).toBe(1);
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        expect(calls).toEqual(settlement === 'unrelated' ? [ACTION_OPERATION_RPC_METHODS_V2.list]
            : [ACTION_OPERATION_RPC_METHODS_V2.list, ACTION_OPERATION_RPC_METHODS_V2.get]);
    });

    it.each([false, true])('consumes final Environment removal from the one root teardown (whole Environment %s)', async wholeEnvironment => {
        const f = await setup();
        const link = f.detail.targetLinks[0]!.targetLink;
        let input: unknown;
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId: f.detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: raw => {
                input = raw;
                return { ok: true, environmentId: f.detail.environment.id,
                    revision: f.detail.environment.revision + 3, deploymentId: 'teardown-1', deploymentRevision: 1,
                    state: 'succeeded', environmentRemoved: true };
            } });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => {
            expect(await hook.getCurrent().stopAndRemove(wholeEnvironment ? null : link.id))
                .toEqual({ kind: 'deleted', detached: false });
        });
        expect(input).toMatchObject({ environmentId: f.detail.environment.id, targetLinkId: link.id,
            reason: 'manual', removeEnvironment: true });
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        expect(homes.requestsFor(`/v1/deployments/environments/${f.detail.environment.id}/delete`)).toHaveLength(0);
        expect(homes.requestsFor(`/v1/deployments/environments/${f.detail.environment.id}/targets/${link.id}/unlink`)).toHaveLength(0);
    });

    it.each([
        { wholeEnvironment: false, running: true }, { wholeEnvironment: true, running: true },
        { wholeEnvironment: false, running: false }, { wholeEnvironment: true, running: false },
    ])('keeps explicit Detach on the existing record disposition and retains remote resources (Environment=$wholeEnvironment, running=$running)', async ({ wholeEnvironment, running }) => {
        const f = await setup();
        const link = f.detail.targetLinks[0]!.targetLink;
        if (!running) {
            delete link.activeDeploymentId;
            await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
                machineId: f.detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
                requesterInvocation: 'required', execute: raw => {
                    expect(DeploymentTeardownActionInputV1Schema.parse(raw)).toMatchObject({ mode: 'preview' });
                    return { ok: false, error: 'deployment_content_unavailable' };
                }, failure: () => ({ errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable' }) });
        }
        homes.answer(f.serverId, `POST /v1/deployments/environments/${f.detail.environment.id}/delete`, { select: body => {
            const input = DeploymentEnvironmentDeleteInputV1Schema.parse(body);
            expect(input.expectedRevision).toBe(f.detail.environment.revision);
            expect(input.detachKeepRunning).toBe(true);
            expect(input.teardownDeploymentIds).toBeUndefined();
            return { body: { ok: true, environmentId: f.detail.environment.id,
                revision: f.detail.environment.revision + 2, detached: true } };
        } });
        homes.answer(f.serverId, `POST /v1/deployments/environments/${f.detail.environment.id}/targets/${link.id}/unlink`, {
            select: body => {
                expect(DeploymentTargetUnlinkInputV1Schema.parse(body).detachKeepRunning).toBe(true);
                return { body: { ok: true, environmentId: f.detail.environment.id, revision: f.detail.environment.revision + 1,
                    targetLinkId: link.id, targetLinkRevision: link.revision + 1, detached: true } };
            },
        });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        const { Modal, ModalProvider } = await import('@/modal');
        const { showDeploymentDispositionSheet } = await import('./DeploymentDispositionSheet');
        vi.mocked(Modal.alertAsync).mockClear();
        const screen = await renderScreen(React.createElement(ModalProvider));
        await act(async () => { showDeploymentDispositionSheet({
            subject: wholeEnvironment ? { kind: 'environment' } : { kind: 'target', targetLinkId: link.id },
            name: 'Platform app', machine: 'Platform target', running, hasRetainedAssociations: true, canRemove: true,
            ...(!running ? { reviewVolumes: async () => {
                const result = await f.actions.teardown({ environmentId: f.detail.environment.id, reason: 'manual', mode: 'preview' });
                if (!result.ok) throw new HappyError(result.error, true, { code: result.error, details: result });
                if ('kind' in result && result.kind === 'preview') return result.volumes;
                throw new Error('Expected volume inventory');
            } } : {}),
            run: (choice) => {
                expect(choice).toBe('detach');
                return wholeEnvironment ? hook.getCurrent().deleteEnvironment({ kind: 'detachKeepRunning' },
                { presentUserConfirmation: { actionId: 'deployments.environments.delete' } })
                : hook.getCurrent().unlink(link.id, { kind: 'detachKeepRunning' },
                { presentUserConfirmation: { actionId: 'deployments.targets.unlink' } });
            },
            onApproval: () => { throw new Error('Removal was already confirmed'); }, onDone: () => {},
        }); });
        if (!running) {
            await waitForHomeGovernance(() => {
                expect(screen.findByTestId('project-deployments.disposition.volumes.error')).not.toBeNull();
            });
            expect(screen.findByTestId('project-deployments.disposition.volumes.empty')).toBeNull();
            expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
        }
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:detach');
        for (const fact of ['keeps-running', 'stops', 'secrets', 'costs']) {
            expect(screen.findByTestId(`project-deployments.disposition.fact.${fact}`)).not.toBeNull();
        }
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
        expect(hook.getCurrent().outcome).toEqual(wholeEnvironment ? { kind: 'deleted', detached: true }
            : { kind: 'unlinked', targetLinkId: link.id, detached: true });
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(running ? 0 : 1);
    });

    it('returns a teardown that is still running as its receipt and removes nothing yet', async () => {
        const f = await setup();
        await answerExternalActionAccountForHome(homes, f.serverId, { actionId: 'deployments.teardown',
            machineId: f.detail.environment.controllerMachineId!, installationId: 'installation-controller', tokenEpoch: 0,
            requesterInvocation: 'required', execute: () => ({ ok: true, environmentId: f.detail.environment.id,
                revision: f.detail.environment.revision, deploymentId: 'teardown-2', deploymentRevision: 1, state: 'running' }) });
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions: f.actions,
            controller: null, demand: shown }));
        await act(async () => {
            expect(await hook.getCurrent().stopAndRemove(null)).toEqual({ kind: 'receipt', deploymentId: 'teardown-2' });
        });
        expect(homes.requestsFor(`/v1/deployments/environments/${f.detail.environment.id}/delete`)).toHaveLength(0);
        expect(homes.requestsFor(`/v1/deployments/environments/${f.detail.environment.id}/targets/${f.detail.targetLinks[0]!.targetLink.id}/unlink`)).toHaveLength(0);
    });
});
