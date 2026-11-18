import { expect, it, vi } from 'vitest';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { createDeploymentReceiptEventSourceAdapter, deploymentEventActions, deploymentEvents } from './deploymentEvents.js';

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
    projectSourceId: 'source-a', acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } },
    revision: 2, operation: 'deploy', state: 'running', requestKey: 'request-a', requestedByAccountId: 'owner',
    actionOperationId: 'operation-a', contentArtifactId: 'artifact-a', contentHeaderVersion: 1, contentBodyVersion: 1,
    requestedAtMs: 1000, startedAtMs: 1001 } as const;

function fixture(periodMs?: number, eventId = 'deployment-failed', kindWide = false, targetKind = 'vercel', omitFailureSummary = false) {
    let current: Omit<typeof receipt, 'id' | 'state' | 'revision' | 'operation' | 'targetLinkId' | 'environmentId'> & {
        id: string;
        state: 'running' | 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown'; revision: number; settledAtMs?: number;
        operation: 'deploy' | 'rollback' | 'promote' | 'teardown'; targetLinkId: string; environmentId: string } = { ...receipt };
    const environment = { id: config.environmentId, runtimeTargetLinkId: config.targetLinkId as string };
    const targetLink = { id: config.targetLinkId, environmentId: config.environmentId, role: 'runtime', targetKind,
        source: targetKind === 'ownServer' ? { kind: 'host', id: 'own-server' }
            : { kind: 'plugin', contribution: { pluginId: 'happier.platform.test', localId: 'runtime' } } };
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
        sourceConfig: { ...(kindWide ? { v: 1, serverId: config.serverId, observingSince: 1000 } : config),
            ...(periodMs === undefined ? {} : { periodMs }) },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
        filter: null, maximumObservationAgeMs: null };
    const execute = vi.fn(async (id: string, input: Record<string, unknown>) => {
        if (id === 'automation.event.sources.list') return input.knownRevision === '1'
            ? { kind: 'unchanged', revision: '1' } : { kind: 'page', revision: '1', definitions: [definition], nextCursor: null };
        if (id === 'automation.event.source.status.report') return { kind: 'reported' };
        if (id === 'automation.event.admit') { admissions.push(input); return { results: safe ? [{ kind: 'skipped', reason: 'occurrenceRejected', checkpointSafe: true }] : [] }; }
        if (id === 'deployments.observation.get') return targetKind === 'ownServer'
            ? { ok: false, error: 'unsupported_action' }
            : { ok: true, environment, targetLink, credentialPrincipal: config.credentialPrincipal };
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
                ...(current.state === 'failed' && !omitFailureSummary ? { failureSummary: { phase: 'build', code: 'build_failed' } } : {}) }
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
    return { context, controller, definition, execute, admissions, reads, settle, environment,
        nativeFact(payload: Record<string, unknown>) { return emit('@happier/machine/service-observed', payload); },
        setReceipt(overrides: Partial<typeof current>) { current = { ...current, ...overrides }; },
        receiptChanged(environmentId = config.environmentId, deploymentId = current.id) {
            return emit('@happier/deployment/receipt-invalidated', { serverId: config.serverId, environmentId, deploymentId });
        },
        reconnect() { return emit('@happier/automation/event-sources-invalidated', { reason: 'reconnect', definitionsChanged: false }); },
        settleOnNextObserve(state: 'failed' | 'succeeded' | 'cancelled' | 'outcome_unknown' = 'failed') { settleNextObserve = state; }, deferNextObserve() { pendingNextObserve = true; },
        failNextObservation() { failNextObserve = true; }, setSafe(value: boolean) { safe = value; } };
}

it.each(['failed', 'succeeded', 'cancelled', 'outcome_unknown'] as const)(
    'delivers native deployment %s completion without a configured Event trigger', async state => {
        const h = fixture();
        const adapter = createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200, h.context);
        const subscription = adapter.subscribeWake!(async () => {});
        try {
            h.settle(state);
            const localId = state === 'outcome_unknown' ? 'deployment-outcome-unknown' : `deployment-${state}`;
            expect(deploymentEvents[localId]?.declaration.automation.completionOutcome).toBe(state);
            await h.receiptChanged();
            expect(h.admissions).toHaveLength(1);
            expect(h.admissions[0]).toMatchObject({
                eventRef: { pluginId, localId: state === 'outcome_unknown' ? 'deployment-outcome-unknown' : `deployment-${state}` },
                definitions: [], occurredAt: 1100,
                subjectContexts: expect.arrayContaining([{ role: 'operand', subject: { kind: 'environment', serverId: config.serverId, environmentId: config.environmentId } }]),
            });
            expect(h.reads).toEqual([receipt.id]);
            expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.list')).toHaveLength(0);
        } finally { subscription.dispose(); }
    },
);

