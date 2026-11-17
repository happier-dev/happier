import { describe, expect, it, vi } from 'vitest';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { createDeploymentReceiptEventSourceAdapter, deploymentEventActions } from '../../../../packages/plugins/machine-services/src/deploymentEvents';
import { projectDeploymentReceiptInvalidationsForHost } from './receiptEventInvalidation';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { plugin as cloudflare } from '../../../../packages/plugins/deploy-cloudflare/src/manifest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

const materialization = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
const setupInput = { v: 1 as const, serverId: 'home', environmentId: 'env' };
const config = { ...setupInput, observingSince: 2 };
const definition = (event: string): PluginCheckpointedEventSourceDefinitionV1 => ({
    automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'deployment-trigger', triggerRevision: 1,
    sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: materialization.pluginId, localId: event },
    sourceInstanceId: `deployment:${event}`, sourceContractVersion: 1, sourceConfig: config,
    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null,
});
function fixture(event: string | readonly string[] = 'deployment-failed', pageSize?: number) {
    let currentDefinitions = typeof event === 'string' ? [definition(event)] : event.map(definition);
    const failed = createDeploymentReceiptHeaderV1({ id: 'failed', environmentId: 'env', state: 'failed',
        requestedAtMs: 1, startedAtMs: 2, settledAtMs: 3 });
    const rollback = createDeploymentReceiptHeaderV1({ ...failed, id: 'rollback', operation: 'rollback', state: 'succeeded' });
    const rows = [failed, rollback, { ...failed, id: 'running', state: 'running' as const, settledAtMs: undefined }];
    let safe = true;
    let domainRevision = 1;
    let domainCount = 1;
    let domainsAvailable = true;
    const reads: string[] = [];
    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
    const listeners = new Map<string, Set<(event: { payload: JsonValue }) => void | Promise<void>>>();
    const execute = vi.fn(async (id: string, input: Record<string, unknown>) => {
        if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', definitions: currentDefinitions, nextCursor: null };
        if (id === 'automation.event.source.status.report') return { kind: 'reported' };
        if (id === 'automation.event.admit') {
            const request = AutomationEventAdmitInputV1Schema.parse(input); admissions.push(request);
            return { results: safe ? request.definitions.map(() => ({ kind: 'admitted', checkpointSafe: true, runId: 'run' })) : [] };
        }
        if (id === 'deployments.receipts.list') {
            const selected = rows.filter(row => (!input.state || row.state === input.state)
                && (!input.operation || row.operation === input.operation)
                && (!input.inProgressOnly || row.state === 'running'));
            const offset = input.cursor ? Number(input.cursor) : 0;
            const items = pageSize === undefined ? input.cursor ? selected.slice(1) : selected.slice(0, 1)
                : selected.slice(offset, offset + pageSize);
            reads.push(...items.map(row => row.id));
            return { ok: true, items, nextCursor: pageSize === undefined
                ? input.cursor || selected.length < 2 ? null : '1'
                : offset + pageSize < selected.length ? String(offset + pageSize) : null };
        }
        if (id === 'deployments.receipts.get') {
            const deployment = rows.find(row => row.id === input.deploymentId);
            return deployment ? { ok: true, deployment,
                failureSummary: deployment.state === 'failed' ? { code: 'build_failed', phase: 'build' } : null }
                : { ok: false, error: 'deployment_unavailable' };
        }
        if (id === 'deployments.domains.list') {
            if (!domainsAvailable) return { ok: false, error: 'deployment_unavailable' };
            const offset = input.cursor ? Number(input.cursor) : 0;
            const domains = Array.from({ length: domainCount }, (_, index) => ({
                id: `domain-${index}`, environmentId: 'env', revision: domainRevision,
            }));
            return { ok: true, domains: domains.slice(offset, offset + 1),
                nextCursor: offset + 1 < domains.length ? String(offset + 1) : null };
        }
        if (id === 'deployments.environments.get') return { ok: true, environment: { id: input.environmentId, revision: 1, projectSourceId: 'source',
            ...(input.environmentId === 'env' ? { previewTemplateEnvironmentId: 'template' } : {}) } };
        if (id === 'deployments.environments.list') return { ok: true, items: [{ id: 'env', revision: 1 }], nextCursor: null };
        throw new Error(`Unexpected Action ${id}`);
    });
    // Host Actions and authenticated Event delivery are genuine plugin boundaries.
    // The receipt source, SDK runner and admission normalization remain real.
    const context = { plugin: { id: materialization.pluginId, version: '0.0.0' },
        contribution: { id: 'deployment-receipt-observer', qualifiedId: `${materialization.pluginId}/backgroundServices/deployment-receipt-observer` },
        surface: 'background', invokedAtMs: 10, materialization, signal: new AbortController().signal,
        services: { actions: { execute }, events: { host: { subscribe: (target: { eventId: string },
            listener: (event: { payload: JsonValue }) => void | Promise<void>) => {
            const set = listeners.get(target.eventId) ?? new Set(); listeners.set(target.eventId, set); set.add(listener);
            return { dispose() { set.delete(listener); } };
        } } } },
    } as unknown as BackgroundServiceContext;
    const adapter = createDeploymentReceiptEventSourceAdapter(context.services.events.host, () => 10);
    let wakeSubscription = adapter.subscribeWake?.(async () => {});
    const cycle = async (source = adapter) => {
        // The real runner owns its subscription during a finite cycle. Keep one
        // connected host delivery boundary between cycles, without overlapping it.
        wakeSubscription?.dispose();
        try { await runCheckpointedPluginEventObserverV1({ context, source, mode: 'once', now: () => 10 }); }
        finally { wakeSubscription = source.subscribeWake?.(async () => {}); }
    };
    return { context, adapter, execute, admissions, rows, reads, cycle, safe(value: boolean) { safe = value; },
        subscriptions(eventId: string) { return listeners.get(eventId)?.size ?? 0; },
        sources(definitions: PluginCheckpointedEventSourceDefinitionV1[]) { currentDefinitions = definitions; },
        configure(sourceConfig: typeof config & { previewChildren?: true }) { currentDefinitions = currentDefinitions.map(current => ({ ...current, sourceConfig })); },
        async wake(environmentId = 'env', deploymentId = 'failed') {
            for (const listener of listeners.get('@happier/deployment/receipt-invalidated') ?? []) await listener({ payload: { serverId: 'home', environmentId, deploymentId } });
        },
        domainsAvailable(value: boolean) { domainsAvailable = value; },
        domains(count: number) { domainCount = count; },
        async environmentChanged(changed = true) {
            if (changed) domainRevision += 1;
            const change = buildDeploymentAccountChangeV1({ environmentId: 'env', projectSourceId: 'source', revision: 1 });
            for (const listener of listeners.get('@happier/account/entities-invalidated') ?? []) await listener({ payload: { entityIds: [change.entityId] } });
        },
        async reconnect() {
            for (const listener of listeners.get('@happier/automation/event-sources-invalidated') ?? []) await listener({ payload: { reason: 'reconnect', definitionsChanged: false } });
        } };
}
describe('deployment receipt Events through canonical admission', () => {
    it('pushes pending, ready, failure and retained cleanup receipts for one preview template without polling', async () => {
        const f = fixture('deployment-receipt-changed', 10);
        f.configure({ ...config, observingSince: 20, environmentId: 'template', previewChildren: true });
        f.rows.splice(0, f.rows.length, createDeploymentReceiptHeaderV1({ ...f.rows[0], id: 'preview',
            state: 'running', settledAtMs: undefined }));
        await f.cycle();
        expect(f.admissions.at(-1)).toMatchObject({ eventRef: { localId: 'deployment-receipt-changed' },
            payload: { environmentId: 'env', deploymentId: 'preview', state: 'running' } });
        for (const [state, operation, revision] of [['succeeded', 'deploy', 2], ['failed', 'deploy', 3], ['succeeded', 'teardown', 4]] as const) {
            f.rows[0] = createDeploymentReceiptHeaderV1({ ...f.rows[0], state, operation, revision, settledAtMs: revision + 2 });
            await f.wake('env', 'preview'); await f.cycle();
            expect(f.admissions.at(-1)).toMatchObject({ payload: { environmentId: 'env', deploymentId: 'preview', state, operation,
                receiptRevision: revision } });
        }
        expect(f.admissions).toHaveLength(4);
        await f.wake('unrelated', 'preview'); await f.cycle();
        expect(f.admissions).toHaveLength(4);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(0);
        expect(f.execute.mock.calls.find(([id]) => id === 'deployments.environments.list')?.[1]).toMatchObject({
            previewTemplateEnvironmentId: 'template', projectSourceId: 'source', includeDeleted: true });
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list').map(([, input]) => input))
            .toEqual([{ serverId: 'home', environmentId: 'env', limit: 1 }]);
    });
    it('reprojects the current receipt after a later serving Environment change without polling', async () => {
        const f = fixture('deployment-receipt-changed', 10);
        f.configure({ ...config, environmentId: 'template', previewChildren: true });
        f.domains(2);
        f.rows.splice(0, f.rows.length, createDeploymentReceiptHeaderV1({ ...f.rows[0], id: 'preview', state: 'succeeded' }));
        expect(f.subscriptions('@happier/account/entities-invalidated')).toBe(0);
        await f.cycle();
        expect(f.subscriptions('@happier/account/entities-invalidated')).toBe(1);
        expect(f.admissions).toHaveLength(1);
        await f.environmentChanged(); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]).toMatchObject({ payload: { deploymentId: 'preview', receiptRevision: 1, state: 'succeeded' } });
        expect(f.admissions[1]!.occurrenceId).not.toBe(f.admissions[0]!.occurrenceId);
        await f.environmentChanged(false); await f.cycle();
        expect(f.admissions[2]!.occurrenceId).toBe(f.admissions[1]!.occurrenceId);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.domains.list')).toHaveLength(6);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.domains.get')).toHaveLength(0);
        f.execute.mockClear(); await f.cycle();
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.domains.list' || id === 'deployments.receipts.list')).toHaveLength(0);
        f.domainsAvailable(false); await f.environmentChanged(); await f.cycle();
        expect(f.admissions).toHaveLength(3);
        f.domainsAvailable(true); f.domains(0); await f.environmentChanged(); await f.cycle();
        expect(f.admissions).toHaveLength(4);
        expect(f.admissions[3]!.occurrenceId).not.toBe(f.admissions[2]!.occurrenceId);
        expect(f.admissions[3]!.payload).not.toHaveProperty('targetUrl');
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(0);
        f.sources([]); await f.cycle();
        expect(f.subscriptions('@happier/account/entities-invalidated')).toBe(0);
    });
    it('keeps receipt reads separate across Homes and excludes sources assigned to another observer', async () => {
        const f = fixture('deployment-succeeded', 5);
        f.rows.splice(0, f.rows.length, createDeploymentReceiptHeaderV1({ ...f.rows[0], state: 'succeeded', requestedAtMs: 0, startedAtMs: 0, settledAtMs: 1 }));
        f.sources([
            definition('deployment-succeeded'),
            { ...definition('rollback-completed'), sourceConfig: { ...config, serverId: 'other-home' } },
            { ...definition('promotion-completed'), observationTransport: { kind: 'checkpointedPull',
                watcherMaterializationRef: { ...materialization, machineId: 'other-machine' } } },
        ]);
        await f.cycle();
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list').map(([, input]) => input.serverId))
            .toEqual(['home', 'other-home']);
        f.execute.mockClear();
        await f.wake('env', f.rows[0].id); await f.cycle();
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get').map(([, input]) => input.serverId))
            .toEqual(['home']);
        expect(f.admissions).toEqual([]);
    });
    it('reads receipt facts once for six outcomes and preserves independent occurrences and reconnect catch-up', async () => {
        const events = ['deployment-failed', 'rollback-completed', 'deployment-succeeded', 'promotion-completed',
            'deployment-cancelled', 'deployment-outcome-unknown'];
        const f = fixture(events, 5);
        const current = f.rows[0];
        f.rows.splice(0, f.rows.length, ...Array.from({ length: 15 }, (_, index) =>
            createDeploymentReceiptHeaderV1({ ...current, id: `historical-${index}`, state: 'succeeded', requestedAtMs: 0, startedAtMs: 0, settledAtMs: 1 })));
        const readCounts = () => ({
            list: f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list').length,
            get: f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get').length,
        });
        await f.cycle();
        expect(readCounts()).toEqual({ list: 3, get: 0 });
        expect(f.admissions).toEqual([]);
        f.execute.mockClear();
        await f.cycle(); await f.wake('unrelated-environment'); await f.cycle();
        expect(readCounts()).toEqual({ list: 0, get: 0 });
        f.rows[0] = createDeploymentReceiptHeaderV1({ ...f.rows[0], operation: 'rollback', settledAtMs: 3, revision: 2 });
        await f.wake('env', f.rows[0].id); await f.cycle();
        expect(readCounts()).toEqual({ list: 0, get: 1 });
        expect(f.admissions.map(row => row.eventRef.localId).sort()).toEqual(['deployment-succeeded', 'rollback-completed']);
        expect(new Set(f.admissions.map(row => row.occurrenceId)).size).toBe(2);
        const occurrences = f.admissions.map(row => row.occurrenceId);
        f.execute.mockClear();
        await f.reconnect(); await f.cycle();
        expect(readCounts()).toEqual({ list: 3, get: 0 });
        expect(f.admissions.slice(2).map(row => row.occurrenceId)).toEqual(occurrences);
    });
    it('keeps a newer invalidation pending while sibling occurrence checkpoints await admission', async () => {
        const f = fixture(['rollback-completed', 'deployment-succeeded']);
        f.rows.splice(0, f.rows.length, createDeploymentReceiptHeaderV1({ ...f.rows[0], state: 'succeeded', operation: 'rollback' }));
        f.safe(false);
        await f.cycle();
        const occurrences = f.admissions.map(row => row.occurrenceId);
        expect(occurrences).toHaveLength(2);
        f.rows[0] = createDeploymentReceiptHeaderV1({ ...f.rows[0], operation: 'promote', revision: 2, settledAtMs: 4 });
        await f.wake('env', f.rows[0].id);
        f.execute.mockClear(); f.safe(true);
        await f.cycle();
        expect(f.admissions.slice(2).map(row => row.occurrenceId)).toEqual(occurrences);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get')).toHaveLength(0);
        await f.cycle();
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get')).toHaveLength(1);
        expect(f.admissions.at(-1)).toMatchObject({ eventRef: { localId: 'deployment-succeeded' },
            payload: { state: 'succeeded', receiptRevision: 2, observedAt: 4 } });
    });
    it.each(['failed', 'succeeded'] as const)('produces exactly one generic %s Event for a Cloudflare receipt', async state => {
        const localId = state === 'failed' ? 'deployment-failed' : 'deployment-succeeded';
        const f = fixture(localId);
        f.rows.splice(0, f.rows.length, createDeploymentReceiptHeaderV1({ ...f.rows[0], state }));
        await f.cycle();
        const controller = new AbortController();
        const execute = f.context.services.actions.execute;
        const principal = { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: cloudflare.manifest.id, localId: 'workers-deploy' }, purpose: 'deploy.manage' },
            target: { kind: 'account', account: { service: { pluginId: cloudflare.manifest.id, localId: 'cloudflare' }, accountId: 'provider' } } };
        // Host Actions, retained Account storage and authenticated event ingress are plugin boundaries.
        const context = { ...f.context, plugin: { id: cloudflare.manifest.id, version: '0.0.0' }, signal: controller.signal,
            materialization: { ...materialization, pluginId: cloudflare.manifest.id },
            services: { ...f.context.services, storage: { account: { kv: { get: async () => null, set: async () => ({}) } } },
                actions: { execute: async (id: string, input: Record<string, unknown>) => {
                    if (id === 'automation.event.sources.list') return { kind: 'page', revision: '1', nextCursor: null,
                        definitions: (cloudflare.manifest.contributes?.events ?? []).filter(event => event.automation?.eligible).map(event => ({
                            ...definition(event.id), eventRef: { pluginId: cloudflare.manifest.id, localId: event.id },
                            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { ...materialization, pluginId: cloudflare.manifest.id } },
                            sourceConfig: { ...config, targetLinkId: f.rows[0].targetLinkId, credentialPrincipal: principal },
                        })) };
                    if (id === 'deployments.observation.get') return { ok: true, environment: { protection: 'production' },
                        receipt: { providerDeploymentId: 'worker-build' } };
                    if (id === 'deployments.receipts.list') return { ok: true,
                        items: input.inProgressOnly ? [] : f.rows, nextCursor: null };
                    return execute(id as Parameters<typeof execute>[0], input as never);
                } } } } as unknown as BackgroundServiceContext;
        const kit = await createPluginTestkit({ manifest: cloudflare.manifest, module: cloudflare });
        const running = kit.registrations().filter(registration => registration.family === 'backgroundServices')
            .map(registration => kit.registration('backgroundServices', registration.localId)!(context));
        await new Promise<void>(resolve => setImmediate(resolve));
        controller.abort();
        await Promise.all(running);
        await kit.dispose();
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions.filter(event => event.eventRef.pluginId === cloudflare.manifest.id)).toHaveLength(0);
        expect(f.admissions[0]).toMatchObject({ eventRef: { pluginId: materialization.pluginId, localId }, payload: { state } });
    });
    it.each([
        ['deployment-succeeded', 'deploy', 'succeeded'],
        ['promotion-completed', 'promote', 'succeeded'],
        ['deployment-cancelled', 'deploy', 'cancelled'],
        ['deployment-outcome-unknown', 'deploy', 'outcome_unknown'],
    ] as const)('admits %s only for its settled receipt and replays the same occurrence', async (event, operation, state) => {
        const f = fixture(event);
        f.rows.splice(1, 1);
        f.rows[0] = createDeploymentReceiptHeaderV1({ ...f.rows[0], operation, state });
        await f.cycle();
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0].payload).toEqual({ environmentId: 'env', deploymentId: 'failed',
            targetLinkId: f.rows[0].targetLinkId, receiptRevision: f.rows[0].revision,
            observedAt: 3, operation, state });
        expect(f.execute.mock.calls.filter(([id]) => id === 'artifact.get')).toHaveLength(0);
        await f.cycle(); expect(f.admissions).toHaveLength(1);
        await f.wake(); await f.cycle();
        expect(f.admissions[1].occurrenceId).toBe(f.admissions[0].occurrenceId);
        await f.cycle(createDeploymentReceiptEventSourceAdapter(f.context.services.events.host, () => 20));
        expect(f.admissions[2].occurrenceId).toBe(f.admissions[0].occurrenceId);
    });
    it('pages retained receipts, opens only failures and projects their phase without private content', async () => {
        const f = fixture(); await f.cycle();
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0].payload).toEqual({ environmentId: 'env', deploymentId: 'failed',
            targetLinkId: f.rows[0].targetLinkId, receiptRevision: f.rows[0].revision,
            observedAt: 3, operation: 'deploy', state: 'failed', phase: 'build', failureCode: 'build_failed' });
        expect(f.execute.mock.calls.filter(([id]) => id === 'artifact.get')).toHaveLength(0);
        await f.cycle(); expect(f.admissions).toHaveLength(1);
        await f.wake('other'); await f.cycle(); expect(f.admissions).toHaveLength(1);
        await f.wake(); await f.cycle();
        expect(f.admissions[1].occurrenceId).toBe(f.admissions[0].occurrenceId);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list')).toHaveLength(2);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get')).toHaveLength(2);
        await f.cycle(createDeploymentReceiptEventSourceAdapter(f.context.services.events.host, () => 20));
        expect(f.admissions[2].occurrenceId).toBe(f.admissions[0].occurrenceId);
    });
    it('holds the exact occurrence until admission settles and then lets the source go idle', async () => {
        const f = fixture(); f.safe(false); await f.cycle();
        f.safe(true); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1].occurrenceId).toBe(f.admissions[0].occurrenceId);
        expect(f.admissions[1].observationReceivedAt).toBe(f.admissions[0].observationReceivedAt);
        expect(f.execute.mock.calls.filter(([id]) => id === 'artifact.get')).toHaveLength(0);
        expect(f.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.get')).toHaveLength(1);
        await f.cycle(); expect(f.admissions).toHaveLength(2);
    });
    it('admits completed rollback only after successful settlement without opening private content', async () => {
        const f = fixture('rollback-completed'); await f.cycle();
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0].payload).toMatchObject({ deploymentId: 'rollback', operation: 'rollback', state: 'succeeded' });
        expect(f.execute.mock.calls.filter(([id]) => id === 'artifact.get')).toHaveLength(0);
    });
    it('uses the existing Environment reader to configure the exact Event source', async () => {
        const f = fixture();
        const result = await deploymentEventActions['deployment-failed/setup'].run(setupInput, f.context);
        expect(result.sourceConfig).toEqual({ ...setupInput, observingSince: 10 });
        expect(result.sourceInstanceId).toMatch(/^deployment:/);
        expect(f.execute.mock.calls).toEqual([['deployments.environments.get', { serverId: 'home', environmentId: 'env' },
            { signal: f.context.signal }]]);
    });
    it('excludes pre-enrollment settlements and preserves settlements after setup before adoption', async () => {
        const f = fixture();
        f.rows[0].settledAtMs = 1;
        await f.cycle();
        expect(f.admissions).toHaveLength(0);
        f.rows[0].settledAtMs = 3;
        await f.cycle(createDeploymentReceiptEventSourceAdapter(f.context.services.events.host, () => 20));
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0].occurredAt).toBe(3);
    });
    it('reconciles the receipt again after a receipt reader boundary failure', async () => {
        const f = fixture();
        const execute = f.context.services.actions.execute;
        let unavailable = true;
        f.context.services.actions.execute = (async (...args: Parameters<typeof execute>) => {
            if (args[0] === 'deployments.receipts.get' && unavailable) { unavailable = false; throw new Error('boundary unavailable'); }
            return execute(...args);
        }) as typeof execute;
        await f.cycle();
        expect(f.admissions).toHaveLength(0);
        await f.cycle();
        expect(f.admissions).toHaveLength(1);
    });
    it('replaces an adopted source when its configured boundary changes under the same source id', async () => {
        const f = fixture(); await f.cycle();
        f.configure({ ...config, observingSince: 4 });
        f.rows[0].settledAtMs = 5;
        await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1].occurredAt).toBe(5);
    });
    it('projects only committed receipt identities from the existing account-change push', async () => {
        const body = UpdateBodySchema.parse({ t: 'account-change', entityIds: [
            'deployment-receipt:env:failed', 'deployment-environment:env', 'unrelated',
        ] });
        if (body.t !== 'account-change') throw new Error('Expected Account change fixture');
        const resolveHome = vi.fn(async () => 'home');
        expect(await projectDeploymentReceiptInvalidationsForHost(body, resolveHome)).toEqual([{ eventId: '@happier/deployment/receipt-invalidated', scope: { kind: 'account' },
            payload: { serverId: 'home', environmentId: 'env', deploymentId: 'failed' } }]);
        expect(resolveHome).toHaveBeenCalledTimes(1);
    });
    it('does not acquire Home identity for unrelated Account invalidations', async () => {
        const resolveHome = vi.fn(async () => 'home');
        expect(await projectDeploymentReceiptInvalidationsForHost({ t: 'account-change', entityIds: ['unrelated', 'deployment-environment:env'] }, resolveHome)).toEqual([]);
        expect(resolveHome).not.toHaveBeenCalled();
    });
});
