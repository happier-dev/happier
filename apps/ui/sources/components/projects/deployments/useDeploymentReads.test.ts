import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1, type DeploymentReadDemandV1, type DeploymentReadTransportV1, type DeploymentEnvironmentHealthFeedV1, type DeploymentEnvironmentHealthServiceV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useEnvironmentRollbackMenu, useDeploymentAttemptHistory, useDeploymentCollection, useDeploymentEnvironment, useDeploymentEnvironmentDomains, useDeploymentHistory, useDeploymentReceipt, useSessionDeploymentChip } from './useDeploymentReads';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { projectDeploymentHealthAggregateV1, type DeploymentHealthServicesObservationV1 } from '@happier-dev/deployments';
import { deploymentEnvironmentAttention, deploymentHealthFact } from './deploymentPresentation';

const scope = { serverId: 'home', accountId: 'account-owner', projectSourceId: 'source-app' };
const shown = { mounted: true, visible: true, focused: true };
const hidden = { mounted: true, visible: false, focused: false };

it('presents pushed down health in overview and rail without another metadata read', async () => {
    const boundary = createBoundary();
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    const aggregate = projectDeploymentHealthAggregateV1({ environment: detail.environment, targetLink: link,
        observations: link.members.map((member): DeploymentHealthServicesObservationV1 => ({ environmentId: detail.environment.id, targetLinkId: link.id,
            targetLinkRevision: link.revision, machineId: member.machineId, installationId: member.installationId,
            role: 'runtime', source: { kind: 'native' }, observedAtMs: 100,
            services: [{ serviceId: 'database', observation: { status: 'down', observedAtMs: 100, reason: 'stopped' } }] })) });
    let publish: Parameters<NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']>>[2] | undefined;
    const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
        observeEnvironmentHealth(_scope, _detail, emit) { publish = emit; return () => {}; } } });
    const hook = await renderHook(() => useDeploymentEnvironment(controller, boundary.row.id, shown));
    try {
        const reads = boundary.reads;
        await act(async () => { publish?.({ environmentId: detail.environment.id, status: 'ready', members: [] }, aggregate); });
        const health = hook.getCurrent().snapshot.value?.healthAggregate;
        expect(deploymentHealthFact(health).tone).toBe('danger');
        expect(deploymentEnvironmentAttention({ health: health ?? null, machineOffline: false, noTarget: false,
            controller: null, refused: false, reviewPending: false, latest: null, servingState: 'succeeded', catalogUpdate: false }))
            .toEqual({ kind: 'unhealthy' });
        expect(boundary.reads).toBe(reads);
    } finally { await hook.unmount(); controller.retire(); }
});

function createBoundary() {
    let reads = 0;
    const detail = createDeploymentEnvironmentDetailV1();
    const receiptDetail = createDeploymentReceiptDetailV1();
    const row = detail.environment;
    const receipt = receiptDetail.deployment;
    const transport: DeploymentReadTransportV1 = {
        listEnvironments: async () => { reads += 1; return { ok: true, value: { items: [{ environment: row, title: detail.content.name }], nextCursor: null } }; },
        readEnvironment: async () => { reads += 1; return { ok: true, value: detail }; },
        listHistory: async () => { reads += 1; return { ok: true, value: { ok: true, items: [receipt], nextCursor: null } }; },
        readReceipt: async () => { reads += 1; return { ok: true, value: receiptDetail }; },
    };
    return { transport, row, receipt, detail, get reads() { return reads; } };
}