it('shares one exact receipt read with a configured source before native completion admission settles', async () => {
    const h = fixture();
    h.setReceipt({ settledAtMs: 900 });
    const adapter = createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200, h.context);
    const running = runCheckpointedPluginEventObserverV1({ context: h.context, source: adapter, now: () => 1200 });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.admissions).toHaveLength(0);
        let release!: () => void;
        const completionBlocked = new Promise<void>(resolve => { release = resolve; });
        const execute = h.context.services.actions.execute;
        h.context.services.actions.execute = (async (...args: Parameters<typeof execute>) => {
            if (args[0] === 'automation.event.admit'
                && Array.isArray(args[1].definitions) && args[1].definitions.length === 0) await completionBlocked;
            return await execute(...args);
        }) as typeof execute;
        const beforeInvalidation = h.execute.mock.calls.length;
        h.settle();
        const wake = h.receiptChanged();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.admissions.some(input => Array.isArray((input as { definitions?: unknown }).definitions)
            && (input as { definitions: unknown[] }).definitions.length > 0)).toBe(true);
        release();
        await wake;
        const exactReads = h.execute.mock.calls.slice(beforeInvalidation)
            .filter(([id, input]) => id === 'deployments.receipts.get' && input.deploymentId === receipt.id);
        expect(exactReads).toHaveLength(1);
    } finally {
        h.controller.abort();
        await running;
    }
});

it('publishes a failed Event when the receipt has no failure summary', async () => {
    const h = fixture(undefined, 'deployment-failed', false, 'vercel', true); h.settle();
    const adapter = createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200);
    const source = adapter.decode(h.definition)!;
    const result = await adapter.observe({ context: h.context, definition: h.definition, source });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ payload: { state: 'failed', phase: null, failureCode: null } });
});

it('sets up any deployment kind without a resource census and follows addressed remote receipts', async () => {
    const h = fixture(undefined, 'deployment-failed', true); h.settle();
    const setup = await deploymentEventActions['deployment-failed/setup']!.run({ v: 1, serverId: config.serverId }, h.context);
    expect(setup.sourceConfig).toEqual({ v: 1, serverId: config.serverId, observingSince: 1000 });
    expect(h.execute).not.toHaveBeenCalled();
    const running = runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1200), now: () => 1200 });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(h.admissions).toHaveLength(1);
        expect(h.admissions[0]).toMatchObject({ subjectContexts: [
            { role: 'operand', subject: { kind: 'environment', serverId: config.serverId, environmentId: config.environmentId } },
            { role: 'context', subject: { kind: 'app', serverId: config.serverId, projectSourceId: 'source-a' } },
            { role: 'context', subject: { kind: 'machine', serverId: config.serverId, machineId: 'machine-a' } },
        ] });
        expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.environments.get')).toHaveLength(0);
        expect(h.execute.mock.calls.find(([id]) => id === 'deployments.receipts.list')?.[1]).toEqual({ serverId: config.serverId });
        h.setReceipt({ id: 'receipt-remote', environmentId: 'remote-environment' });
        h.reads.length = 0;
        await h.receiptChanged('remote-environment');
        expect(new Set(h.reads)).toEqual(new Set(['receipt-remote']));
        expect(h.admissions).toHaveLength(2);
        expect(h.admissions[1]).toMatchObject({ subjectContexts: expect.arrayContaining([
            { role: 'operand', subject: { kind: 'environment', serverId: config.serverId, environmentId: 'remote-environment' } },
        ]) });
    } finally { h.controller.abort(); await running; }
});

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

it('sets up a targeted native receipt source without acquiring a provider observation', async () => {
    const h = fixture(undefined, 'deployment-failed', false, 'ownServer');
    const result = await deploymentEventActions['deployment-failed/setup']!.run({ v: 1, serverId: config.serverId,
        environmentId: config.environmentId, targetLinkId: config.targetLinkId }, h.context);
    expect(result.sourceConfig).toEqual({ v: 1, serverId: config.serverId, environmentId: config.environmentId,
        targetLinkId: config.targetLinkId, observingSince: 1000 });
    expect(h.execute.mock.calls.map(([id]) => id)).toEqual(['deployments.environments.get']);
    h.definition.sourceConfig = result.sourceConfig;
    await runCheckpointedPluginEventObserverV1({ context: h.context,
        source: createDeploymentReceiptEventSourceAdapter(h.context.services.events.host), mode: 'once' });
    expect(h.execute.mock.calls.filter(([id]) => id === 'deployments.receipts.observe')).toEqual([]);
    expect(h.execute.mock.calls).toContainEqual(['automation.event.source.status.report',
        expect.objectContaining({ state: 'observing', code: 'none', nextRetryAt: null }), expect.anything()]);
});

