import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentCollectionV1, createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReadControllerV1 } from './createDeploymentReadControllerV1.js';
import { createDeploymentHealthAggregateLeaseV1 } from '../projection/deploymentHealthAggregateLease.js';
import type { DeploymentHealthServicesObservationV1 } from '../projection/deploymentHealthAggregate.js';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentDomainContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentDomainPageV1, DeploymentEnvironmentHealthFeedV1, DeploymentReadDemandV1, DeploymentReadTransportV1 } from './deploymentReadControllerTypes.js';

const active: DeploymentReadDemandV1 = { mounted: true, visible: true, focused: true };
const hidden: DeploymentReadDemandV1 = { mounted: true, visible: false, focused: true };
const scope = { serverId: 'home', accountId: 'account', projectSourceId: 'source-app' };

function networkBoundary() {
    const environment = createDeploymentEnvironmentHeaderV1({ projectSourceId: scope.projectSourceId });
    const environmentDetail = createDeploymentEnvironmentDetailV1({ environment });
    const receipt = createDeploymentReceiptHeaderV1({ environmentId: environment.id });
    const receiptDetail = createDeploymentReceiptDetailV1({ deployment: receipt });
    const transport = {
        listEnvironments: vi.fn<DeploymentReadTransportV1['listEnvironments']>().mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({ items: [{ environment, title: 'Staging' }] }) }),
        readEnvironment: vi.fn<DeploymentReadTransportV1['readEnvironment']>().mockResolvedValue({ ok: true, value: environmentDetail }),
        listHistory: vi.fn<DeploymentReadTransportV1['listHistory']>().mockResolvedValue({ ok: true, value: { ok: true, items: [createDeploymentReceiptHeaderV1()], nextCursor: null } }),
        readReceipt: vi.fn<DeploymentReadTransportV1['readReceipt']>().mockResolvedValue({ ok: true, value: receiptDetail }),
        observeReceipts: vi.fn<NonNullable<DeploymentReadTransportV1['observeReceipts']>>().mockResolvedValue({ ok: true, value: [] }),
    } satisfies DeploymentReadTransportV1;
    return { environment, environmentDetail, receipt, receiptDetail, transport };
}

