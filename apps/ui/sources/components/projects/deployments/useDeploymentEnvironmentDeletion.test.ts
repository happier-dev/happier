import * as React from 'react';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1,
    createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReadControllerV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { DeploymentEnvironmentDeleteInputV1Schema, DeploymentTargetUnlinkInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { act, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
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
        const machine = createPlainMachineRowFixture({ id: f.detail.environment.controllerMachineId!, accountId: 'owner' });
        homes.answer(f.serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === machine.id ? machine : null).json(),
        }) });
        homes.answer(f.serverId, '/v1/actions/deployments.teardown', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: { v: 1, actionId: 'deployments.teardown', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'deployment_domain_native_unavailable', error: 'deployment_domain_native_unavailable',
                    details: { environmentId: f.detail.environment.id, domainId: 'tools', domainHostname: 'tools.example.test',
                        step: 'removeDomain', partial: true, requiredFact: 'domainIngress', remedy: 'Restore ingress and retry Stop and remove.' } } } };
        } });
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

    it('observes deployment_in_progress through the shared demand/push receipt owner with zero hidden or unrelated reads', async () => {
        const f = await setup();
        const initial = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'running', operation: 'teardown' }) });
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
        })).toEqual({ kind: 'receipt', deploymentId }); });
        expect(reads).toBe(0);
        await hook.rerender(shown);
        expect(hook.getCurrent().receipt.status).toBe('ready');
        expect(reads).toBe(1);
        controller.invalidate({ environmentId: 'unrelated', deploymentId: 'another-receipt' });
        await flushHookEffects();
        expect(reads).toBe(1);
        observed = createDeploymentReceiptDetailV1({ deployment: { ...initial.deployment, state: 'succeeded' } });
        controller.invalidate({ environmentId: f.detail.environment.id, deploymentId });
        await flushHookEffects();
        expect(hook.getCurrent().receipt.value?.deployment.state).toBe('succeeded');
        expect(reads).toBe(2);
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

    it.each([false, true])('consumes final Environment removal from the one root teardown (whole Environment %s)', async wholeEnvironment => {
        const f = await setup();
        const link = f.detail.targetLinks[0]!.targetLink;
        const machine = createPlainMachineRowFixture({ id: f.detail.environment.controllerMachineId!, accountId: 'owner' });
        homes.answer(f.serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, id => id === machine.id ? machine : null).json(),
        }) });
        let input: unknown;
        homes.answer(f.serverId, '/v1/actions/deployments.teardown', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            input = envelope.input;
            return { body: { v: 1, actionId: 'deployments.teardown', requestId: envelope.requestId,
                execution: { ok: true, result: { ok: true, environmentId: f.detail.environment.id,
                    revision: f.detail.environment.revision + 3, deploymentId: 'teardown-1', deploymentRevision: 1,
                    state: 'succeeded', environmentRemoved: true } } } };
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

    it.each([false, true])('keeps explicit Detach on the existing record disposition and retains remote resources (Environment=%s)', async wholeEnvironment => {
        const f = await setup();
        const link = f.detail.targetLinks[0]!.targetLink;
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
            name: 'Platform app', machine: 'Platform target', running: true, canRemove: true,
            run: () => wholeEnvironment ? hook.getCurrent().deleteEnvironment({ kind: 'detachKeepRunning' },
                { presentUserConfirmation: { actionId: 'deployments.environments.delete' } })
                : hook.getCurrent().unlink(link.id, { kind: 'detachKeepRunning' },
                { presentUserConfirmation: { actionId: 'deployments.targets.unlink' } }),
            onApproval: () => { throw new Error('Removal was already confirmed'); }, onDone: () => {},
        }); });
        await screen.pressByTestIdAsync('project-deployments.disposition.choice:detach');
        await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
        expect(hook.getCurrent().outcome).toEqual(wholeEnvironment ? { kind: 'deleted', detached: true }
            : { kind: 'unlinked', targetLinkId: link.id, detached: true });
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(0);
    });

    it('returns a teardown that is still running as its receipt and removes nothing yet', async () => {
        const f = await setup();
        const teardown = vi.fn(async () => ({ ok: true as const, environmentId: f.detail.environment.id,
            revision: f.detail.environment.revision, deploymentId: 'teardown-2', deploymentRevision: 1, state: 'running' as const }));
        const deleteEnvironment = vi.fn();
        const actions = { ...f.actions, teardown, deleteEnvironment } as unknown as typeof f.actions;
        const hook = await renderHook(() => useDeploymentEnvironmentDeletion({ environmentId: f.detail.environment.id,
            lifetime: f.lifetime, snapshot: { status: 'ready', value: f.detail, failure: null }, actions,
            controller: null, demand: shown }));
        await act(async () => {
            expect(await hook.getCurrent().stopAndRemove(null)).toEqual({ kind: 'receipt', deploymentId: 'teardown-2' });
        });
        expect(deleteEnvironment).not.toHaveBeenCalled();
    });
});