it('captures the exact current plugin runtime principal and chosen period at targeted setup', async () => {
    const h = fixture();
    const setup = deploymentEventActions['deployment-failed/setup']!;
    const result = await setup.run({ v: 1, serverId: config.serverId, environmentId: config.environmentId,
        targetLinkId: config.targetLinkId, periodMs: 7300 }, h.context);
    expect(result).toMatchObject({ sourceConfig: { ...config, periodMs: 7300 } });
    expect(h.execute.mock.calls.map(([id]) => id)).toEqual(['deployments.environments.get', 'deployments.observation.get']);
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
    expect(h.execute.mock.calls.map(([id]) => id)).toEqual(['deployments.environments.get',
        'deployments.environments.get', 'deployments.observation.get']);
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

it('observes native restore and rollback settlements without receipt reads and retains arrivals during admission', async () => {
    const h = fixture(undefined, 'backup-restore-settled');
    h.settle('succeeded');
    const adapter = createDeploymentReceiptEventSourceAdapter(h.context.services.events.host, () => 1500);
    const source = adapter.decode(h.definition);
    expect(source).not.toBeNull();
    if (!source) throw new Error('Expected the canonical deployment restore Event source');
    const options = { context: h.context, definition: h.definition, definitions: [h.definition], source, isCurrent: async () => true };
    const observe = () => adapter.observe(options);
    const initial = await observe();
    expect(initial.observations).toEqual([]);
    await adapter.save({ ...options, checkpoint: initial.checkpoint! });
    const wakes: (string | undefined)[] = [];
    const subscription = adapter.subscribeWake!(async id => { wakes.push(id); });
    const restored = { kind: 'backupRestore', serverId: 'home', machineId: 'machine-a',
        environmentId: config.environmentId, targetLinkId: config.targetLinkId, operationId: 'restore-operation', occurredAt: 1100,
        state: 'succeeded', resultKind: 'restored', verified: true, errorCode: null,
        destination: { kind: 'database', service: 'postgres', database: 'original-database' } } as const;
    const rolledBack = { ...restored, operationId: 'rollback-operation', occurredAt: 1200, resultKind: 'rolledBack', verified: false } as const;
    try {
        await h.nativeFact({ ...restored, serverId: 'other-home' });
        await h.nativeFact({ ...restored, environmentId: 'other-environment' });
        await h.nativeFact({ ...restored, targetLinkId: 'other-target' });
        await h.nativeFact({ ...restored, occurredAt: config.observingSince - 1 });
        await h.nativeFact({ kind: 'backup', serverId: 'home', machineId: 'machine-a',
            environmentId: config.environmentId, operationId: 'backup-operation', occurredAt: 1100,
            state: 'succeeded', errorCode: null });
        await h.receiptChanged();
        expect(wakes).toEqual([]);
        const ignored = await observe();
        expect(ignored.observations).toEqual([]);
        await adapter.save({ ...options, checkpoint: ignored.checkpoint! });
        await h.nativeFact(restored);
        await h.nativeFact(restored);
        const first = await observe();
        expect(first.observations.map(row => row.payload)).toEqual([restored]);
        await h.nativeFact(rolledBack);
        expect(first.checkpoint).toBeDefined();
        await adapter.save({ ...options, checkpoint: first.checkpoint! });
        const next = await observe();
        expect(next.observations.map(row => row.payload)).toEqual([rolledBack]);
        expect(next.observations[0]!.occurrenceId).not.toBe(first.observations[0]!.occurrenceId);
        await adapter.save({ ...options, checkpoint: next.checkpoint! });
        await h.nativeFact({ ...restored, occurredAt: 1400 });
        const replay = await observe();
        expect(replay.observations[0]!.occurrenceId).toBe(first.observations[0]!.occurrenceId);
        expect(replay.observations[0]!.payload).toEqual({ ...restored, occurredAt: 1400 });
        await adapter.save({ ...options, checkpoint: replay.checkpoint! });
        const integrityUnavailable = { ...restored, operationId: 'restore-integrity-unavailable', occurredAt: 1450, verified: false };
        const exceptionalError = { ...restored, operationId: 'restore-error', occurredAt: 1451,
            state: 'failed', resultKind: null, verified: null, errorCode: 'restore_failed' };
        await h.nativeFact(integrityUnavailable);
        await h.nativeFact(exceptionalError);
        expect((await observe()).observations.map(row => row.payload)).toEqual([integrityUnavailable, exceptionalError]);
        expect(h.execute).not.toHaveBeenCalled();
    } finally { subscription.dispose(); h.controller.abort(); }
});
