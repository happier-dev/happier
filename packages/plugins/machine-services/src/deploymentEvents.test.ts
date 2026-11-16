import { expect, it, vi } from 'vitest';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { createDeploymentReceiptEventSourceAdapter, deploymentEventActions } from './deploymentEvents.js';

import { PLUGIN_MANIFEST as vercel } from '../../deploy-vercel/src/manifest.js';
import { PLUGIN_MANIFEST as cloudflare } from '../../deploy-cloudflare/src/manifest.js';

const pluginId = 'happier.machine.services';
const config = { v: 1, serverId: 'home', environmentId: 'environment-a', targetLinkId: 'target-a', observingSince: 1000,
    credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId: 'happier.platform.test', localId: 'deploy' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.platform.test', localId: 'account' }, accountId: 'provider' } } } } as const;
// Redacted COR4-164/receipts-1.json (#164): deploy/running revision 2 while
// continuation-provider-deployments.json is READY. Identifiers and times are fixture-local.
const receipt = { v: 1, id: 'receipt-a', environmentId: config.environmentId, targetLinkId: config.targetLinkId,
    revision: 2, operation: 'deploy', state: 'running', requestKey: 'request-a', requestedByAccountId: 'owner',
    actionOperationId: 'operation-a', contentArtifactId: 'artifact-a', contentHeaderVersion: 1, contentBodyVersion: 1,
    requestedAtMs: 1000, startedAtMs: 1001 } as const;

function fixture(periodMs?: number, eventId = 'deployment-failed') {
    let current: Omit<typeof receipt, 'state' | 'revision' | 'operation' | 'targetLinkId'> & {
        state: 'running' | 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown'; revision: number; settledAtMs?: number;
        operation: 'deploy' | 'rollback' | 'promote' | 'teardown'; targetLinkId: string } = { ...receipt };
    const environment = { id: config.environmentId, runtimeTargetLinkId: config.targetLinkId as string };
    const targetLink = { id: config.targetLinkId, role: 'runtime',
        source: { kind: 'plugin', contribution: { pluginId: 'happier.platform.test', localId: 'runtime' } } };
    let failNextObserve = false;
    let pendingNextObserve = false;
    let settleNextObserve: 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown' | null = null;
    let safe = true;
    const admissions: unknown[] = [];
    const reads: string[] = [];
    const listeners = new Map<string, Set<(event: { payload: Record<string, unknown> }) => void | Promise<void>>>();
    const materialization = { pluginId, machineId: 'machine-a', materializationId: 'installed' };
    const definition: PluginCheckpointedEventSourceDefinitionV1 = { automationId: '11111111-1111-4111-8111-111111111111',
        triggerId: 'watch', triggerRevision: 1, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        eventRef: { pluginId, localId: eventId }, sourceInstanceId: 'deployment:source', sourceContractVersion: 1,
        sourceConfig: { ...config, ...(periodMs === undefined ? {} : { periodMs }) },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
        filter: null, maximumObservationAgeMs: null };
    const execute = vi.fn(async (id: string, input: Record<string, unknown>) => {
        if (id === 'automation.event.sources.list') return input.knownRevision === '1'
            ? { kind: 'unchanged', revision: '1' } : { kind: 'page', revision: '1', definitions: [definition], nextCursor: null };
        if (id === 'automation.event.source.status.report') return { kind: 'reported' };
        if (id === 'automation.event.admit') { admissions.push(input); return { results: safe ? [{ kind: 'skipped', reason: 'occurrenceRejected', checkpointSafe: true }] : [] }; }
        if (id === 'deployments.observation.get') return { ok: true, environment, targetLink, credentialPrincipal: config.credentialPrincipal };
        if (id === 'deployments.environments.get') return { ok: true, environment, targetLinks: [targetLink] };
        if (id === 'deployments.receipts.list') {
            const items = input.inProgressOnly ? current.state === 'running' ? [current] : []
                : [current, ...Array.from({ length: 2000 }, (_, index) => ({ ...receipt, id: `historical-${index}`,
                    state: 'succeeded', requestedAtMs: 1, settledAtMs: 2 }))];
            reads.push(...items.map(row => row.id));
            return { ok: true, items, nextCursor: null };
        }
        if (id === 'deployments.receipts.get') {
            reads.push(String(input.deploymentId));
            return input.deploymentId === current.id ? { ok: true, deployment: current,
                ...(current.state === 'failed' ? { failureSummary: { phase: 'build', code: 'build_failed' } } : {}) }
                : { ok: false, error: 'deployment_unavailable' };
        }
        if (id === 'deployments.receipts.observe') {
            if (failNextObserve) { failNextObserve = false; throw new Error('Provider unavailable'); }
            if (pendingNextObserve) { pendingNextObserve = false; return { ok: true, kind: 'pending', actionOperationId: 'observe-a', environmentId: config.environmentId, revision: 2 }; }
            if (settleNextObserve) { settle(settleNextObserve); settleNextObserve = null; }
            return { ok: true, environmentId: config.environmentId, deploymentId: current.id, revision: 2, deploymentRevision: current.revision, state: current.state };
        }
        throw new Error(`Unexpected Action ${id}`);
    });
    const controller = new AbortController();
    // Actions and authenticated host wake delivery are the process boundaries.
    const context = { plugin: { id: pluginId, version: '0.0.0' }, materialization, signal: controller.signal,
        contribution: { id: 'deployment-receipt-observer', qualifiedId: `${pluginId}/backgroundServices/deployment-receipt-observer` },
        surface: 'background', invokedAtMs: 1000, services: { actions: { execute }, events: { host: {
            subscribe(target: { eventId: string }, listener: (event: { payload: Record<string, unknown> }) => void | Promise<void>) {
                const selected = listeners.get(target.eventId) ?? new Set(); selected.add(listener); listeners.set(target.eventId, selected);
                return { dispose() { selected.delete(listener); } };
            },
        } } } } as unknown as BackgroundServiceContext;
    function settle(state: 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown' = 'failed') { current = { ...current, state, revision: 2, settledAtMs: 1100 }; }
    async function emit(eventId: string, payload: Record<string, unknown>) {
        await Promise.all([...listeners.get(eventId) ?? []].map(listener => listener({ payload })));
    }
    return { context, controller, execute, admissions, reads, settle, environment,
        setReceipt(overrides: Partial<typeof current>) { current = { ...current, ...overrides }; },
        receiptChanged(environmentId = config.environmentId, deploymentId = current.id) {
            return emit('@happier/deployment/receipt-invalidated', { environmentId, deploymentId });
        },
        reconnect() { return emit('@happier/automation/event-sources-invalidated', { reason: 'reconnect', definitionsChanged: false }); },
        settleOnNextObserve(state: 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown' = 'failed') { settleNextObserve = state; }, deferNextObserve() { pendingNextObserve = true; },
        failNextObservation() { failNextObserve = true; }, setSafe(value: boolean) { safe = value; } };
}

it.each(['running', 'pending', 'unavailable'] as const)('settles a %s observation on the saved period, then does zero idle work', async outcome => {
    const periodMs = 7300;
    const h = fixture(periodMs);
    if (outcome === 'pending') h.deferNextObserve();
    if (outcome === 'unavailable') h.failNextObservation();
    let time = 1200;
    const sleep = vi.fn(async (delay: number) => {
        expect(delay).toBe(periodMs); time += delay; h.settleOnNextObserve(); h.reads.length = 0;
    });
    const running = runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => time), now: () => time, sleep });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sleep).toHaveBeenCalledOnce();
        expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(2);
        expect(h.admissions).toHaveLength(1);
        expect(h.admissions[0]).toMatchObject({ payload: { state: 'failed', phase: 'build', failureCode: 'build_failed' } });
        if (outcome !== 'unavailable') expect(h.reads).toEqual(['receipt-a', 'receipt-a']);
        if (outcome === 'unavailable') expect(h.execute.mock.calls).toContainEqual(['automation.event.source.status.report',
            expect.objectContaining({ state: 'backingOff', nextRetryAt: 8500 }), expect.anything()]);
        const idleCalls = h.execute.mock.calls.length;
        time += periodMs * 10;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.execute).toHaveBeenCalledTimes(idleCalls);
        expect(sleep).toHaveBeenCalledOnce();
    } finally { h.controller.abort(); await running; }
});