describe('deployment React demand', () => {
    it('opens no health watch for a historical Receipt and follows the serving pointer as it changes', async () => {
        const boundary = createBoundary();
        const selected = boundary.receipt.id;
        const link = boundary.detail.targetLinks[0]!.targetLink;
        let servingId = 'another-deployment';
        let opened = 0;
        let closed = 0;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readEnvironment: async () => {
                const current = { ...link, activeDeploymentId: servingId };
                return { ok: true, value: { ...boundary.detail, targetLinks: [{ targetLink: current }] } };
            },
            observeEnvironmentHealth() {
                opened += 1;
                return () => { closed += 1; };
            },
        } });
        const hook = await renderHook(() => useDeploymentReceipt(controller, boundary.row.id, selected, shown));
        try {
            await flushHookEffects();
            expect(hook.getCurrent().snapshot.value?.deployment.id).toBe(selected);
            expect({ opened, closed }).toEqual({ opened: 0, closed: 0 });
            servingId = selected;
            await act(async () => {
                controller.invalidate({ environmentId: boundary.row.id });
                await flushHookEffects();
            });
            expect({ opened, closed }).toEqual({ opened: 1, closed: 0 });
            servingId = 'another-deployment';
            await act(async () => {
                controller.invalidate({ environmentId: boundary.row.id });
                await flushHookEffects();
            });
            expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
        } finally { await hook.unmount(); controller.retire(); }
    });

    it('settles an Environment read refusal with its cause and recovers through the same menu retry', async () => {
        const boundary = createBoundary();
        let refused = true;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readEnvironment: async () => refused
                ? { ok: false, failure: { code: 'deployment_access_denied', retryable: false } }
                : { ok: true, value: boundary.detail },
        } });
        const hook = await renderHook(() => useEnvironmentRollbackMenu(controller, boundary.row.id, boundary.receipt.id, true));
        try {
            await flushHookEffects();
            expect(hook.getCurrent().result).toMatchObject({ status: 'unavailable', reason: 'deployment_access_denied', retryable: false });
            refused = false;
            await act(async () => { await hook.getCurrent().retry(); });
            await flushHookEffects();
            expect(hook.getCurrent().result.status).toBe('empty');
        } finally { await hook.unmount(); controller.retire(); }
    });
    it('reads rollback facts only while the menu is open and leaves eligibility with the receipt owner', async () => {
        const boundary = createBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: boundary.transport });
        let open = false;
        const hook = await renderHook(() => useEnvironmentRollbackMenu(controller, boundary.row.id, boundary.receipt.id, open));
        try {
            await flushHookEffects();
            expect(boundary.reads).toBe(0);
            expect(hook.getCurrent().result.status).toBe('idle');
            open = true; await hook.rerender(); await flushHookEffects();
            expect(boundary.reads).toBe(3);
            expect(hook.getCurrent().result.status).toBe('empty');
            open = false; await hook.rerender(); await flushHookEffects();
            const closedReads = boundary.reads;
            await controller.invalidate({ environmentId: boundary.row.id });
            await flushHookEffects();
            expect(boundary.reads).toBe(closedReads);
        } finally { await hook.unmount(); controller.retire(); }
    });
    it('keeps partial empty Domain and receipt pages unavailable and predecessor history unknown', async () => {
        const boundary = createBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            listDomains: async () => ({ ok: true, value: { items: [], nextCursor: null, coverage: 'partial' } }),
            listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null, coverage: 'partial' } }),
        } });
        const hook = await renderHook(() => ({
            domains: useDeploymentEnvironmentDomains(controller, boundary.row.id, shown),
            history: useDeploymentHistory(controller, boundary.row.id, shown),
            receipt: useDeploymentReceipt(controller, boundary.row.id, boundary.receipt.id, shown),
        }));
        try {
            await flushHookEffects();
            expect(hook.getCurrent().domains.result).toMatchObject({ status: 'unavailable', items: [] });
            expect(hook.getCurrent().history.snapshot).toMatchObject({ status: 'ready', value: { coverage: 'partial' } });
            expect(hook.getCurrent().receipt.snapshot.value?.facts).toMatchObject({ previousVersion: undefined,
                retainedPreviousCount: null, retainedRollbackTarget: null });
        } finally { await hook.unmount(); controller.retire(); }
    });
    it('projects loaded built-in address facts through Domains without another receipt or provider read', async () => {
        const boundary = createBoundary();
        const base = createDeploymentReceiptDetailV1();
        const link = boundary.detail.targetLinks[0]!.targetLink;
        const targetLink = { ...link, source: { kind: 'plugin' as const,
            contribution: { pluginId: 'acme.deploy', localId: 'deploy' } }, targetKind: 'platform', machines: [], members: [] };
        let builtInUrls: string[] = ['https://app.vercel.app'];
        let receiptReads = 0;
        let domainReads = 0;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readEnvironment: async () => ({ ok: true, value: { ...boundary.detail, targetLinks: [{ targetLink }] } }),
            readReceipt: async () => { receiptReads++; return { ok: true, value: { ...base, content: {
                sourceIntent: base.content.sourceIntent, sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
                platform: { targetLinkRevision: targetLink.revision,
                    credentialPrincipal: { kind: 'account', accountId: 'account-owner',
                        purpose: { consumer: { pluginId: 'acme.deploy', localId: 'deploy' }, purpose: 'action-account' },
                        target: { kind: 'account', account: { service: { pluginId: 'acme.deploy', localId: 'account' }, accountId: 'provider' } } },
                    providerIdentity: { providerAccountId: 'provider', providerResourceId: 'project', providerEnvironment: 'production' },
                    providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, observation: { v: 1, state: 'succeeded', observedAtMs: 2000,
                        urls: ['https://app-exact.vercel.app'], builtInUrls } },
            } } }; },
            listDomains: async () => { domainReads++; return { ok: true, value: { items: [], nextCursor: null } }; },
        } });
        const receipt = controller.acquireReceipt(boundary.row.id, base.deployment.id, shown);
        const hook = await renderHook(() => {
            const environment = useDeploymentEnvironment(controller, boundary.row.id, shown);
            const domains = useDeploymentEnvironmentDomains(controller, boundary.row.id, shown);
            return { environment, domains };
        });
        try {
            await flushHookEffects();
            expect(hook.getCurrent().environment.snapshot.value).toHaveProperty('builtInUrls', ['https://app.vercel.app']);
            expect(hook.getCurrent().domains.result).toMatchObject({ status: 'empty', items: [] });
            builtInUrls = ['https://app.my-account.workers.dev'];
            await act(async () => { await receipt.refresh(); }); await flushHookEffects();
            expect(hook.getCurrent().environment.snapshot.value?.builtInUrls).toEqual(builtInUrls);
            builtInUrls = [];
            await act(async () => { await receipt.refresh(); }); await flushHookEffects();
            expect(hook.getCurrent().environment.snapshot.value?.builtInUrls).toEqual([]);
            expect(domainReads).toBe(1);
            expect(receiptReads).toBe(3);
            expect(boundary.reads).toBe(0);
        } finally { receipt.release(); await hook.unmount(); controller.retire(); }
    });
    it('joins one retained history with exact previous and serving receipts, keeping pending and failed history unknown', async () => {
        const base = createDeploymentReceiptDetailV1();
        if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const current = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'deployment-a',
            requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }),
            content: { ...base.content, sourceIntent: { ...base.content.sourceIntent, sha: 'b'.repeat(40) } } });
        const previous = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'previous' }) });
        const pending = createDeferred<Awaited<ReturnType<DeploymentReadTransportV1['listHistory']>>>();
        let historyReads = 0;
        let failed = false;
        const receiptReads: string[] = [];
        const boundary = createBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            listHistory: async () => { historyReads++; return failed
                ? { ok: false, failure: { code: 'deployment_read_failed', retryable: true } } : pending.promise; },
            readReceipt: async (_scope, _environment, id) => { receiptReads.push(id); return { ok: true,
                value: id === current.deployment.id ? current : previous }; },
        } });
        const page = await renderHook(() => ({ receipt: useDeploymentReceipt(controller, boundary.row.id, current.deployment.id, shown),
            history: useDeploymentAttemptHistory(controller, boundary.row.id, shown),
            menu: useEnvironmentRollbackMenu(controller, boundary.row.id, current.deployment.id, true) }));
        try {
            expect(page.getCurrent().receipt.snapshot.value?.facts).toMatchObject({ previousVersion: undefined,
                retainedPreviousCount: null, retainedRollbackTarget: null });
            await act(async () => { pending.resolve({ ok: true, value: { ok: true,
                items: [current, previous].map(row => ({ ...row.deployment, source: projectDeploymentReceiptFactsV1(row).source })), nextCursor: null } }); });
            await flushHookEffects();
            expect(page.getCurrent().receipt.snapshot.value?.facts).toMatchObject({
                previousVersion: { deploymentId: 'previous' }, retainedPreviousCount: 1,
                retainedRollbackTarget: { deploymentId: 'previous' },
            });
            expect(page.getCurrent().menu.result).toMatchObject({ status: 'ready',
                target: { deploymentId: 'previous' }, input: { environmentId: boundary.row.id, deploymentId: 'previous' } });
            expect(historyReads).toBe(1);
            expect(receiptReads).toEqual(['deployment-a']);
            failed = true;
            await act(async () => { await page.getCurrent().history.refresh(); });
            expect(page.getCurrent().menu.result).toMatchObject({ status: 'unavailable', reason: 'deployment_read_failed', retryable: true });
            expect(page.getCurrent().receipt.snapshot.value?.facts).toMatchObject({ previousVersion: undefined,
                retainedPreviousCount: null, retainedRollbackTarget: null });
        } finally { await page.unmount(); controller.retire(); }
    });
    it('keeps unaffected Service rows at zero renders for twenty sibling health changes and insertion', async () => {
        const boundary = createBoundary();
        let publish: ((feed: DeploymentEnvironmentHealthFeedV1) => void) | undefined;
        const current = (index: number): DeploymentEnvironmentHealthFeedV1 => ({ environmentId: boundary.row.id,
            status: 'ready', members: [{ machineId: 'runtime', installationId: 'installation', status: 'ready', services: [
                ...(index ? [{ serviceId: 'inserted', state: 'up' as const, observedAt: 100, reason: null }] : []),
                { serviceId: 'app/db', state: 'up', observedAt: 100, reason: null },
                { serviceId: 'app/web', state: index % 2 ? 'up' : 'down', observedAt: 100 + index, reason: null },
            ] }] });
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            observeEnvironmentHealth(_scope, _detail, emit) { publish = emit; emit(current(0)); return () => {}; },
        } });
        const counts = createRenderCommitCounter();
        const otherCounts = createRenderCommitCounter();
        const Row = React.memo(({ service }: { service: DeploymentEnvironmentHealthServiceV1 }) => {
            useRenderCommitCounter(service.serviceId === 'app/db' ? counts : otherCounts);
            return null;
        });
        const Rows = ({ children }: React.PropsWithChildren) => {
            const read = useDeploymentEnvironment(controller, boundary.row.id, shown);
            return React.createElement(React.Fragment, null, children, read.healthFeed?.members.flatMap(member =>
                member.services.map(service => React.createElement(Row, { key: `${member.machineId}:${service.serviceId}`, service }))));
        };
        const hook = await renderHook(() => null, { wrapper: Rows });
        try {
            expect(counts.read()).toEqual({ renders: 1, commits: 1 });
            counts.reset();
            const reads = boundary.reads;
            for (let index = 1; index <= 20; index++) await act(async () => { publish?.(current(index)); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(boundary.reads).toBe(reads);
        } finally { await hook.unmount(); controller.retire(); }
    });
    it('joins the same current member Service health beside Environment and historical receipt data without waking unrelated pages', async () => {
        const boundary = createBoundary();
        let publish: ((feed: DeploymentEnvironmentHealthFeedV1) => void) | undefined;
        let subscriptions = 0;
        let closes = 0;
        const current = (state: 'up' | 'down', observedAt: number): DeploymentEnvironmentHealthFeedV1 => ({
            environmentId: boundary.row.id, status: 'ready', members: [{ machineId: 'runtime', installationId: 'installation',
                status: 'ready', services: [{ serviceId: 'app/web', state, observedAt, reason: state === 'down' ? 'not_ready' : null }] }],
        });
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            observeEnvironmentHealth(_scope, _detail, emit) { subscriptions++; publish = emit; emit(current('down', 100)); return () => { closes++; }; },
        } });
        const unrelatedController = createDeploymentReadControllerV1({ scope, transport: boundary.transport });
        const counts = createRenderCommitCounter();
        const unaffectedCounts = createRenderCommitCounter();
        const page = await renderHook((demand: DeploymentReadDemandV1) => {
            useRenderCommitCounter(counts);
            return { environment: useDeploymentEnvironment(controller, boundary.row.id, demand),
                receipt: useDeploymentReceipt(controller, boundary.row.id, boundary.receipt.id, demand) };
        }, { initialProps: shown });
        const unaffected = await renderHook(() => {
            useRenderCommitCounter(unaffectedCounts);
            return useDeploymentEnvironment(unrelatedController, boundary.row.id, shown);
        });
        try {
            expect(page.getCurrent().environment.healthFeed?.members[0]?.services[0]).toMatchObject({ state: 'down', observedAt: 100, reason: 'not_ready' });
            expect(page.getCurrent().receipt.healthFeed).toBe(page.getCurrent().environment.healthFeed);
            expect(subscriptions).toBe(1);
            counts.reset(); unaffectedCounts.reset();
            const reads = boundary.reads;
            await act(async () => { for (let i = 0; i < 20; i++) publish?.(current(i % 2 ? 'up' : 'down', 200 + i)); });
            expect(unaffectedCounts.read()).toEqual({ renders: 0, commits: 0 });
            expect(boundary.reads).toBe(reads);
            expect(page.getCurrent().receipt.healthFeed?.members[0]?.services[0]).toMatchObject({ state: 'up', observedAt: 219, reason: null });
            await page.rerender(hidden);
            expect(closes).toBe(1);
            counts.reset();
            await act(async () => { publish?.(current('down', 300)); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
        } finally { await page.unmount(); await unaffected.unmount(); controller.retire(); unrelatedController.retire(); }
    });
    it('loads a Session chip only for the receipt its existing Action operation requested', async () => {
        const boundary = createBoundary();
        const deployment = { ...boundary.receipt, actionOperationId: 'requesting-operation' };
        const requests: string[] = [];
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readReceipt: async (_scope, _environmentId, deploymentId) => {
                requests.push(deploymentId);
                return { ok: true, value: createDeploymentReceiptDetailV1({ deployment }) };
            },
        } });
        const operation = { version: 1 as const, operationId: deployment.actionOperationId, revision: 1,
            actionId: 'deployments.deploy', state: 'succeeded' as const, title: 'Deploy', createdAt: 1,
            cancellation: 'unsupported' as const, scope: { accountId: scope.accountId, machineId: 'controller', sessionId: 'requesting-session' },
            domainRef: { kind: 'deployment' as const, serverId: scope.serverId,
                environmentId: deployment.environmentId, deploymentId: deployment.id } };
        actionOperationStore.reset();
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [operation,
            { ...operation, operationId: 'other-session-action', createdAt: 2,
                scope: { ...operation.scope, sessionId: 'other-session' },
                domainRef: { ...operation.domainRef, deploymentId: 'other-deployment' } }] });
        const hook = await renderHook(() => {
            const operations = useSessionActionOperations({ serverId: scope.serverId, accountId: scope.accountId, sessionId: 'requesting-session' });
            return useSessionDeploymentChip(controller, operations[0] ?? null, shown);
        });
        try {
            expect(hook.getCurrent().snapshot).toMatchObject({ status: 'ready', value: {
                environmentId: deployment.environmentId, deploymentId: deployment.id, actionOperationId: operation.operationId,
            } });
            expect(requests).toEqual([deployment.id]);
        } finally { await hook.unmount(); controller.retire(); actionOperationStore.reset(); }
    });

    it('keeps unaffected deploy chips at zero renders for unrelated receipts and delivers one real state change', async () => {
        const boundary = createBoundary();
        let state: 'running' | 'failed' = 'running';
        const peer = createDeploymentReceiptDetailV1({ deployment: { ...boundary.receipt,
            id: 'peer-receipt', environmentId: 'peer-environment' } });
        let reads = 0;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readReceipt: async (_scope, environmentId) => { reads += 1; return { ok: true, value:
                environmentId === peer.deployment.environmentId ? peer
                    : createDeploymentReceiptDetailV1({ deployment: { ...boundary.receipt, state } }) }; },
        } });
        const changedCount = createRenderCommitCounter();
        const peerCount = createRenderCommitCounter();
        const changed = await renderHook(() => {
            useRenderCommitCounter(changedCount);
            return useDeploymentReceipt(controller, boundary.row.id, boundary.receipt.id, shown);
        });
        const unaffected = await renderHook(() => {
            useRenderCommitCounter(peerCount);
            return useDeploymentReceipt(controller, peer.deployment.environmentId, peer.deployment.id, shown);
        });
        try {
            expect(changed.getCurrent().snapshot.value).toMatchObject({ chip: { state: 'running', running: true, failed: false } });
            changedCount.reset(); peerCount.reset(); reads = 0;
            await act(async () => {
                controller.invalidate(Array.from({ length: 100 }, (_, index) => ({ environmentId: `unrelated-${index}`, deploymentId: `receipt-${index}` })));
                await flushHookEffects();
            });
            expect(reads).toBe(0);
            expect(changedCount.read()).toEqual({ renders: 0, commits: 0 });
            expect(peerCount.read()).toEqual({ renders: 0, commits: 0 });
            state = 'failed';
            await act(async () => {
                controller.invalidate({ environmentId: boundary.row.id, deploymentId: boundary.receipt.id });
                await flushHookEffects();
            });
            expect(changed.getCurrent().snapshot.value).toMatchObject({ chip: { state: 'failed', running: false, failed: true } });
            expect(changedCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(peerCount.read()).toEqual({ renders: 0, commits: 0 });
            expect(reads).toBe(1);
        } finally { await changed.unmount(); await unaffected.unmount(); controller.retire(); }
    });

    it('keeps the authorized collection total with its query while navigating and changing filters', async () => {
        const changed = createDeferred<Awaited<ReturnType<DeploymentReadTransportV1['listEnvironments']>>>();
        const boundary = createBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            listEnvironments: async (_scope, query) => query.machineId === 'changed-machine' ? changed.promise : ({ ok: true,
                value: { items: [], nextCursor: query.cursor ? null : 'older', ...(query.includeTotal ? { totalCount: 2417 } : {}) } }),
        } });
        const hook = await renderHook((machineId: string | undefined) => useDeploymentCollection(controller, shown,
            { includeTotal: true, machineId }), { initialProps: undefined as string | undefined });
        try {
            expect(hook.getCurrent().snapshot.value).toMatchObject({ totalCount: 2417 });
            await act(async () => { hook.getCurrent().nextPage(); });
            expect(hook.getCurrent().snapshot.value).toMatchObject({ totalCount: 2417 });
            await hook.rerender('changed-machine');
            expect(hook.getCurrent().snapshot.value).toBeNull();
            await act(async () => { changed.resolve({ ok: true, value: { items: [], nextCursor: null, totalCount: 3 } }); });
            expect(hook.getCurrent().snapshot.value).toMatchObject({ totalCount: 3 });
        } finally { await hook.unmount(); controller.retire(); }
    });

    it('navigates Environment and receipt cursor pages only on demand and resets on resource changes', async () => {
        const requests: (string | undefined)[] = [];
        const controller = createDeploymentReadControllerV1({ scope, transport: {
            listEnvironments: async (_scope, query) => {
                requests.push(query.cursor);
                return { ok: true, value: { items: [], coverage: query.cursor ? 'complete' : 'partial',
                    nextCursor: query.cursor ? null : 'environment-next' } };
            },
            listHistory: async (_scope, environmentId, query) => {
                requests.push(query.cursor);
                return { ok: true, value: { ok: true, items: [],
                    nextCursor: query.cursor ? null : 'receipt-next' } };
            },
            readEnvironment: async () => ({ ok: false, failure: { code: 'not_demanded', retryable: false } }),
            readReceipt: async () => ({ ok: false, failure: { code: 'not_demanded', retryable: false } }),
        } });
        const hook = await renderHook((environmentId: string) => ({
            collection: useDeploymentCollection(controller, shown),
            history: useDeploymentHistory(controller, environmentId, shown),
        }), { initialProps: 'environment-a' });
        try {
            expect(requests).toEqual([undefined, undefined]);
            expect(hook.getCurrent().collection.snapshot.value?.coverage).toBe('partial');
            await act(async () => { hook.getCurrent().collection.nextPage(); hook.getCurrent().history.nextPage(); });
            expect(hook.getCurrent().collection.snapshot.value?.coverage).toBe('complete');
            expect(hook.getCurrent().history.snapshot.value?.hasNextPage).toBe(false);
            expect(requests).toEqual([undefined, undefined, 'environment-next', 'receipt-next']);
            expect(hook.getCurrent().history.hasNextPage).toBe(false);
            await act(async () => { hook.getCurrent().collection.previousPage(); });
            expect(hook.getCurrent().collection.snapshot.value?.coverage).toBe('partial');
            await hook.rerender('environment-peer');
            expect(hook.getCurrent().history.snapshot.value?.hasNextPage).toBe(true);
            expect(hook.getCurrent().history.hasPreviousPage).toBe(false);
        } finally { await hook.unmount(); controller.retire(); }
    });

    it('opens only demanded resources and retains ready values through a hidden interval', async () => {
        const boundary = createBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: boundary.transport });
        const hook = await renderHook((demand: DeploymentReadDemandV1) => ({
            collection: useDeploymentCollection(controller, demand),
            environment: useDeploymentEnvironment(controller, boundary.row.id, demand),
            history: useDeploymentHistory(controller, boundary.row.id, demand),
            receipt: useDeploymentReceipt(controller, boundary.row.id, boundary.receipt.id, demand),
        }), { initialProps: hidden });
        expect(boundary.reads).toBe(0);
        await hook.rerender(shown);
        expect(hook.getCurrent().environment.snapshot.value?.environment.id).toBe(boundary.row.id);
        expect(hook.getCurrent().collection.snapshot.value?.items).toHaveLength(1);
        expect(hook.getCurrent().history.snapshot.value?.items).toHaveLength(1);
        expect(hook.getCurrent().receipt.snapshot.value?.deployment.id).toBe(boundary.receipt.id);
        const ready = hook.getCurrent().environment.snapshot;
        await hook.rerender(hidden);
        const settledReads = boundary.reads;
        controller.invalidate({ environmentId: boundary.row.id });
        await flushHookEffects();
        expect(boundary.reads).toBe(settledReads);
        expect(hook.getCurrent().environment.snapshot).toBe(ready);
        await hook.unmount();
        controller.retire();
    });

    it('keeps 100 hidden shared readers quiet on updates and clears their retained data on authority withdrawal', async () => {
        const boundary = createBoundary();
        let detail = boundary.detail;
        let reads = 0;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readEnvironment: async () => { reads += 1; return { ok: true, value: detail }; },
        } });
        const visibleCount = createRenderCommitCounter();
        const hiddenCount = createRenderCommitCounter();
        const hiddenValues = new Map<number, typeof detail | null>();
        const hiddenRefresh = new Map<number, () => Promise<void>>();
        let borrowerDemand = shown;
        function Borrower({ id }: Readonly<{ id: number }>) {
            useRenderCommitCounter(hiddenCount);
            const { snapshot, refresh } = useDeploymentEnvironment(controller, boundary.row.id, borrowerDemand);
            hiddenValues.set(id, snapshot.value);
            hiddenRefresh.set(id, refresh);
            return null;
        }
        function Readers({ children }: React.PropsWithChildren) {
            return React.createElement(React.Fragment, null, children,
                ...Array.from({ length: 100 }, (_, id) => React.createElement(Borrower, { key: id, id })));
        }
        const hook = await renderHook(() => {
            useRenderCommitCounter(visibleCount);
            return useDeploymentEnvironment(controller, boundary.row.id, shown);
        }, { wrapper: Readers });
        try {
            expect(hiddenValues.size).toBe(100);
            expect([...hiddenValues.values()].every(value => value?.environment.id === boundary.row.id)).toBe(true);
            borrowerDemand = hidden;
            await hook.rerender();
            const retainedHiddenValues = new Map(hiddenValues);
            visibleCount.reset(); hiddenCount.reset(); reads = 0;
            await act(async () => { await Promise.all([...hiddenRefresh.values()].map(refresh => refresh())); });
            expect(reads).toBe(0);
            expect(hiddenCount.read()).toEqual({ renders: 0, commits: 0 });
            detail = { ...detail, environment: { ...detail.environment, revision: detail.environment.revision + 1 },
                content: { ...detail.content, name: 'Changed' } };
            await act(async () => {
                controller.invalidate({ environmentId: boundary.row.id });
                await flushHookEffects();
            });
            expect(hook.getCurrent().snapshot.value?.content.name).toBe('Changed');
            expect(reads).toBe(1);
            expect(visibleCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(hiddenCount.read()).toEqual({ renders: 0, commits: 0 });
            expect([...hiddenValues].every(([id, value]) => value === retainedHiddenValues.get(id))).toBe(true);
            await act(async () => { controller.retire(); });
            expect(hook.getCurrent().snapshot.value).toBeNull();
            expect([...hiddenValues.values()].every(value => value === null)).toBe(true);
            expect(hiddenCount.read()).toEqual({ renders: 100, commits: 100 });
        } finally {
            await hook.unmount();
            controller.retire();
        }
    });

    it('keeps the controller ready value while a refresh waits and drops retired scope data', async () => {
        const boundary = createBoundary();
        const response = createDeferred<Awaited<ReturnType<DeploymentReadTransportV1['readEnvironment']>>>();
        let refresh = false;
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...boundary.transport,
            readEnvironment: (...args) => refresh ? response.promise : boundary.transport.readEnvironment(...args),
        } });
        const hook = await renderHook(() => useDeploymentEnvironment(controller, boundary.row.id, shown), { wrapper: React.StrictMode });
        expect(hook.getCurrent().snapshot.status).toBe('ready');
        const ready = hook.getCurrent().snapshot.value;
        refresh = true;
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().refresh(); });
        expect(hook.getCurrent().snapshot.value).toBe(ready);
        await act(async () => { controller.retire(); });
        expect(hook.getCurrent().snapshot.value).toBeNull();
        response.resolve({ ok: true, value: boundary.detail });
        await act(async () => { await pending; });
        expect(hook.getCurrent().snapshot.value).toBeNull();
        await hook.unmount();
    });
});