describe('deployment demand read controller', () => {
    it('retains current headers across released demand and reads only invalidated headers on return', async () => {
        const base = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: base.transport });
        let lease = controller.acquireCollection({ environmentIds: [base.environment.id] }, active);
        try {
            await lease.refresh();
            const retained = lease.getSnapshot();
            lease.release();
            lease = controller.acquireCollection({ environmentIds: [base.environment.id] }, active);
            expect(lease.getSnapshot()).toBe(retained);
            expect(base.transport.listEnvironments, 'current header remount adds zero reads').toHaveBeenCalledTimes(1);
            lease.release();
            controller.invalidate({ environmentId: 'unrelated-environment' });
            expect(base.transport.listEnvironments).toHaveBeenCalledTimes(1);
            base.transport.listEnvironments.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({
                items: [{ environment: { ...base.environment, revision: 2 }, title: 'Renamed' }],
            }) });
            controller.invalidate({ environmentId: base.environment.id });
            expect(base.transport.listEnvironments, 'inactive invalidation never fetches').toHaveBeenCalledTimes(1);
            lease = controller.acquireCollection({ environmentIds: [base.environment.id] }, active);
            await vi.waitFor(() => expect(lease.getSnapshot().value?.items[0]?.title).toBe('Renamed'));
            expect(base.transport.listEnvironments).toHaveBeenCalledTimes(2);
            controller.retire();
            expect(lease.getSnapshot().value).toBeNull();
        } finally { lease.release(); controller.retire(); }
    });

    it('isolates template-selected preview pages and refuses another template in the selected response', async () => {
        const base = networkBoundary();
        const preview = createDeploymentEnvironmentHeaderV1({ purpose: 'preview', previewTemplateEnvironmentId: 'template-b',
            previewRepositoryId: scope.projectSourceId, previewPullRequestId: 'pr:17', previewTargetLinkId: 'target-link' });
        base.transport.listEnvironments.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({
            items: [{ environment: preview, title: 'Preview' }],
        }) });
        const controller = createDeploymentReadControllerV1({ scope, transport: base.transport });
        const selected = controller.acquireCollection({ previewTemplateEnvironmentId: 'template-a' }, active);
        const peer = controller.acquireCollection({ previewTemplateEnvironmentId: 'template-b' }, active);
        try {
            await Promise.all([selected.refresh(), peer.refresh()]);
            expect(selected.getSnapshot()).toMatchObject({ status: 'unavailable', failure: { code: 'invalid_response' } });
            expect(peer.getSnapshot()).toMatchObject({ status: 'ready', value: { items: [{ environment: { previewTemplateEnvironmentId: 'template-b' } }] } });
            expect(base.transport.listEnvironments).toHaveBeenCalledTimes(2);
        } finally { selected.release(); peer.release(); controller.retire(); }
    });
    it('shares one Environment read across one hundred joining demand leases and reads again only on an explicit refresh', async () => {
        const base = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: base.transport });
        const first = controller.acquireEnvironment(base.environment.id, active);
        const joined = Array.from({ length: 100 }, () => controller.acquireEnvironment(base.environment.id, hidden));
        try {
            await first.refresh();
            const ready = first.getSnapshot();
            expect(base.transport.readEnvironment).toHaveBeenCalledTimes(1);
            for (const lease of joined) {
                lease.setDemand(active);
                expect(lease.getSnapshot()).toBe(ready);
            }
            expect(base.transport.readEnvironment).toHaveBeenCalledTimes(1);
            for (const lease of joined) lease.setDemand(hidden);
            first.setDemand(hidden);
            first.setDemand(active);
            await first.refresh();
            expect(base.transport.readEnvironment).toHaveBeenCalledTimes(2);
        } finally { for (const lease of joined) lease.release(); first.release(); controller.retire(); }
    });
    it('loads one demanded Domain page and ignores receipt arrivals while Environment changes refresh it', async () => {
        const base = networkBoundary();
        const reads: (string | undefined)[] = [];
        const item = { domain: DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: base.environment.id,
            targetLinkId: 'target', revision: 1, state: 'active', contentArtifactId: 'domain-content', contentHeaderVersion: 1,
            contentBodyVersion: 1, createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 1 }), title: 'Web',
            content: DeploymentDomainContentV1Schema.parse({ hostname: 'web.example.test', target: { service: 'web', containerPort: 8080 },
                healthCheck: { path: '/', expectStatus: 200 } }) };
        let page: DeploymentDomainPageV1 = { items: [item], nextCursor: 'next' };
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport,
            listDomains: async (_scope, _id, query) => { reads.push(query.cursor); return { ok: true, value: structuredClone(page) }; },
        } });
        const lease = controller.acquireDomains(base.environment.id, {}, hidden);
        try {
            expect(reads).toEqual([]);
            lease.setDemand(active);
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { items: [item], hasNextPage: true } });
            expect(reads).toEqual([undefined]);
            const retainedItem = lease.getSnapshot().value!.items[0];
            controller.invalidate(Array.from({ length: 100 }, (_, i) => ({ environmentId: base.environment.id, deploymentId: `receipt-${i}` })));
            expect(reads).toEqual([undefined]);
            page = { items: [{ ...item, domain: { ...item.domain, id: 'earlier-domain' } }, item], nextCursor: 'next' };
            controller.invalidate({ environmentId: base.environment.id });
            await lease.refresh();
            expect(lease.getSnapshot().value?.items[1]).toBe(retainedItem);
            page = { items: [{ ...item, domain: { ...item.domain, revision: 2, state: 'warning' } }], nextCursor: null };
            controller.invalidate({ environmentId: base.environment.id });
            await lease.refresh();
            expect(lease.getSnapshot().value?.hasNextPage).toBe(false);
            expect(lease.getSnapshot().value?.items[0]?.domain).toMatchObject({ revision: 2, state: 'warning' });
            expect(reads).toEqual([undefined, undefined, undefined]);
        } finally { lease.release(); controller.retire(); }
    });
    it('shares one current Environment health feed beside receipt facts and releases health-only demand', async () => {
        const base = networkBoundary();
        const peer = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, id: 'peer-environment' },
            targetLinks: base.environmentDetail.targetLinks.map(link => ({ ...link,
                targetLink: { ...link.targetLink, environmentId: 'peer-environment' } })) });
        type Feed = DeploymentEnvironmentHealthFeedV1;
        const publishers = new Map<string, (feed: Feed) => void>();
        const opens: string[] = [];
        const closes: string[] = [];
        const transport = { ...base.transport,
            readEnvironment: vi.fn(async (_scope: unknown, id: string) => ({ ok: true as const,
                value: id === peer.environment.id ? peer : base.environmentDetail })),
            observeEnvironmentHealth(_scope: unknown, detail: typeof base.environmentDetail, publish: (feed: Feed) => void) {
                const id = detail.environment.id;
                opens.push(id); publishers.set(id, publish);
                return () => { closes.push(id); publishers.delete(id); };
            },
        };
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const record = controller.acquireEnvironment(base.environment.id, active);
        const environment = controller.acquireEnvironment(base.environment.id, active, { health: true });
        const receiptPage = controller.acquireEnvironment(base.environment.id, active, { health: true });
        const unaffected = controller.acquireEnvironment(peer.environment.id, active, { health: true });
        const feed = (environmentId: string, state: 'up' | 'down', observedAt: number): Feed => ({ environmentId, status: 'ready',
            members: [{ machineId: 'runtime-machine', installationId: 'installation', status: 'ready', services: [
                { serviceId: 'app/web', state, observedAt, reason: state === 'down' ? 'not_ready' : null },
            ] }] });
        try {
            await Promise.all([record.refresh(), environment.refresh(), receiptPage.refresh(), unaffected.refresh()]);
            expect(opens).toEqual([base.environment.id, peer.environment.id]);
            publishers.get(base.environment.id)?.(feed(base.environment.id, 'down', 100));
            expect(environment.getSnapshot().value?.healthFeed).toMatchObject({ status: 'ready', members: [{ services: [
                { state: 'down', observedAt: 100, reason: 'not_ready' },
            ] }] });
            expect(receiptPage.getSnapshot()).toBe(environment.getSnapshot());
            const first = environment.getSnapshot();
            const publications = vi.fn();
            environment.subscribe(publications);
            for (let i = 0; i < 20; i++) publishers.get(peer.environment.id)?.(feed(peer.environment.id, i % 2 ? 'up' : 'down', 100 + i));
            publishers.get(base.environment.id)?.(feed(base.environment.id, 'down', 100));
            expect(publications).not.toHaveBeenCalled();
            expect(environment.getSnapshot()).toBe(first);
            expect(transport.readEnvironment).toHaveBeenCalledTimes(2);
            publishers.get(base.environment.id)?.(feed(base.environment.id, 'up', 200));
            expect(publications).toHaveBeenCalledTimes(1);
            expect(receiptPage.getSnapshot().value?.healthFeed?.members[0]?.services[0]).toMatchObject({ state: 'up', observedAt: 200, reason: null });
            await record.refresh();
            expect(environment.getSnapshot().value?.healthFeed).toBe(receiptPage.getSnapshot().value?.healthFeed);
            expect(environment.getSnapshot().value?.healthFeed?.members[0]?.services[0]?.observedAt).toBe(200);
            expect(opens).toHaveLength(2);
            expect(publications).toHaveBeenCalledTimes(1);
            environment.setDemand(hidden); receiptPage.setDemand(hidden);
            expect(closes).toEqual([base.environment.id]); // The title-only record is not health demand.
            expect(publishers.has(base.environment.id)).toBe(false);
            receiptPage.setDemand(active);
            await receiptPage.refresh();
            expect(opens.filter(id => id === base.environment.id)).toHaveLength(2);
            controller.retire();
            expect(receiptPage.getSnapshot().value).toBeNull();
            expect(closes).toHaveLength(3);
        } finally { for (const lease of [record, environment, receiptPage, unaffected]) lease.release(); controller.retire(); }
    });
    it('retains current health through metadata and receipt refreshes, and replaces its binding only for runtime membership', async () => {
        const base = networkBoundary();
        const link = base.environmentDetail.targetLinks[0]!;
        const member = link.targetLink.members[0]!;
        const members = [member, { ...member, machineId: 'machine-b', installationId: 'installation-b' }];
        const detail = createDeploymentEnvironmentDetailV1({ ...base.environmentDetail,
            targetLinks: [{ ...link, targetLink: { ...link.targetLink, machines: members.map(item => item.machineId), members } }] });
        base.transport.readEnvironment.mockResolvedValue({ ok: true, value: detail });
        const observations: { signal: AbortSignal; publish: (feed: DeploymentEnvironmentHealthFeedV1) => void; stop: ReturnType<typeof vi.fn> }[] = [];
        const observeEnvironmentHealth: NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']> = (_scope, admitted, publish, { signal }) => {
            const stop = vi.fn();
            observations.push({ signal, publish, stop });
            publish({ environmentId: admitted.environment.id, status: 'ready', members: [] });
            return stop;
        };
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport, observeEnvironmentHealth } });
        const environment = controller.acquireEnvironment(base.environment.id, active, { health: true });
        const receipt = controller.acquireReceipt(base.environment.id, base.receipt.id, active);
        try {
            await Promise.all([environment.refresh(), receipt.refresh()]);
            const health = environment.getSnapshot().value?.healthFeed;
            const renamed = { ...detail, environment: { ...detail.environment, revision: 2, updatedAtMs: 2000 },
                content: { ...detail.content, name: 'Renamed' }, targetLinks: [{ ...link, targetLink: { ...link.targetLink,
                    revision: 2, updatedAtMs: 2000, machines: [...members].reverse().map(item => item.machineId), members: [...members].reverse() } }] };
            base.transport.readEnvironment.mockResolvedValue({ ok: true, value: renamed });
            await environment.refresh();
            await receipt.refresh();
            expect(environment.getSnapshot().value?.content.name).toBe('Renamed');
            expect(environment.getSnapshot().value?.healthFeed).toBe(health);
            expect(observations).toHaveLength(1);
            expect(observations[0]!.signal.aborted).toBe(false);

            base.transport.readEnvironment.mockResolvedValue({ ok: true, value: { ...renamed,
                targetLinks: renamed.targetLinks.map(item => ({ ...item, targetLink: { ...item.targetLink, revision: 3,
                    members: item.targetLink.members.map(current => current.machineId === 'machine-b'
                        ? { ...current, installationId: 'replacement-installation' } : current) } })) } });
            await environment.refresh();
            expect(observations).toHaveLength(2);
            expect(observations[0]!.signal.aborted).toBe(true);
            expect(observations[0]!.stop).toHaveBeenCalledTimes(1);
            base.transport.readEnvironment.mockResolvedValue({ ok: false, failure: { code: 'access_denied', retryable: false } });
            await environment.refresh();
            expect(environment.getSnapshot().value).toBeNull();
            expect(observations[1]!.signal.aborted).toBe(true);
            expect(observations[1]!.stop).toHaveBeenCalledTimes(1);
            observations[1]!.publish({ environmentId: base.environment.id, status: 'ready', members: [] });
            expect(environment.getSnapshot().value).toBeNull();
        } finally { environment.release(); receipt.release(); controller.retire(); }
    });
    it('rebinds the shared current aggregate when protection changes without treating unknown coverage as recovery', async () => {
        const base = networkBoundary();
        let detail: typeof base.environmentDetail = { ...base.environmentDetail,
            environment: { ...base.environment, protection: 'nonProduction' } };
        const bindings: ReturnType<typeof createDeploymentHealthAggregateLeaseV1>[] = [];
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport,
            readEnvironment: async () => ({ ok: true, value: detail }),
            observeEnvironmentHealth(_scope, admitted, publish, { signal }) {
                const targetLink = admitted.runtimeTargetLink!;
                const health = createDeploymentHealthAggregateLeaseV1({
                    initial: { environment: admitted.environment, targetLink,
                        observations: targetLink.members.filter(member => member.state === 'active').map((member): DeploymentHealthServicesObservationV1 => ({
                            environmentId: admitted.environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
                            machineId: member.machineId, installationId: member.installationId, role: 'runtime',
                            source: { kind: 'native' }, observedAtMs: 1000,
                            services: [{ serviceId: 'web', observation: { status: 'up', observedAtMs: 1000 } }, { serviceId: 'worker' }],
                        })) },
                    isCurrent: () => !signal.aborted, retirementSignal: signal,
                });
                bindings.push(health);
                const observation = health.observe(aggregate => publish({ environmentId: admitted.environment.id,
                    status: 'partial', members: [], aggregate }));
                return () => { observation.dispose(); health.dispose(); };
            },
        } });
        const environment = controller.acquireEnvironment(base.environment.id, active, { health: true });
        // The full receipt page borrows this same Environment entry, not a second classifier.
        const receiptPage = controller.acquireEnvironment(base.environment.id, active, { health: true });
        try {
            await Promise.all([environment.refresh(), receiptPage.refresh()]);
            const initial = environment.getSnapshot().value?.healthFeed;
            expect(initial?.aggregate).toMatchObject({ protection: 'nonProduction', down: 0, unknown: 1, authoritativeRecovery: false });
            expect(receiptPage.getSnapshot()).toBe(environment.getSnapshot());
            const publications = vi.fn();
            receiptPage.subscribe(publications);
            controller.invalidate(Array.from({ length: 20 }, (_, index) => ({ environmentId: `unrelated-${index}` })));
            expect(publications).not.toHaveBeenCalled();
            detail = { ...detail, environment: { ...detail.environment, revision: 2 } };
            await environment.refresh();
            expect(environment.getSnapshot().value?.healthFeed).toBe(initial);
            expect(bindings).toHaveLength(1);
            detail = { ...detail, environment: { ...detail.environment, revision: 3, protection: 'production' } };
            await environment.refresh();
            expect(receiptPage.getSnapshot().value?.healthFeed?.aggregate).toMatchObject({
                protection: 'production', n: 1, down: 1, unknown: 1, authoritativeRecovery: false,
            });
            expect(bindings[0]!.retirementSignal.aborted).toBe(true);
            expect(bindings).toHaveLength(2);
            detail = { ...detail, environment: { ...detail.environment, revision: 4, protection: 'nonProduction' } };
            await receiptPage.refresh();
            expect(environment.getSnapshot().value?.healthFeed?.aggregate).toMatchObject({
                protection: 'nonProduction', down: 0, unknown: 1, authoritativeRecovery: false,
            });
            expect(bindings[1]!.retirementSignal.aborted).toBe(true);
            expect(bindings).toHaveLength(3);
        } finally { environment.release(); receiptPage.release(); controller.retire(); }
    });
    it('withdraws the edge Resource when its controller or admitted link revision changes', async () => {
        const base = networkBoundary();
        let detail = { ...base.environmentDetail, environment: { ...base.environmentDetail.environment,
            ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } } };
        base.transport.readEnvironment.mockImplementation(async () => ({ ok: true, value: detail }));
        const observations: { signal: AbortSignal; publish: (feed: DeploymentEnvironmentHealthFeedV1) => void }[] = [];
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport,
            observeEnvironmentHealth(_scope, admitted, publish, { signal }) {
                observations.push({ signal, publish });
                publish({ environmentId: admitted.environment.id, status: 'loading', members: [] });
                return () => {};
            },
        } });
        const lease = controller.acquireEnvironment(base.environment.id, active, { health: true });
        try {
            await lease.refresh();
            const first = observations[0]!;
            detail = { ...detail, environment: { ...detail.environment, controllerMachineId: 'replacement-controller' } };
            await lease.refresh();
            expect(first.signal.aborted).toBe(true);
            expect(observations).toHaveLength(2);
            detail = { ...detail, targetLinks: detail.targetLinks.map(item => ({ ...item,
                targetLink: { ...item.targetLink, revision: item.targetLink.revision + 1 } })) };
            await lease.refresh();
            expect(observations[1]!.signal.aborted).toBe(true);
            expect(observations).toHaveLength(3);
            first.publish({ environmentId: base.environment.id, status: 'ready', members: [] });
            expect(lease.getSnapshot().value?.healthFeed?.status).toBe('loading');
        } finally { lease.release(); controller.retire(); }
    });
    it('keeps the admitted value and the read in flight through presentation remounts while later reads stall', async () => {
        const base = networkBoundary();
        const revision = (value: number) => ({ ...base.environmentDetail, environment: { ...base.environmentDetail.environment, revision: value } });
        const reads: { signal: AbortSignal; settle: () => void }[] = [];
        // QA #63: viewport/theme captures remounted the page; every remount released the record (dropping its value)
        // and aborted the read in flight, so completed reads never landed and the page stayed on Loading.
        const readEnvironment: DeploymentReadTransportV1['readEnvironment'] = (_scope, _id, { signal }) => new Promise(resolve => {
            const value = revision(reads.length + 1);
            reads.push({ signal, settle: () => resolve({ ok: true, value }) });
        });
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport, readEnvironment } });
        const inactive = { mounted: false, visible: false, focused: false };
        const remount = (lease: ReturnType<typeof controller.acquireEnvironment>) => {
            lease.setDemand(inactive);
            lease.release();
            const next = controller.acquireEnvironment(base.environment.id, inactive);
            next.setDemand(active);
            return next;
        };
        let lease = controller.acquireEnvironment(base.environment.id, active);
        try {
            for (let churn = 0; churn < 5; churn++) lease = remount(lease);
            expect(reads, 'remounts join the first read instead of restarting it').toHaveLength(1);
            expect(reads[0]!.signal.aborted).toBe(false);
            reads[0]!.settle();
            await vi.waitFor(() => expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { environment: { revision: 1 } } }));
            const admitted = lease.getSnapshot();
            lease = remount(lease);
            expect(lease.getSnapshot(), 'a remount keeps the admitted value').toBe(admitted);
            expect(reads, 'a clean remount reads nothing').toHaveLength(1);
            void controller.refreshDemanded();
            expect(reads, 'a wake re-reads beside the admitted value').toHaveLength(2);
            for (let churn = 0; churn < 5; churn++) lease = remount(lease);
            expect(lease.getSnapshot()).toBe(admitted);
            expect(reads, 'a stalled read is joined, not multiplied').toHaveLength(2);
            reads[1]!.settle();
            await vi.waitFor(() => expect(lease.getSnapshot().value?.environment.revision).toBe(2));
        } finally { lease.release(); controller.retire(); }
    });
    it('keeps the serving receipt through a presentation remount instead of returning to Loading', async () => {
        // QA #64: the serving receipt showed at 1440, then every switch to 390 remounted the page, the released receipt
        // record was dropped, and "Serving now" went back to Loading for data the page already held.
        const base = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: base.transport });
        const inactive = { mounted: false, visible: false, focused: false };
        let lease = controller.acquireReceipt(base.environment.id, base.receipt.id, active);
        try {
            await vi.waitFor(() => expect(lease.getSnapshot().status).toBe('ready'));
            const admitted = lease.getSnapshot().value;
            base.transport.readReceipt.mockImplementation(() => new Promise(() => {}));
            lease.setDemand(inactive);
            lease.release();
            lease = controller.acquireReceipt(base.environment.id, base.receipt.id, inactive);
            lease.setDemand(active);
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: admitted });
        } finally { lease.release(); controller.retire(); }
    });
    it('returns to a held receipt with zero repeat reads until a change signal marks it stale', async () => {
        // QA #65: each detail return made 2 GETs of the receipt the page already held.
        const base = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport: base.transport });
        const inactive = { mounted: false, visible: false, focused: false };
        const open = () => { const lease = controller.acquireReceipt(base.environment.id, base.receipt.id, inactive); lease.setDemand(active); return lease; };
        const leave = (lease: ReturnType<typeof open>) => { lease.setDemand(inactive); lease.release(); };
        let serving = open();
        let backup = open();
        try {
            await vi.waitFor(() => expect(serving.getSnapshot().status).toBe('ready'));
            expect(base.transport.readReceipt).toHaveBeenCalledTimes(1);
            for (let visit = 0; visit < 3; visit++) {
                leave(serving); leave(backup);
                serving = open(); backup = open();
                backup.setDemand(hidden); backup.setDemand(active);
            }
            expect(serving.getSnapshot().status).toBe('ready');
            expect(base.transport.readReceipt, 'returns reuse the held receipt').toHaveBeenCalledTimes(1);
            leave(serving); leave(backup);
            controller.invalidate({ environmentId: base.environment.id, projectSourceId: scope.projectSourceId, deploymentId: base.receipt.id });
            serving = open(); backup = open();
            expect(base.transport.readReceipt, 'a change while away re-reads once on return').toHaveBeenCalledTimes(2);
        } finally { leave(serving); leave(backup); controller.retire(); }
    });
    it('settles a first read through a storm of connection wakes, then re-reads once for what they may have changed', async () => {
        const base = networkBoundary();
        const revision = (value: number) => ({ ...base.environmentDetail, environment: { ...base.environmentDetail.environment, revision: value } });
        const reads: { signal: AbortSignal; settle: () => void }[] = [];
        // QA #62: a socket reconnecting every ~350 ms aborted every read of 1-3 s, leaving "Loading" with demand active.
        const readEnvironment: DeploymentReadTransportV1['readEnvironment'] = (_scope, _id, { signal }) => new Promise(resolve => {
            const value = revision(reads.length + 1);
            reads.push({ signal, settle: () => resolve({ ok: true, value }) });
        });
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport, readEnvironment } });
        const lease = controller.acquireEnvironment(base.environment.id, active);
        try {
            for (let wake = 0; wake < 5; wake++) void controller.refreshDemanded();
            expect(reads, 'the first read plus one newer read, however many wakes').toHaveLength(2);
            expect(reads[0]!.signal.aborted, 'a wake does not abort the read in flight').toBe(false);
            reads[0]!.settle();
            await vi.waitFor(() => expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { environment: { revision: 1 } } }));
            reads[1]!.settle();
            await vi.waitFor(() => expect(lease.getSnapshot().value?.environment.revision).toBe(2));
            await vi.waitFor(() => expect(reads, 'the later wakes coalesced into one re-read').toHaveLength(3));
            reads[2]!.settle();
            await vi.waitFor(() => expect(lease.getSnapshot().value?.environment.revision).toBe(3));
            expect(reads).toHaveLength(3);
        } finally { lease.release(); controller.retire(); }
    });

    it('supersedes a held current health subscription on explicit recovery and ignores its late facts', async () => {
        const base = networkBoundary();
        const observations: { signal: AbortSignal; publish: (feed: DeploymentEnvironmentHealthFeedV1) => void; stop: ReturnType<typeof vi.fn> }[] = [];
        const observeEnvironmentHealth: NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']> = (_scope, _detail, publish, { signal }) => {
            const stop = vi.fn();
            observations.push({ signal, publish, stop });
            return stop;
        };
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...base.transport, observeEnvironmentHealth } });
        const lease = controller.acquireEnvironment(base.environment.id, active, { health: true });
        const feed = (state: 'up' | 'down', observedAt: number): DeploymentEnvironmentHealthFeedV1 => ({
            environmentId: base.environment.id, status: 'ready', members: [{ machineId: 'machine-a',
                installationId: 'installation-a', status: 'ready', services: [{ serviceId: 'web', state, observedAt, reason: null }] }],
        });
        try {
            await lease.refresh();
            expect(observations).toHaveLength(1);
            await lease.refresh({ supersede: true });
            expect(observations[0]!.signal.aborted).toBe(true);
            expect(observations[0]!.stop).toHaveBeenCalledTimes(1);
            expect(observations).toHaveLength(2);
            observations[1]!.publish(feed('up', 200));
            observations[0]!.publish(feed('down', 100));
            expect(lease.getSnapshot().value?.healthFeed?.members[0]?.services[0]).toMatchObject({ state: 'up', observedAt: 200 });
            await lease.refresh();
            expect(observations).toHaveLength(2);
        } finally { lease.release(); controller.retire(); }
    });
    it('preserves producer cancellation availability and leaves legacy receipt availability unknown without another read', async () => {
        const { environment, receiptDetail, transport } = networkBoundary();
        const running = { ...receiptDetail, deployment: createDeploymentReceiptHeaderV1({ ...receiptDetail.deployment,
            state: 'running', settledAtMs: undefined }) };
        transport.readReceipt.mockResolvedValue({ ok: true, value: { ...running, cancellable: true } });
        // The UI transport has no native observation port; this fact must not open another reader.
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...transport, observeReceipts: undefined } });
        const lease = controller.acquireReceipt(environment.id, receiptDetail.deployment.id, active);
        try {
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { cancellable: true } });
            transport.readReceipt.mockResolvedValue({ ok: true, value: { ...running, cancellable: false } });
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { cancellable: false } });
            transport.readReceipt.mockResolvedValue({ ok: true, value: receiptDetail });
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready' });
            expect(Reflect.get(lease.getSnapshot().value!, 'cancellable')).toBeUndefined();
            expect(transport.readReceipt).toHaveBeenCalledTimes(3);
            expect(transport.readEnvironment).not.toHaveBeenCalled();
            expect(transport.listHistory).not.toHaveBeenCalled();
        } finally { lease.release(); controller.retire(); }
    });
    it('publishes failed receipt investigation facts without a second read or guessing historical values', async () => {
        const { environment, receiptDetail, transport } = networkBoundary();
        const content = { ...receiptDetail.content, failure: { code: 'native_build_failed', phase: 'build' },
            steps: [{ id: 'build', label: 'Build', state: 'failed' }],
            commitSubject: 'Repair worker startup', ownServer: { approvedInputBasis: {
                v: 1, environmentId: environment.id, environmentRevision: 1, targetLinkId: receiptDetail.deployment.targetLinkId,
                targetLinkRevision: 1, sourceIntent: receiptDetail.content.sourceIntent, manifestFingerprint: 'manifest',
                configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1', services: ['app'], profiles: [],
                members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [],
                ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true },
            }, rollbackTarget: { deploymentId: 'last-good', revision: { kind: 'repository', sha: 'a'.repeat(40) } },
            stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a', relativePath: '.happier/deploy.log',
                steps: [{ ref: 'build', range: { start: 0, end: 25 } }, { ref: 'cleanup', range: { start: 25, end: null } }],
                excerpt: { text: 'build failed [REDACTED]', truncated: false } }] } };
        transport.readReceipt.mockResolvedValue({ ok: true, value: { ...receiptDetail,
            deployment: { ...receiptDetail.deployment, state: 'failed' }, content } });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireReceipt(environment.id, receiptDetail.deployment.id, active);
        try {
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { facts: {
                failure: { code: 'native_build_failed', phase: 'build' }, commitSubject: 'Repair worker startup',
                rollbackTarget: { deploymentId: 'last-good' },
                logs: [{ reference: { kind: 'build', environmentId: environment.id,
                    deploymentId: receiptDetail.deployment.id, machineId: 'machine-a', installationId: 'installation-a' },
                    excerpt: { text: 'build failed [REDACTED]', truncated: false } }],
                steps: [{ id: 'build', logs: [{ reference: { kind: 'build' } }],
                    stageLogs: [{ ref: 'build', range: { start: 0, end: 25 }, reference: { kind: 'build', ref: 'build' } }] }],
                downtime: 'stopThenStart',
            } } });
            expect(transport.readReceipt).toHaveBeenCalledTimes(1);
            expect(transport.readEnvironment).not.toHaveBeenCalled();
            expect(transport.listHistory).not.toHaveBeenCalled();
            // Legacy content has no captured diagnostics: do not manufacture a cause,
            // rollback target, subject or live URL from lifecycle/lineage alone.
            transport.readReceipt.mockResolvedValue({ ok: true, value: { ...receiptDetail,
                deployment: { ...receiptDetail.deployment, state: 'failed', predecessorDeploymentId: 'not-proven-good' } } });
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { facts: {
                failure: null, commitSubject: null, rollbackTarget: undefined, logs: [], urls: null, downtime: null,
            } } });
            const account = { service: { pluginId: 'acme.deploy', localId: 'account' }, accountId: 'provider-account' };
            transport.readReceipt.mockResolvedValue({ ok: true, value: { ...receiptDetail, content: {
                sourceIntent: receiptDetail.content.sourceIntent, sourceMethod: 'gitIntegration',
                machines: [], images: [], machineResults: [], steps: [], platform: {
                    targetLinkRevision: 1,
                    credentialPrincipal: { kind: 'account', accountId: 'account',
                        purpose: { consumer: { pluginId: 'acme.deploy', localId: 'deploy' }, purpose: 'action-account' },
                        target: { kind: 'account', account } },
                    providerIdentity: { providerAccountId: 'provider-owner', providerResourceId: 'project', providerEnvironment: 'production' },
                    providerEnvironment: { kind: 'production' },
                    observation: { v: 1, state: 'succeeded', observedAtMs: 2000, urls: ['https://app.example.test'] },
                },
            } } });
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { facts: {
                urls: ['https://app.example.test'], urlsObservedAtMs: 2000, health: { source: 'receipt', members: [] },
            } } });
        } finally { lease.release(); controller.retire(); }
    });
    it('reads global badge facts without opening or draining a collection page', async () => {
        const { transport } = networkBoundary();
        transport.listEnvironments.mockResolvedValue({ ok: true, value: { items: [], coverage: 'partial', nextCursor: 'unopened-page' } });
        const readActivity = vi.fn(async () => ({ ok: true as const, value: { running: false, failed: true } }));
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...transport, readActivity } });
        const badge = controller.acquireActivity(active);
        try {
            await badge.refresh();
            expect(badge.getSnapshot()).toMatchObject({ status: 'ready', value: { running: false, failed: true } });
            expect(readActivity).toHaveBeenCalledTimes(1);
            expect(transport.listEnvironments).not.toHaveBeenCalled();
            expect(transport.readEnvironment).not.toHaveBeenCalled();
            expect(transport.listHistory).not.toHaveBeenCalled();
            const publications = vi.fn();
            badge.subscribe(publications);
            controller.invalidate(Array.from({ length: 100 }, (_, index) => ({ environmentId: `progress-${index}`, deploymentId: `receipt-${index}` })));
            await Promise.resolve();
            expect(readActivity).toHaveBeenCalledTimes(1);
            expect(publications).not.toHaveBeenCalled();
            readActivity.mockResolvedValue({ ok: true, value: { running: true, failed: false } });
            controller.invalidate({ environmentId: 'changed-environment', activityChanged: true });
            await badge.refresh();
            expect(badge.getSnapshot().value).toEqual({ running: true, failed: false });
            expect(readActivity).toHaveBeenCalledTimes(2);
            expect(publications).toHaveBeenCalledTimes(1);
        } finally { badge.release(); controller.retire(); }
    });

    it('shares badge and chip reads while publishing only their changed facts', async () => {
        const { environment, receiptDetail, transport } = networkBoundary();
        let detail = { ...receiptDetail, deployment: { ...receiptDetail.deployment, state: 'running' as const } };
        let title = 'App';
        const readActivity = vi.fn(async () => ({ ok: true as const, value: { running: true, failed: false } }));
        transport.listEnvironments.mockImplementation(async () => ({ ok: true, value: {
            items: [{ environment, title, currentDeployment: detail.deployment }], nextCursor: null,
        } }));
        transport.readReceipt.mockImplementation(async () => ({ ok: true, value: detail }));
        const controller = createDeploymentReadControllerV1({ scope, transport: { ...transport, readActivity, observeReceipts: undefined } });
        const page = controller.acquireCollection({}, active);
        const badge = controller.acquireActivity(active);
        const receipt = controller.acquireReceipt(environment.id, detail.deployment.id, active);
        const chip = controller.acquireReceiptChip(environment.id, detail.deployment.id, active);
        try {
            await Promise.all([page.refresh(), badge.refresh(), receipt.refresh(), chip.refresh()]);
            expect(transport.listEnvironments).toHaveBeenCalledTimes(1);
            expect(transport.readReceipt).toHaveBeenCalledTimes(1);
            expect(readActivity).toHaveBeenCalledTimes(1);
            const badgeChanges = vi.fn(); const chipChanges = vi.fn();
            badge.subscribe(badgeChanges); chip.subscribe(chipChanges);
            title = 'Renamed';
            detail = { ...detail, deployment: { ...detail.deployment, revision: detail.deployment.revision + 1 } };
            await Promise.all([badge.refresh(), chip.refresh()]);
            expect(badgeChanges).not.toHaveBeenCalled();
            expect(chipChanges).not.toHaveBeenCalled();
            const failed = { ...detail, deployment: { ...detail.deployment, state: 'failed' as const } };
            readActivity.mockResolvedValue({ ok: true, value: { running: false, failed: true } });
            transport.readReceipt.mockResolvedValue({ ok: true, value: failed });
            transport.listEnvironments.mockResolvedValue({ ok: true, value: {
                items: [{ environment, title, currentDeployment: failed.deployment }], nextCursor: null,
            } });
            controller.invalidate([{ environmentId: environment.id, deploymentId: failed.deployment.id },
                { environmentId: environment.id, activityChanged: true }]);
            await Promise.all([badge.refresh(), chip.refresh()]);
            expect(badge.getSnapshot().value).toEqual({ running: false, failed: true });
            expect(chip.getSnapshot().value).toMatchObject({ state: 'failed', running: false, failed: true });
            expect(badgeChanges).toHaveBeenCalledTimes(1);
            expect(chipChanges).toHaveBeenCalledTimes(1);
        } finally { page.release(); badge.release(); receipt.release(); chip.release(); controller.retire(); }
    });

    it('publishes collection chip facts from receipt state while retaining unchanged rows', async () => {
        const { environment, receipt, transport } = networkBoundary();
        const peer = createDeploymentEnvironmentHeaderV1({ id: 'peer-environment', projectSourceId: scope.projectSourceId });
        let state = 'running';
        transport.listEnvironments.mockImplementation(async () => ({ ok: true, value: {
            items: [{ environment, title: 'App', currentDeployment: { ...receipt, state } },
                { environment: peer, title: 'Peer', currentDeployment: null }],
            coverage: 'complete', nextCursor: null,
        } }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const page = controller.acquireCollection({}, active);
        try {
            await page.refresh();
            expect(page.getSnapshot().value).toMatchObject({ items: [
                { chip: { environmentId: environment.id, deploymentId: receipt.id, state: 'running', running: true, failed: false } },
                { chip: null },
            ] });
            const stablePeer = page.getSnapshot().value!.items[1];
            const publications = vi.fn();
            page.subscribe(publications);
            for (let index = 0; index < 20; index++) await page.refresh();
            expect(publications).not.toHaveBeenCalled();
            state = 'failed';
            controller.invalidate({ environmentId: environment.id, deploymentId: receipt.id });
            await page.refresh();
            expect(page.getSnapshot().value).toMatchObject({ items: [
                { chip: { state: 'failed', running: false, failed: true } }, { chip: null },
            ] });
            expect(page.getSnapshot().value!.items[1]).toBe(stablePeer);
            expect(publications).toHaveBeenCalledTimes(1);
        } finally { page.release(); controller.retire(); }
    });

    it('coalesces exact owner header demand without refreshing it for unrelated Environments', async () => {
        const { transport } = networkBoundary();
        const environments = ['environment-a', 'environment-b'].map(id => createDeploymentEnvironmentHeaderV1({
            id, serverId: scope.serverId, projectSourceId: scope.projectSourceId,
        }));
        transport.listEnvironments.mockImplementation(async (_scope, query) => {
            // This is the external read boundary: return only the requested
            // native headers, as the production list endpoint must do.
            const ids: unknown = Reflect.get(query, 'environmentIds');
            const selected = new Set(Array.isArray(ids) ? ids : []);
            return { ok: true, value: { items: environments.filter(row => selected.has(row.id))
                .map(environment => ({ environment, title: environment.id })), nextCursor: null } };
        });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const firstQuery = { machineId: undefined, environmentIds: ['environment-a'] };
        const secondQuery = { machineId: undefined, environmentIds: ['environment-b'] };
        const peerQuery = { ...firstQuery, environmentIds: ['environment-a', 'environment-a'] };
        const left = controller.acquireCollection(firstQuery, active);
        const right = controller.acquireCollection(secondQuery, active);
        const peer = controller.acquireCollection(peerQuery, active);
        try {
            await Promise.all([left.refresh(), right.refresh(), peer.refresh()]);
            expect(left.getSnapshot().value?.items.map(item => item.environment.id)).toEqual(['environment-a']);
            expect(right.getSnapshot().value?.items.map(item => item.environment.id)).toEqual(['environment-b']);
            expect(peer.getSnapshot().value).toBe(left.getSnapshot().value);
            expect(transport.listEnvironments).toHaveBeenCalledTimes(2);
            transport.listEnvironments.mockClear();
            const stable = left.getSnapshot();
            controller.invalidate({ environmentId: 'not-a-visible-group' });
            await Promise.resolve();
            expect(transport.listEnvironments).not.toHaveBeenCalled();
            expect(left.getSnapshot()).toBe(stable);
            controller.invalidate({ environmentId: 'environment-a' });
            await Promise.all([left.refresh(), peer.refresh()]);
            expect(transport.listEnvironments).toHaveBeenCalledTimes(1);
            expect(transport.readEnvironment).not.toHaveBeenCalled();
            expect(transport.listHistory).not.toHaveBeenCalled();
            expect(transport.readReceipt).not.toHaveBeenCalled();
        } finally { left.release(); right.release(); peer.release(); controller.retire(); }
    });

    it.each(['collection', 'history'] as const)('publishes only real %s page changes while rotating opaque request cursors privately', async kind => {
        const { environment, receipt, transport } = networkBoundary();
        let cursor = 0;
        let changed = false;
        transport.listEnvironments.mockImplementation(async () => ({ ok: true, value: {
            items: changed ? [{ environment, title: 'Visible' }] : [], coverage: 'partial', nextCursor: `opaque-${++cursor}`,
        } }));
        transport.listHistory.mockImplementation(async () => ({ ok: true, value: {
            ok: true, items: changed ? [receipt] : [], nextCursor: `opaque-${++cursor}`,
        } }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = kind === 'collection' ? controller.acquireCollection({}, active) : controller.acquireHistory(environment.id, {}, active);
        try {
            await lease.refresh();
            const ready = lease.getSnapshot();
            const publications = vi.fn();
            lease.subscribe(publications);
            for (let index = 0; index < 10; index++) await lease.refresh();
            expect(publications).toHaveBeenCalledTimes(0);
            expect(lease.getSnapshot()).toBe(ready);
            expect(lease.getSnapshot().value).not.toHaveProperty('nextCursor');
            expect(lease.getSnapshot().value).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
            changed = true;
            await lease.refresh();
            expect(publications).toHaveBeenCalledTimes(1);
            const latest = `opaque-${cursor}`;
            lease.nextPage();
            await lease.refresh();
            const spent = kind === 'collection' ? transport.listEnvironments.mock.calls.at(-1)?.[1].cursor
                : transport.listHistory.mock.calls.at(-1)?.[2].cursor;
            expect(spent).toBe(latest);
            expect(lease.getSnapshot().value).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
            lease.previousPage();
            await lease.refresh();
            expect(lease.getSnapshot().value?.hasPreviousPage).toBe(false);
        } finally { lease.release(); controller.retire(); }
    });

    it('routes a consumed publication batch by Source and reads each demanded resource only once', async () => {
        const { environment, receipt, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const collection = controller.acquireCollection({}, active);
        const selected = controller.acquireEnvironment(environment.id, active);
        const history = controller.acquireHistory(environment.id, {}, active);
        const detail = controller.acquireReceipt(environment.id, receipt.id, active);
        try {
            await Promise.all([collection.refresh(), selected.refresh(), history.refresh(), detail.refresh()]);
            for (const read of [transport.listEnvironments, transport.readEnvironment, transport.listHistory, transport.readReceipt]) read.mockClear();
            controller.invalidate(Array.from({ length: 20 }, (_, index) => ({ projectSourceId: `unrelated-source-${index}`,
                environmentId: `unrelated-environment-${index}` })));
            await Promise.resolve();
            expect(transport.listEnvironments).not.toHaveBeenCalled();
            expect(transport.readEnvironment).not.toHaveBeenCalled();
            controller.invalidate([
                { projectSourceId: scope.projectSourceId, environmentId: environment.id },
                { projectSourceId: scope.projectSourceId, environmentId: environment.id, deploymentId: receipt.id },
            ]);
            await Promise.all([collection.refresh(), selected.refresh(), history.refresh(), detail.refresh()]);
            for (const read of [transport.listEnvironments, transport.readEnvironment, transport.listHistory, transport.readReceipt]) expect(read).toHaveBeenCalledTimes(1);
            transport.listEnvironments.mockResolvedValue({ ok: false, failure: { code: 'access_denied', retryable: false } });
            controller.invalidate([{ projectSourceId: scope.projectSourceId, environmentId: environment.id }]);
            await collection.refresh();
            expect(collection.getSnapshot()).toMatchObject({ status: 'unavailable', value: null, failure: { code: 'access_denied' } });
        } finally { controller.retire(); }
    });

    it('starts a second explicit Retry over a stalled retry while retaining the admitted page', async () => {
        const { environment, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireCollection({}, active);
        try {
            await lease.refresh();
            const admitted = lease.getSnapshot().value;
            transport.listEnvironments.mockResolvedValueOnce({ ok: false, failure: { code: 'home_unreachable', retryable: true } });
            await lease.refresh({ supersede: true });
            expect(lease.getSnapshot()).toMatchObject({ status: 'unavailable', value: admitted });
            let finish!: (value: Awaited<ReturnType<DeploymentReadTransportV1['listEnvironments']>>) => void;
            transport.listEnvironments.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
            const stalled = lease.refresh({ supersede: true });
            const signal = transport.listEnvironments.mock.calls.at(-1)![2].signal;
            const recovered = { items: [{ environment, title: 'Recovered' }], nextCursor: null };
            transport.listEnvironments.mockResolvedValue({ ok: true, value: recovered });
            await lease.refresh({ supersede: true });
            expect(signal.aborted).toBe(true);
            expect(transport.listEnvironments).toHaveBeenCalledTimes(4);
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { items: recovered.items, hasNextPage: false } });
            finish({ ok: true, value: { items: [], nextCursor: null } });
            await stalled;
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { items: recovered.items, hasNextPage: false } });
        } finally { lease.release(); controller.retire(); }
    });

    it.each(['live', 'missing', 'detached', 'deleted'] as const)('selects only the pointed %s runtime and keeps retained custody', async state => {
        const { environmentDetail, transport } = networkBoundary();
        const current = environmentDetail.targetLinks[0]!.targetLink;
        const retained = { ...current, id: 'retained-predecessor' };
        const selected = { ...current, ...(state === 'detached' ? { detachedAtMs: 2000 } : {}),
            ...(state === 'deleted' ? { deletedAtMs: 2000 } : {}) };
        transport.readEnvironment.mockResolvedValue({ ok: true, value: { ...environmentDetail,
            targetLinks: [{ targetLink: retained }, ...(state === 'missing' ? [] : [{ targetLink: selected }])],
        } });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireEnvironment(environmentDetail.environment.id, active);
        try {
            await lease.refresh();
            expect(lease.getSnapshot().value?.runtimeTargetLink).toEqual(state === 'live' ? selected : null);
            expect(lease.getSnapshot().value?.targetLinks[0]?.targetLink).toEqual(retained);
        } finally { lease.release(); controller.retire(); }
    });

    it('admits one Account-wide collection across Sources and preserves native partial coverage and continuation', async () => {
        const { environment, transport } = networkBoundary();
        const peer = createDeploymentEnvironmentHeaderV1({ id: 'environment-peer', projectSourceId: 'peer-source' });
        transport.listEnvironments.mockResolvedValue({ ok: true, value: {
            items: [{ environment, title: 'App' }, { environment: peer, title: 'Peer' }],
            coverage: 'partial', nextCursor: 'native-continuation',
        } });
        const controller = createDeploymentReadControllerV1({ scope: { serverId: scope.serverId, accountId: scope.accountId }, transport });
        const lease = controller.acquireCollection({}, active);
        try {
            await lease.refresh();
            expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: {
                items: [{ environment: { id: environment.id } }, { environment: { id: peer.id } }],
                coverage: 'partial', hasNextPage: true, hasPreviousPage: false,
            } });
            expect(transport.listEnvironments).toHaveBeenCalledTimes(1);
        } finally { lease.release(); controller.retire(); }
    });

    it('loads only active demand and keeps equal ready responses completely quiet', async () => {
        const { environment, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireCollection({}, hidden);
        const published = vi.fn();
        lease.subscribe(published);
        await lease.refresh();
        expect(transport.listEnvironments).not.toHaveBeenCalled();
        lease.setDemand(active);
        await lease.refresh();
        expect(lease.getSnapshot().value?.items[0]?.environment.id).toBe(environment.id);
        const ready = lease.getSnapshot();
        published.mockClear();
        transport.listEnvironments.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({
            items: structuredClone(ready.value!.items).map(({ chip: _chip, ...wireRow }) => wireRow), nextCursor: null,
        }) });
        await lease.refresh();
        expect(lease.getSnapshot()).toBe(ready);
        expect(published).not.toHaveBeenCalled();
        lease.release();
        controller.retire();
    });

    it('invalidates one Environment and preserves unaffected row and content identities', async () => {
        const { environment, environmentDetail, transport } = networkBoundary();
        const peer = createDeploymentEnvironmentHeaderV1({ id: 'environment-peer', projectSourceId: scope.projectSourceId });
        const peerDetail = createDeploymentEnvironmentDetailV1({ environment: peer, targetLinks: [] });
        const header = createDeploymentEnvironmentHeaderV1({ projectSourceId: scope.projectSourceId });
        const peerHeader = createDeploymentEnvironmentHeaderV1({ id: peer.id, projectSourceId: scope.projectSourceId });
        transport.listEnvironments.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({ items: [{ environment: header, title: 'Staging' }, { environment: peerHeader, title: 'Peer' }] }) });
        transport.readEnvironment.mockImplementation(async (_scope, id) => ({ ok: true, value: id === peer.id ? peerDetail : environmentDetail }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const collection = controller.acquireCollection({}, active);
        const selected = controller.acquireEnvironment(environment.id, active);
        const other = controller.acquireEnvironment(peer.id, active);
        await Promise.all([collection.refresh(), selected.refresh(), other.refresh()]);
        const previous = collection.getSnapshot().value!;
        const peerChanged = vi.fn();
        other.subscribe(peerChanged);
        const changed = createDeploymentEnvironmentHeaderV1({ ...environment, revision: environment.revision + 1 });
        transport.listEnvironments.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentCollectionV1({ items: [{ environment: { ...header, revision: changed.revision }, title: 'Staging' }, { environment: structuredClone(peerHeader), title: 'Peer' }] }) });
        transport.readEnvironment.mockImplementation(async (_scope, id) => ({ ok: true, value: id === peer.id ? peerDetail : { ...environmentDetail, environment: changed } }));
        transport.readEnvironment.mockClear();
        controller.invalidate({ environmentId: environment.id });
        await Promise.all([collection.refresh(), selected.refresh()]);
        expect(transport.readEnvironment.mock.calls.map(call => call[1])).toEqual([environment.id]);
        expect(collection.getSnapshot().value?.items[0]?.environment.id).toBe(selected.getSnapshot().value?.environment.id);
        expect(collection.getSnapshot().value?.items[0]).not.toBe(previous.items[0]);
        expect(collection.getSnapshot().value?.items[0]?.environment.capabilities).toBe(previous.items[0]?.environment.capabilities);
        expect(collection.getSnapshot().value?.items[1]).toBe(previous.items[1]);
        expect(peerChanged).not.toHaveBeenCalled();
        controller.retire();
    });

    it('refreshes the latest receipt only in its demanded collection page and history', async () => {
        const { environment, transport } = networkBoundary();
        const peer = createDeploymentEnvironmentHeaderV1({ id: 'environment-peer', projectSourceId: scope.projectSourceId });
        let latest = createDeploymentReceiptHeaderV1({ environmentId: environment.id, state: 'running' });
        transport.listEnvironments.mockImplementation(async (_scope, query) => ({ ok: true,
            value: createDeploymentEnvironmentCollectionV1({ items: query.cursor
                ? [{ environment: peer, title: 'Peer', currentDeployment: null }]
                : [{ environment, title: 'Staging', currentDeployment: latest }] }),
        }));
        transport.listHistory.mockImplementation(async (_scope, id) => ({ ok: true,
            value: { ok: true, items: id === environment.id ? [latest] : [], nextCursor: null },
        }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const collection = controller.acquireCollection({}, active);
        const otherPage = controller.acquireCollection({ cursor: 'next-page' }, active);
        const history = controller.acquireHistory(environment.id, {}, active);
        const peerHistory = controller.acquireHistory(peer.id, {}, active);
        await Promise.all([collection.refresh(), otherPage.refresh(), history.refresh(), peerHistory.refresh()]);
        const untouched = otherPage.getSnapshot();
        const previousEnvironment = collection.getSnapshot().value!.items[0]!.environment;
        const changed = vi.fn();
        const unrelated = vi.fn();
        collection.subscribe(changed);
        otherPage.subscribe(unrelated);
        peerHistory.subscribe(unrelated);
        transport.listEnvironments.mockClear();
        transport.listHistory.mockClear();
        latest = createDeploymentReceiptHeaderV1({ ...latest, state: 'failed', revision: latest.revision + 1 });
        controller.invalidate({ environmentId: environment.id, deploymentId: latest.id });
        await history.refresh();
        expect(collection.getSnapshot().value?.items[0]?.currentDeployment?.state).toBe('failed');
        expect(collection.getSnapshot().value?.items[0]?.environment).toBe(previousEnvironment);
        expect(transport.listEnvironments.mock.calls.map(call => call[1])).toEqual([{}]);
        expect(transport.listHistory.mock.calls.map(call => call[1])).toEqual([environment.id]);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(otherPage.getSnapshot()).toBe(untouched);
        expect(unrelated).not.toHaveBeenCalled();
        controller.retire();
    });

    it('keeps 100 hidden borrowers quiet while a visible borrower receives the real change', async () => {
        const { environment, environmentDetail, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const selected = controller.acquireEnvironment(environment.id, active);
        const dormant = Array.from({ length: 100 }, (_, i) => controller.acquireEnvironment(environment.id,
            i % 2 === 0 ? hidden : { ...active, focused: false }));
        await selected.refresh();
        const hiddenWakes = vi.fn();
        const visibleWakes = vi.fn();
        dormant.forEach(lease => lease.subscribe(hiddenWakes));
        selected.subscribe(visibleWakes);
        transport.readEnvironment.mockClear();
        await Promise.all(dormant.map(lease => lease.refresh()));
        expect(transport.readEnvironment).not.toHaveBeenCalled();
        transport.readEnvironment.mockResolvedValue({ ok: true, value: { ...environmentDetail,
            environment: { ...environment, revision: environment.revision + 1 },
            content: { ...environmentDetail.content, name: 'Changed' },
        } });
        controller.invalidate({ environmentId: environment.id });
        await selected.refresh();
        expect(selected.getSnapshot().value?.content.name).toBe('Changed');
        expect(visibleWakes).toHaveBeenCalledTimes(1);
        expect(hiddenWakes).not.toHaveBeenCalled();
        expect(transport.readEnvironment).toHaveBeenCalledTimes(1);
        dormant[0]!.setDemand(active);
        await dormant[0]!.refresh();
        expect(dormant[0]!.getSnapshot()).toBe(selected.getSnapshot());
        expect(hiddenWakes).toHaveBeenCalledTimes(1);
        controller.retire();
    });

    it('retains the admitted presentation during a transient read failure and withdraws it on an authoritative denial', async () => {
        const { environment, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireEnvironment(environment.id, active);
        await lease.refresh();
        const admitted = lease.getSnapshot().value;
        expect(admitted?.environment.id).toBe(environment.id);
        transport.readEnvironment.mockResolvedValue({ ok: false, failure: { code: 'home_unreachable', retryable: true } });
        await lease.refresh();
        expect(lease.getSnapshot()).toMatchObject({ status: 'unavailable', failure: { code: 'home_unreachable', retryable: true } });
        expect(lease.getSnapshot().value).toBe(admitted);
        transport.readEnvironment.mockResolvedValue({ ok: false, failure: { code: 'deployment_access_denied', retryable: false } });
        await lease.refresh();
        expect(lease.getSnapshot().value).toBeNull();
        expect(transport.readEnvironment).toHaveBeenCalledTimes(3);
        lease.release(); controller.retire();
    });

    it('keeps 100 settled history rows dormant and batches only demanded unsettled ids per target', async () => {
        const { environment, transport } = networkBoundary();
        const settled = Array.from({ length: 100 }, (_, i) => createDeploymentReceiptHeaderV1({ id: `settled-${i}`, environmentId: environment.id, state: 'succeeded' }));
        transport.listHistory.mockResolvedValue({ ok: true, value: { ok: true, items: settled, nextCursor: null } });
        const running = ['a', 'b'].map(id => createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id, environmentId: environment.id, state: 'running', targetLinkId: 'target' }) }));
        const unknown = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'unknown', environmentId: environment.id, state: 'outcome_unknown' }) });
        const settledDetails = settled.map(deployment => createDeploymentReceiptDetailV1({ deployment }));
        transport.readReceipt.mockImplementation(async (_scope, _environmentId, id) => ({ ok: true,
            value: running.find(row => row.deployment.id === id) ?? settledDetails.find(row => row.deployment.id === id) ?? unknown,
        }));
        transport.observeReceipts.mockResolvedValue({ ok: true, value: structuredClone(running) });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const history = controller.acquireHistory(environment.id, {}, active);
        await history.refresh();
        expect(history.getSnapshot().value?.items).toHaveLength(100);
        const openedSettled = settled.map(row => controller.acquireReceipt(environment.id, row.id, active));
        await Promise.all(openedSettled.map(lease => lease.refresh()));
        expect(transport.observeReceipts).not.toHaveBeenCalled();
        expect(openedSettled.every(lease => lease.getSnapshot().value?.deployment.state === 'succeeded')).toBe(true);
        const dormant = controller.acquireReceipt(environment.id, unknown.deployment.id, active);
        await dormant.refresh();
        expect(transport.observeReceipts).not.toHaveBeenCalled();
        const first = controller.acquireReceipt(environment.id, 'a', active);
        const second = controller.acquireReceipt(environment.id, 'b', active);
        await Promise.all([first.refresh(), second.refresh()]);
        await Promise.resolve();
        expect(transport.observeReceipts).toHaveBeenCalledTimes(1);
        expect(transport.observeReceipts.mock.calls[0]?.[1]).toBe('target');
        expect(transport.observeReceipts.mock.calls[0]?.[2]).toEqual(['a', 'b']);
        first.setDemand(hidden);
        second.release();
        controller.invalidate({ environmentId: environment.id, deploymentId: 'a' });
        await first.refresh();
        expect(transport.observeReceipts).toHaveBeenCalledTimes(1);
        controller.retire();
    });

    it('joins concurrent identical reads and lets a hidden record read land quietly for the next presentation', async () => {
        const { environment, environmentDetail, transport } = networkBoundary();
        let resolveRead!: (value: Awaited<ReturnType<DeploymentReadTransportV1['readEnvironment']>>) => void;
        transport.readEnvironment.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const first = controller.acquireEnvironment(environment.id, active);
        const second = controller.acquireEnvironment(environment.id, active);
        expect(transport.readEnvironment).toHaveBeenCalledTimes(1);
        const signal = transport.readEnvironment.mock.calls[0]![2].signal;
        first.release();
        expect(signal.aborted).toBe(false);
        const published = vi.fn();
        second.subscribe(published);
        second.setDemand(hidden);
        expect(signal.aborted, 'hiding starts no read but does not discard the one in flight').toBe(false);
        published.mockClear();
        resolveRead({ ok: true, value: environmentDetail });
        await vi.waitFor(() => expect(second.getSnapshot().status).toBe('ready'));
        expect(published, 'a hidden borrower does no presentation work').not.toHaveBeenCalled();
        second.setDemand(active);
        expect(second.getSnapshot().value?.environment.id).toBe(environment.id);
        controller.retire();
    });

    it('retires the old authority and cannot disclose a late response or restart work', async () => {
        const { environment, environmentDetail, transport } = networkBoundary();
        let resolveRead!: (value: Awaited<ReturnType<DeploymentReadTransportV1['readEnvironment']>>) => void;
        transport.readEnvironment.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireEnvironment(environment.id, active);
        const signal = transport.readEnvironment.mock.calls[0]![2].signal;
        controller.retire();
        expect(signal.aborted).toBe(true);
        resolveRead({ ok: true, value: environmentDetail });
        await Promise.resolve();
        await lease.refresh();
        expect(lease.getSnapshot().value).toBeNull();
        expect(lease.getSnapshot().failure?.code).toBe('authority_changed');
        expect(transport.readEnvironment).toHaveBeenCalledTimes(1);
    });

    it('settles non-retryable failures, rejects foreign rows and starts no retry timer', async () => {
        const { environment, transport } = networkBoundary();
        transport.readEnvironment.mockResolvedValue({ ok: false, failure: { code: 'source_access_denied', retryable: false } });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireEnvironment(environment.id, active);
        await lease.refresh();
        expect(lease.getSnapshot().failure).toEqual({ code: 'source_access_denied', retryable: false });
        const peer = controller.acquireEnvironment(environment.id, active);
        await Promise.resolve();
        expect(transport.readEnvironment).toHaveBeenCalledTimes(1);
        expect(peer.getSnapshot()).toBe(lease.getSnapshot());
        transport.readEnvironment.mockResolvedValue({ ok: true, value: createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'foreign', projectSourceId: 'other-source' }) }) });
        await lease.refresh();
        expect(lease.getSnapshot().value).toBeNull();
        expect(lease.getSnapshot().failure?.code).toBe('invalid_response');
        controller.retire();
    });

    it('replaces one changed Machine result and retains keyed peers across reordering without mutating a receipt', async () => {
        const { environment, receipt, receiptDetail, transport } = networkBoundary();
        const first = receiptDetail.content.machineResults[0]!;
        const second = { ...first, machineId: 'machine-b', installationId: 'installation-b' };
        const baseline = createDeploymentReceiptDetailV1({ deployment: receipt,
            content: { ...receiptDetail.content, machines: [first.machineId, second.machineId], machineResults: [first, second] } });
        const original = structuredClone(baseline);
        transport.readReceipt.mockResolvedValue({ ok: true, value: baseline });
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const lease = controller.acquireReceipt(environment.id, receipt.id, active);
        await lease.refresh();
        const previous = lease.getSnapshot().value!;
        const changed = createDeploymentReceiptDetailV1({ deployment: { ...receipt, revision: receipt.revision + 1 },
            content: { ...receiptDetail.content, machines: [first.machineId, second.machineId],
                machineResults: [structuredClone(second), { ...first, health: 'unhealthy' }] } });
        transport.readReceipt.mockResolvedValue({ ok: true, value: changed });
        await lease.refresh();
        const next = lease.getSnapshot().value!;
        expect(next.content.machineResults[0]).toBe(previous.content.machineResults[1]);
        expect(next.content.machineResults[1]).not.toBe(previous.content.machineResults[0]);
        expect(next.content.machineResults[1]?.steps).toBe(previous.content.machineResults[0]?.steps);
        expect(baseline).toEqual(original);
        transport.readReceipt.mockResolvedValue({ ok: true, value: baseline });
        await lease.refresh();
        expect(lease.getSnapshot().value).toBe(next);
        controller.retire();
    });

    it('isolates a failed target batch and aborts an observation when its demand closes', async () => {
        const { environment, transport } = networkBoundary();
        const a = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'a', environmentId: environment.id, targetLinkId: 'target-a', state: 'running' }) });
        const b = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'b', environmentId: environment.id, targetLinkId: 'target-b', state: 'running' }) });
        transport.readReceipt.mockImplementation(async (_scope, _environment, id) => ({ ok: true, value: id === 'a' ? a : b }));
        let resolveObservation!: (value: Awaited<ReturnType<NonNullable<DeploymentReadTransportV1['observeReceipts']>>>) => void;
        transport.observeReceipts.mockImplementation(async (_scope, target) => target === 'target-a'
            ? { ok: false, failure: { code: 'plugin_unavailable', retryable: false } }
            : new Promise(resolve => { resolveObservation = resolve; }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const first = controller.acquireReceipt(environment.id, a.deployment.id, active);
        const second = controller.acquireReceipt(environment.id, b.deployment.id, active);
        await Promise.all([first.refresh(), second.refresh()]);
        await Promise.resolve();
        await Promise.resolve();
        expect(first.getSnapshot().failure?.code).toBe('plugin_unavailable');
        expect(second.getSnapshot().failure).toBeNull();
        const observation = transport.observeReceipts.mock.calls.find(call => call[1] === 'target-b')!;
        second.setDemand(hidden);
        expect(observation[3].signal.aborted).toBe(true);
        const previous = second.getSnapshot();
        resolveObservation({ ok: true, value: [createDeploymentReceiptDetailV1({ ...b, deployment: { ...b.deployment, state: 'succeeded', revision: b.deployment.revision + 1 } })] });
        await Promise.resolve();
        await Promise.resolve();
        expect(second.getSnapshot()).toBe(previous);
        controller.retire();
    });

    it.each(['reconnect', 'explicit'] as const)('supersedes a stalled read on %s recovery without awaiting or disclosing its late response', async mode => {
        const { environment, environmentDetail, transport } = networkBoundary();
        let resolveStalled!: (value: Awaited<ReturnType<DeploymentReadTransportV1['readEnvironment']>>) => void;
        transport.readEnvironment.mockImplementationOnce(() => new Promise(resolve => { resolveStalled = resolve; }));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const selected = controller.acquireEnvironment(environment.id, active);
        const stalledSignal = transport.readEnvironment.mock.calls[0]![2].signal;
        const published = vi.fn();
        selected.subscribe(published);
        const repaired = { ...environmentDetail, environment: { ...environment, revision: environment.revision + 1 },
            content: { ...environmentDetail.content, name: 'Reconnected' } };
        transport.readEnvironment.mockResolvedValue({ ok: true, value: repaired });
        const repair = mode === 'reconnect' ? controller.refreshDemanded() : selected.refresh({ supersede: true });
        // Recovery must start now, even when the retired transport ignores cancellation. An explicit retry replaces the
        // read at once; a reconnect wake lets it race, and abandons it as soon as the newer read answers.
        expect(stalledSignal.aborted).toBe(mode === 'explicit');
        expect(transport.readEnvironment).toHaveBeenCalledTimes(2);
        expect(published).not.toHaveBeenCalled();
        await repair;
        expect(stalledSignal.aborted).toBe(true);
        const current = selected.getSnapshot();
        expect(current.value?.content.name).toBe('Reconnected');
        expect(published).toHaveBeenCalledTimes(1);
        resolveStalled({ ok: true, value: { ...environmentDetail,
            environment: { ...environment, revision: environment.revision + 2 },
            content: { ...environmentDetail.content, name: 'Retired connection' },
        } });
        await Promise.resolve();
        await Promise.resolve();
        expect(selected.getSnapshot()).toBe(current);
        expect(published).toHaveBeenCalledTimes(1);
        controller.retire();
    });

    it('repairs only active demand on reconnect and leaves closed and released resources quiet', async () => {
        const { environment, transport } = networkBoundary();
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const catalog = controller.acquireCollection({}, active);
        const detail = controller.acquireEnvironment(environment.id, active);
        const history = controller.acquireHistory(environment.id, {}, hidden);
        await Promise.all([catalog.refresh(), detail.refresh()]);
        detail.release();
        transport.listEnvironments.mockClear();
        transport.readEnvironment.mockClear();
        await controller.refreshDemanded();
        expect(transport.listEnvironments).toHaveBeenCalledTimes(1);
        expect(transport.readEnvironment).not.toHaveBeenCalled();
        expect(transport.listHistory).not.toHaveBeenCalled();
        history.release();
        controller.retire();
    });

    it('has zero timer fires after a non-retryable failure or an unknown receipt settles its read', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
        try {
            const { environment, receipt, receiptDetail, transport } = networkBoundary();
            transport.readEnvironment.mockResolvedValue({ ok: false, failure: { code: 'deployment_access_denied', retryable: false } });
            transport.readReceipt.mockResolvedValue({ ok: true, value: { ...receiptDetail, deployment: { ...receipt, state: 'outcome_unknown' } } });
            const controller = createDeploymentReadControllerV1({ scope, transport });
            const denied = controller.acquireEnvironment(environment.id, active);
            const unknown = controller.acquireReceipt(environment.id, receipt.id, active);
            await Promise.all([denied.refresh(), unknown.refresh()]);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(transport.readEnvironment).toHaveBeenCalledTimes(1);
            expect(transport.readReceipt).toHaveBeenCalledTimes(1);
            expect(transport.observeReceipts).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            controller.retire();
        } finally { vi.useRealTimers(); }
    });
});