it('exposes absent pending cadence after one finite observation', async () => {
    const h = fixture();
    await runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host), mode: 'once' });
    expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(1);
    expect(h.execute.mock.calls).toContainEqual(['automation.event.source.status.report',
        expect.objectContaining({ state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null }), expect.anything()]);
});

it('retries an unavailable incremental observation using known receipt IDs without rescanning history', async () => {
    const periodMs = 7300;
    const h = fixture(periodMs);
    let time = 1200;
    const sleep = vi.fn(async (delay: number) => {
        expect(delay).toBe(periodMs); time += delay;
        if (sleep.mock.calls.length === 1) { h.failNextObservation(); h.reads.length = 0; }
        else h.settleOnNextObserve();
    });
    const running = runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => time), now: () => time, sleep });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(h.reads).toEqual(['receipt-a', 'receipt-a', 'receipt-a']);
        expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list')).toHaveLength(1);
        expect(h.admissions).toHaveLength(1);
    } finally { h.controller.abort(); await running; }
});

it('reads addressed changes only and replays retained receipts on reconnect', async () => {
    const h = fixture(); h.settle();
    const running = runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200), now: () => 1200 });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.admissions).toHaveLength(1); h.reads.length = 0;
        await h.receiptChanged('another-environment'); expect(h.reads).toEqual([]);
        await h.receiptChanged(); expect(h.reads).toEqual(['receipt-a']);
        h.reads.length = 0;
        await h.reconnect(); expect(h.reads).toContain('historical-1999');
        expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toEqual([]);
    } finally { h.controller.abort(); await running; }
});

it('captures the exact current plugin runtime principal and chosen period at targeted setup', async () => {
    const h = fixture();
    const setup = deploymentEventActions['deployment-failed/setup']!;
    const result = await setup.run({ v: 1, serverId: config.serverId, environmentId: config.environmentId,
        targetLinkId: config.targetLinkId, periodMs: 7300 }, h.context);
    expect(result).toMatchObject({ sourceConfig: { ...config, periodMs: 7300 } });
    expect(h.execute.mock.calls.map(([id]) => id)).toEqual(['deployments.observation.get']);
    h.environment.runtimeTargetLinkId = 'replacement-target';
    await expect(setup.run({ v: 1, serverId: config.serverId, environmentId: config.environmentId,
        targetLinkId: config.targetLinkId }, h.context)).rejects.toMatchObject({ code: 'deployment_target_unavailable' });
});

it('preserves Environment-wide setup and separates the targeted source identity', async () => {
    const h = fixture();
    const setup = deploymentEventActions['deployment-failed/setup']!;
    const environment = await setup.run({ v: 1, serverId: config.serverId, environmentId: config.environmentId }, h.context);
    const targeted = await setup.run({ v: 1, serverId: config.serverId, environmentId: config.environmentId,
        targetLinkId: config.targetLinkId }, h.context);
    expect(environment.sourceConfig).toEqual({ v: 1, serverId: config.serverId, environmentId: config.environmentId, observingSince: 1000 });
    expect(environment.sourceInstanceId).not.toBe(targeted.sourceInstanceId);
    expect(h.execute.mock.calls.map(([id]) => id)).toEqual(['deployments.environments.get', 'deployments.observation.get']);
});

it.each([{ targetLinkId: 'another-target', operation: 'deploy' }, { targetLinkId: config.targetLinkId, operation: 'teardown' }] as const)(
    'ignores $operation receipts for $targetLinkId at the targeted producer', async overrides => {
        const h = fixture(7300); h.setReceipt(overrides);
        await runCheckpointedPluginEventObserverV1({ context: h.context,
            source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host), mode: 'once' });
        expect(h.admissions).toEqual([]);
        expect(h.execute.mock.calls.some(([id]) => id === 'deployments.receipts.observe')).toBe(false);
        h.settle();
        await runCheckpointedPluginEventObserverV1({ context: h.context,
            source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host), mode: 'once' });
        expect(h.admissions).toEqual([]);
    });

it.each(['deploy', 'rollback', 'promote', 'teardown'] as const)('emits the generic succeeded Event for non-teardown %s receipts', async operation => {
    const h = fixture(7300, 'deployment-succeeded');
    h.setReceipt({ state: 'succeeded', operation, settledAtMs: 1100 });
    await runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200), mode: 'once', now: () => 1200 });
    expect(h.admissions).toHaveLength(operation === 'teardown' ? 0 : 1);
    if (operation !== 'teardown') expect(h.admissions[0]).toMatchObject({ eventRef: { pluginId, localId: 'deployment-succeeded' },
        payload: { operation, state: 'succeeded' } });
    expect(h.execute.mock.calls.some(([id]) => id === 'deployments.receipts.observe')).toBe(false);
});

// Provider declarations flow into enrollment's existing periodMs; the runner owns the only clock.
it.each([vercel, cloudflare].flatMap(manifest => (manifest.contributes.deploymentTargets ?? []).flatMap(target =>
    (['failed', 'succeeded', 'cancelled', 'outcome_unknown'] as const).map(terminal => ({ target, terminal })))))(
    'observes demanded $target.targetKind until $terminal, then has zero scheduled work', async ({ target, terminal }) => {
        const periodMs = Reflect.get(target, 'statusIntervalMs') as number | undefined;
        const h = fixture(periodMs);
        let time = 1200;
        const sleep = vi.fn(async (delay: number) => {
            expect(delay).toBe(periodMs);
            time += delay;
            if (sleep.mock.calls.length === 2) h.settleOnNextObserve(terminal);
        });
        const running = runCheckpointedPluginEventObserverV1({ context: h.context,
            source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => time), now: () => time, sleep });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(3);
            expect(sleep).toHaveBeenCalledTimes(2);
            const calls = h.execute.mock.calls.length;
            time += 100000;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(h.execute).toHaveBeenCalledTimes(calls);
        } finally { h.controller.abort(); await running; }
    });

it('does not observe already settled receipts or their historical siblings', async () => {
    const h = fixture(1000); h.settle();
    const sleep = vi.fn();
    const running = runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host), sleep });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toHaveLength(0);
        expect(sleep).not.toHaveBeenCalled();
    } finally { h.controller.abort(); await running; }
});
