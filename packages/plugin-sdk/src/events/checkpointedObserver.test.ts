import { describe, expect, it, vi } from 'vitest';
import { AutomationEventAdmitInputV1Schema, type AutomationEventAdmitItemResultV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { runRepositoryPushObserver } from '../../examples/automation-event-source/src/index.js';
import type { BackgroundServiceContext } from '../backgroundServices.js';
import type { HostEventEnvelope } from '../events.js';
import { PluginError } from '../errors.js';
import { readCheckpointedPluginEventSourcesV1, runCheckpointedPluginEventObserverV1, type PluginCheckpointedEventAttemptContextV1, type PluginCheckpointedEventAttemptResultV1, type PluginCheckpointedEventSourceAdapterV1, type PluginCheckpointedEventSourceDefinitionV1 } from '../background-services/index.js';

const materialization = { pluginId: 'com.example.events', machineId: 'machine-1', materializationId: 'installation-1' };
function definition(): PluginCheckpointedEventSourceDefinitionV1 {
    return { automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'trigger-1', triggerRevision: 1,
        eventRef: { pluginId: materialization.pluginId, localId: 'changed' }, sourceInstanceId: 'source:1',
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1, sourceConfig: { v: 1 },
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null };
}

function fixture() {
    const controller = new AbortController();
    let definitions: readonly PluginCheckpointedEventSourceDefinitionV1[] = [definition()];
    let revision = '1';
    let invalidate: ((event: HostEventEnvelope<'@happier/automation/event-sources-invalidated'>) => void) | undefined;
    const invalidated = (payload: HostEventEnvelope<'@happier/automation/event-sources-invalidated'>['payload'] = {}) =>
        invalidate?.({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload });
    let safe = true;
    let failCurrentRead = false;
    let failCatalogStatus = false;
    let failSourceStatus = false;
    let admissionFailure: unknown;
    let admissionResult: unknown;
    let unsafeOccurrence: string | undefined;
    const skippedAdmissions = new Map<string, Extract<AutomationEventAdmitItemResultV1, { kind: 'skipped' }>['reason']>();
    const runs = new Set<string>();
    const executions: string[] = [];
    const execute = vi.fn(async (id: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> => {
        // Model the host scheduling boundary, not an SDK-side retry timer.
        const refresh = input.catalogRefresh;
        if (id === 'automation.event.sources.list' && typeof refresh === 'object' && refresh !== null
            && 'kind' in refresh && refresh.kind === 'retry' && 'retryAt' in refresh && typeof refresh.retryAt === 'number'
            && refresh.retryAt > Date.now()) {
            const retryAt = refresh.retryAt;
            await new Promise<void>((resolve, reject) => {
                const done = () => { options?.signal?.removeEventListener('abort', aborted); resolve(); };
                const timer = setTimeout(done, retryAt - Date.now());
                const aborted = () => { clearTimeout(timer); reject(new Error('Catalog wait cancelled')); };
                options?.signal?.addEventListener('abort', aborted, { once: true });
                if (options?.signal?.aborted) aborted();
            });
        }
        executions.push(id);
        if (id === 'automation.event.sources.list' && failCurrentRead) {
            failCurrentRead = false;
            throw new Error('Catalog transport unavailable');
        }
        if (id === 'automation.event.source.status.report' && input.kind === 'catalogReconciliation' && failCatalogStatus) {
            failCatalogStatus = false;
            throw new Error('Catalog status transport unavailable');
        }
        if (id === 'automation.event.source.status.report' && input.kind === 'source' && failSourceStatus) {
            failSourceStatus = false;
            throw new Error('Source status transport unavailable');
        }
        if (id === 'automation.event.sources.list') {
            const transport = input.transport;
            const kind = typeof transport === 'object' && transport !== null && 'kind' in transport ? transport.kind : undefined;
            return input.knownRevision === revision
                ? { kind: 'unchanged', revision }
                : { kind: 'page', revision, definitions: definitions.filter(member => member.observationTransport.kind === kind), nextCursor: null };
        }
        if (id === 'automation.event.source.status.report') return {};
        if (id === 'automation.event.admit') {
            if (admissionFailure !== undefined) throw admissionFailure;
            if (admissionResult !== undefined) return admissionResult;
            const request = AutomationEventAdmitInputV1Schema.parse(input);
            return { results: safe && request.occurrenceId !== unsafeOccurrence ? request.definitions.map(selector => {
                const key = `${selector.triggerId}/${request.occurrenceId}`;
                const reason = skippedAdmissions.get(key);
                if (reason !== undefined) return { kind: 'skipped', reason, checkpointSafe: true };
                const replay = runs.has(key);
                runs.add(key);
                return { kind: replay ? 'rejoined' : 'admitted', checkpointSafe: true, runId: `run-${runs.size}` };
            }) : [] };
        }
        throw new Error(`Unexpected action ${id}`);
    });
    // Actions and authenticated Host Events are genuine host boundaries. Internal SDK admission stays real.
    const context = { plugin: { id: materialization.pluginId, version: '1.0.0' }, contribution: { id: 'observe', qualifiedId: `${materialization.pluginId}/backgroundServices/observe` },
        surface: 'background', invokedAtMs: 1000, materialization, signal: controller.signal,
        services: { actions: { execute }, events: { host: { subscribe: (_target: unknown, listener: typeof invalidate) => { invalidate = listener; return { dispose() {} }; } } } },
    } as unknown as BackgroundServiceContext;
    const observation = (): PluginCheckpointedEventAttemptResultV1<string> => ({ observations: [{ eventRef: definition().eventRef, sourceInstanceId: 'source:1', sourceContractVersion: 1,
        occurrenceId: 'event-1', occurredAt: 1000, observationReceivedAt: 1000, observedDelta: 1 as const, payload: { changed: true } }],
        checkpoint: 'cursor-1', complete: true, nextEligibleAt: 2000 });
    const observe = vi.fn(async (_input: PluginCheckpointedEventAttemptContextV1<string>) => observation());
    const save = vi.fn(async () => {});
    const source: PluginCheckpointedEventSourceAdapterV1<string, string> = { decode: () => 'source', observe, save, retryAt: ({ now }) => now + 1000 };
    return { context, controller, source, observe, observation, save, execute, executions,
        setSafe(value: boolean) { safe = value; },
        setAdmissionFailure(error: unknown) { admissionFailure = error; },
        setAdmissionResult(result: unknown) { admissionResult = result; },
        setUnsafeOccurrence(value: string) { unsafeOccurrence = value; },
        skipAdmission(triggerId: string, occurrenceId: string, reason: Extract<AutomationEventAdmitItemResultV1, { kind: 'skipped' }>['reason']) {
            skippedAdmissions.set(`${triggerId}/${occurrenceId}`, reason);
        },
        runCount() { return runs.size; },
        replace(next: readonly PluginCheckpointedEventSourceDefinitionV1[]) { definitions = next; revision = String(Number(revision) + 1); invalidated(); },
        invalidate: invalidated,
        empty() { definitions = []; },
        failBoundary(kind: 'current read' | 'catalog status' | 'source status') {
            if (kind === 'current read') failCurrentRead = true;
            else if (kind === 'catalog status') failCatalogStatus = true;
            else failSourceStatus = true;
        },
    };
}

describe('checkpointed observer ownership', () => {
    it('keeps the provider schedule observing while one admission waits and saves its original candidate on settlement', async () => {
        const f = fixture();
        let clock = 1000;
        let finishAdmission!: (value: unknown) => void;
        f.setAdmissionResult(new Promise(resolve => { finishAdmission = resolve; }));
        const rawResults: string[] = [];
        let finishObservation: (() => void) | undefined;
        f.observe.mockImplementation(async () => {
            rawResults.push(clock === 1000 ? 'down' : 'up');
            if (clock === 2000) await new Promise<void>(resolve => { finishObservation = resolve; });
            return { ...f.observation(), checkpoint: `cursor-${clock}`, nextEligibleAt: clock + 1000 };
        });
        let resume: (() => void) | undefined;
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            resume = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, observeWhileAdmissionPending: true }, sleep, now: () => clock });
        const settled = { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'run-held' }] };
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            expect(sleep).toHaveBeenCalledOnce();
            clock = 2000;
            resume?.();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(rawResults).toEqual(['down', 'up']);
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            expect(f.save).not.toHaveBeenCalled();
            finishAdmission(settled);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.save).not.toHaveBeenCalled();
            finishObservation?.();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ checkpoint: 'cursor-1000',
                disposition: expect.objectContaining({ kind: 'checkpointSafe' }) }));
            expect(rawResults).toEqual(['down', 'up']);
        } finally {
            finishObservation?.();
            finishAdmission(settled);
            f.controller.abort();
            await running;
        }
    });

    it.each(['removed', 'cancelled'] as const)('does not save a late admission after its source is %s', async retirement => {
        const f = fixture();
        let finishAdmission!: (value: unknown) => void;
        f.setAdmissionResult(new Promise(resolve => { finishAdmission = resolve; }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, observeWhileAdmissionPending: true }, now: () => 1000,
            sleep: (_delay, signal) => new Promise<void>(resolve => {
                signal.addEventListener('abort', () => resolve(), { once: true });
                if (signal.aborted) resolve();
            }) });
        const settled = { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'run-held' }] };
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            if (retirement === 'removed') f.replace([]);
            else f.controller.abort();
            await new Promise<void>(resolve => setImmediate(resolve));
            finishAdmission(settled);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.save).not.toHaveBeenCalled();
        } finally {
            finishAdmission(settled);
            f.controller.abort();
            await running;
        }
    });

    it('parks a buffered immediate drain while its one admission awaits settlement', async () => {
        const f = fixture();
        let finishAdmission!: (value: unknown) => void;
        f.setAdmissionResult(new Promise(resolve => { finishAdmission = resolve; }));
        f.observe.mockResolvedValue({ ...f.observation(), nextEligibleAt: 1000 });
        let wake: ((sourceInstanceId?: string) => Promise<void>) | undefined;
        const sleep = vi.fn(async () => { throw new Error('A buffered pending cursor has no advancing deadline'); });
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, observeWhileAdmissionPending: true,
                subscribeWake(listener) { wake = listener; return { dispose() {} }; } }, now: () => 1000, sleep });
        const settled = { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'run-held' }] };
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            for (let index = 0; index < 3; index += 1) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect(f.observe).toHaveBeenCalledOnce();
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(f.save).not.toHaveBeenCalled();
            await wake?.('source:1');
            expect(f.observe).toHaveBeenCalledTimes(2);
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            expect(sleep).not.toHaveBeenCalled();
        } finally {
            f.controller.abort();
            finishAdmission(settled);
            await running;
        }
    });

    it('retains a non-opted-in adapter cursor without observing again during admission', async () => {
        const f = fixture();
        let clock = 1000;
        let finishAdmission!: (value: unknown) => void;
        f.setAdmissionResult(new Promise(resolve => { finishAdmission = resolve; }));
        let cursor = 'initial';
        f.observe.mockImplementation(async () => {
            cursor = `cursor-${clock}`;
            return { ...f.observation(), checkpoint: cursor, nextEligibleAt: clock + 1000 };
        });
        let wake: ((sourceInstanceId?: string) => Promise<void>) | undefined;
        const sleep = vi.fn(async () => { throw new Error('An adapter with retained admission must wait for settlement'); });
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, subscribeWake(listener) { wake = listener; return { dispose() {} }; } }, now: () => clock, sleep });
        const settled = { results: [{ kind: 'admitted', checkpointSafe: true, runId: 'run-held' }] };
        let notified: Promise<void> | undefined;
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            clock = 2000;
            notified = wake?.('source:1').catch(() => {});
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(cursor).toBe('cursor-1000');
            expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(f.save).not.toHaveBeenCalled();
        } finally {
            f.controller.abort();
            finishAdmission(settled);
            await running;
            await notified;
        }
    });

    it('yields through the existing deadline after an expired candidate settles immediately', async () => {
        const f = fixture();
        let observations = 0;
        f.observe.mockImplementation(async () => {
            observations += 1;
            if (observations > 1) throw new Error('The next observation must wait for its eligibility wake');
            return { ...f.observation(), nextEligibleAt: 500 };
        });
        const sleep = vi.fn(async () => { f.controller.abort(); });
        await runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, observeWhileAdmissionPending: true }, now: () => 1000, sleep });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.save).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledExactlyOnceWith(0, expect.any(AbortSignal));
    });

    it('keeps a rejected pending admission typed and parks a nonretryable refusal without saving', async () => {
        const f = fixture();
        let rejectAdmission!: (error: unknown) => void;
        f.setAdmissionResult(new Promise((_resolve, reject) => { rejectAdmission = reject; }));
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            if (signal.aborted) resolve();
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, observeWhileAdmissionPending: true }, now: () => 1000, sleep });
        const refusal = new PluginError({ code: 'verification_purpose', retryable: false });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(sleep).toHaveBeenCalledOnce();
            rejectAdmission(refusal);
            await new Promise<void>(resolve => setImmediate(resolve));
            const statuses = f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source')
                .map(([, value]) => value);
            expect(statuses).toContainEqual(expect.objectContaining({ state: 'attention', code: 'verification_purpose', nextRetryAt: null }));
            expect(f.observe).toHaveBeenCalledOnce();
            expect(f.save).not.toHaveBeenCalled();
            expect(sleep).toHaveBeenCalledOnce();
        } finally {
            rejectAdmission(refusal);
            f.controller.abort();
            await running;
        }
    });

    it('settles an unavailable attempt without a deadline and resumes only on source invalidation', async () => {
        const f = fixture();
        let available = false;
        const source: typeof f.source = { ...f.source, retryAt: () => null,
            async observe() {
                if (!available) throw new PluginError({ code: 'service_unavailable', retryable: false,
                    message: 'Private provider diagnostic', details: { secret: 'never-publish' } });
                return { observations: [], complete: true, nextEligibleAt: null };
            } };
        const sleep = vi.fn(async () => {});
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source, sleep });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            const statuses = () => f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source')
                .map(([, value]) => value);
            expect(statuses()).toMatchObject([{ state: 'attention', code: 'service_unavailable', nextRetryAt: null }]);
            expect(JSON.stringify(statuses())).not.toContain('Private provider diagnostic');
            expect(JSON.stringify(statuses())).not.toContain('never-publish');
            expect(sleep).not.toHaveBeenCalled();
            available = true;
            f.invalidate({ reason: 'reconnect', definitionsChanged: false });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(statuses()).toMatchObject([
                { state: 'attention', code: 'service_unavailable', nextRetryAt: null },
                { state: 'observing', code: 'none', nextRetryAt: null },
            ]);
            expect(sleep).not.toHaveBeenCalled();
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('parks a nonretryable admission refusal until an authenticated source wake', async () => {
        const f = fixture();
        f.setAdmissionFailure(new PluginError({ code: 'verification_purpose', retryable: false }));
        const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) => new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            if (signal.aborted) resolve();
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            const statuses = () => f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source')
                .map(([, value]) => value);
            expect(statuses()).toContainEqual(expect.objectContaining({ state: 'attention', code: 'verification_purpose', nextRetryAt: null }));
            expect(f.save).not.toHaveBeenCalled();
            expect(f.observe).toHaveBeenCalledOnce();
            expect(sleep).not.toHaveBeenCalled();
            f.setAdmissionFailure(undefined);
            f.invalidate({ reason: 'reconnect', definitionsChanged: false });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.save).toHaveBeenCalledOnce();
            expect(f.runCount()).toBe(1);
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('keeps malformed admission unavailable when the provider reports observing without a retry deadline', async () => {
        const f = fixture();
        f.setAdmissionResult({ results: 'invalid' });
        f.observe.mockResolvedValue({ ...f.observation(), nextEligibleAt: null, status: { state: 'observing', code: 'none' } });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        const statuses = f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source')
            .map(([, value]) => value);
        expect(statuses.at(-1)).toMatchObject({ state: 'attention', code: 'admissionUnavailable', nextRetryAt: null });
        expect(f.save).not.toHaveBeenCalled();
    });

    it('keeps the maintained external author example behind its host assignment', async () => {
        const f = fixture();
        const pluginId = 'examples.automation-event-source';
        const assigned = { ...materialization, pluginId };
        f.replace([{ ...definition(), eventRef: { pluginId, localId: 'repository-pushed' },
            sourceInstanceId: 'example/repository', sourceConfig: { repository: 'example/repository' },
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: assigned } }]);
        const context: BackgroundServiceContext = { ...f.context, plugin: { ...f.context.plugin, id: pluginId },
            materialization: { ...assigned, machineId: 'other-machine' },
            services: { ...f.context.services, logger: { ...f.context.services.logger, info() {} } } };
        const running = runRepositoryPushObserver(context);
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(f.runCount()).toBe(0);
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('exposes the canonical strict source pager to a finite recovery Action', async () => {
        const f = fixture();
        expect(await readCheckpointedPluginEventSourcesV1(f.context)).toEqual({ revision: '1', definitions: [definition()] });
        expect(f.executions).toEqual(['automation.event.sources.list']);
        f.execute.mockResolvedValueOnce({ kind: 'page', revision: '1', definitions: [], nextCursor: null, unexpected: true });
        expect(await readCheckpointedPluginEventSourcesV1(f.context)).toBeNull();
    });

    it('admits a real observation before committing its provider cursor', async () => {
        const f = fixture();
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', now: () => 1000 });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.executions).toContain('automation.event.admit');
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('admits the catalog once for a finite source cycle instead of rereading authority for each observation', async () => {
        const f = fixture();
        const observed = f.observation();
        f.observe.mockImplementation(async input => {
            for (let index = 0; index < 257; index++) expect(await input.isCurrent()).toBe(true);
            return { ...observed, observations: Array.from({ length: 257 }, (_, index) => ({
                ...observed.observations[0]!, occurrenceId: `event-${index}`,
            })) };
        });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.executions.filter(id => id === 'automation.event.sources.list')).toHaveLength(1);
        expect(f.runCount()).toBe(257);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('settles an admitted finite source cycle when an unrelated source is edited', async () => {
        const f = fixture();
        f.observe.mockImplementation(async input => {
            f.replace([definition(), { ...definition(), triggerId: 'unrelated-trigger', sourceInstanceId: 'source:other' }]);
            expect(input.context.signal.aborted).toBe(false);
            expect(await input.isCurrent()).toBe(true);
            return f.observation();
        });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.runCount()).toBe(1);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it.each(['missing', 'wrong', 'stale', 'null'] as const)('makes zero provider/admission/checkpoint calls for %s assignment', async kind => {
        const f = fixture();
        const d = definition();
        if (kind === 'null') {
            // A malformed host-boundary response must fail the real strict catalog parser.
            f.execute.mockResolvedValueOnce({ kind: 'page', revision: '1', definitions: [{ ...d,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: null } }], nextCursor: null });
        } else f.replace([{ ...d, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef:
            kind === 'stale' ? { ...materialization, materializationId: 'retired-installation' } : { ...materialization, machineId: 'other' } } }]);
        const context = kind === 'missing' ? { ...f.context, materialization: undefined } : f.context;
        await runCheckpointedPluginEventObserverV1({ context, source: f.source, mode: 'once', now: () => 1000 });
        expect(f.observe).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
        expect(f.executions).not.toContain('automation.event.admit');
    });

    it('scans one native source once across Event declarations and matching subscribers', async () => {
        const f = fixture();
        const first = definition();
        const second = { ...first, triggerId: 'trigger-2' };
        f.replace([first, second, { ...first, triggerId: 'trigger-3', eventRef: { ...first.eventRef, localId: 'resolved' } }]);
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.observe.mock.calls[0]?.[0].definitions).toHaveLength(3);
        expect(f.runCount()).toBe(2);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('scans one native source once across pull and durable enrollments without borrowing assignment authority', async () => {
        const f = fixture();
        const pull = definition();
        const durableTransport = { kind: 'durablePush' as const, webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            endpointMaterializationRef: materialization, observationStartsAt: 0 };
        const durable: PluginCheckpointedEventSourceDefinitionV1 = { ...pull, triggerId: 'trigger-2',
            observationTransport: durableTransport };
        f.replace([pull, durable, { ...durable, triggerId: 'trigger-3',
            observationTransport: { ...durableTransport, endpointMaterializationRef: { ...materialization, materializationId: 'retired-installation' } } }]);
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', transportKinds: ['checkpointedPull', 'durablePush'] });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.observe.mock.calls[0]?.[0].definitions.map(member => member.triggerId)).toEqual(['trigger-1', 'trigger-2']);
        const admissions = f.execute.mock.calls.filter(([id]) => id === 'automation.event.admit').map(([, input]) => input.definitions);
        expect(admissions).toEqual([
            [{ automationId: pull.automationId, triggerId: pull.triggerId, triggerRevision: pull.triggerRevision, sourceSelectorId: pull.sourceSelectorId }],
            [{ automationId: durable.automationId, triggerId: durable.triggerId, triggerRevision: durable.triggerRevision, sourceSelectorId: durable.sourceSelectorId }],
        ]);
        expect(f.runCount()).toBe(2);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('keeps the cursor when one later observation remains unsettled', async () => {
        const f = fixture();
        f.setUnsafeOccurrence('event-2');
        const result = f.observation();
        f.observe.mockResolvedValueOnce({ ...result, observations: [...result.observations,
            { ...result.observations[0]!, occurrenceId: 'event-2' }] });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.executions.filter(id => id === 'automation.event.admit')).toHaveLength(2);
        expect(f.runCount()).toBe(1);
        expect(f.save).not.toHaveBeenCalled();
    });

    it('preserves safely skipped server outcomes when saving a candidate', async () => {
        const f = fixture();
        f.skipAdmission('trigger-1', 'event-1', 'outsideFreshness');
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.runCount()).toBe(0);
        expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ disposition: {
            kind: 'checkpointSafe', admissions: [{
                observation: { eventRef: definition().eventRef, sourceInstanceId: 'source:1', sourceContractVersion: 1, occurrenceId: 'event-1' },
                scope: { kind: 'checkpointedPull' },
                definition: { automationId: definition().automationId, triggerId: 'trigger-1', triggerRevision: 1, sourceSelectorId: definition().sourceSelectorId },
                result: { kind: 'skipped', reason: 'outsideFreshness', checkpointSafe: true },
            }],
        } }));
    });

    it('preserves each observation and scope admission across mixed skips and replay', async () => {
        const f = fixture();
        const pull = definition();
        const webhookEndpointId = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
        const durable: PluginCheckpointedEventSourceDefinitionV1 = { ...pull, triggerId: 'trigger-2', observationTransport: {
            kind: 'durablePush', webhookEndpointId, endpointMaterializationRef: materialization, observationStartsAt: 0,
        } };
        f.replace([pull, durable]);
        f.skipAdmission('trigger-1', 'event-1', 'filtered');
        f.skipAdmission('trigger-2', 'event-1', 'outsideFreshness');
        f.skipAdmission('trigger-2', 'event-2', 'filtered');
        const attempt = f.observation();
        const first = attempt.observations[0]!;
        f.observe.mockImplementation(async () => ({ ...attempt, observations: [first, { ...first, occurrenceId: 'event-2' }] }));
        const selector = (member: PluginCheckpointedEventSourceDefinitionV1) => ({ automationId: member.automationId,
            triggerId: member.triggerId, triggerRevision: member.triggerRevision, sourceSelectorId: member.sourceSelectorId });
        const expected = (replay: boolean) => ({ kind: 'checkpointSafe', admissions: [
            { observation: { eventRef: first.eventRef, sourceInstanceId: first.sourceInstanceId, sourceContractVersion: 1, occurrenceId: 'event-1' },
                scope: { kind: 'checkpointedPull' }, definition: selector(pull), result: { kind: 'skipped', reason: 'filtered', checkpointSafe: true } },
            { observation: { eventRef: first.eventRef, sourceInstanceId: first.sourceInstanceId, sourceContractVersion: 1, occurrenceId: 'event-1' },
                scope: { kind: 'durablePush', webhookEndpointId }, definition: selector(durable), result: { kind: 'skipped', reason: 'outsideFreshness', checkpointSafe: true } },
            { observation: { eventRef: first.eventRef, sourceInstanceId: first.sourceInstanceId, sourceContractVersion: 1, occurrenceId: 'event-2' },
                scope: { kind: 'checkpointedPull' }, definition: selector(pull), result: { kind: replay ? 'rejoined' : 'admitted', runId: 'run-1', checkpointSafe: true } },
            { observation: { eventRef: first.eventRef, sourceInstanceId: first.sourceInstanceId, sourceContractVersion: 1, occurrenceId: 'event-2' },
                scope: { kind: 'durablePush', webhookEndpointId }, definition: selector(durable), result: { kind: 'skipped', reason: 'filtered', checkpointSafe: true } },
        ] });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', transportKinds: ['checkpointedPull', 'durablePush'] });
        expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ disposition: expected(false) }));
        expect(f.runCount()).toBe(1);
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', transportKinds: ['checkpointedPull', 'durablePush'] });
        expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ disposition: expected(true) }));
        expect(f.runCount()).toBe(1);
    });

    it('admits zero user work for an empty scan or a replay', async () => {
        const f = fixture();
        f.observe.mockResolvedValueOnce({ observations: [], complete: true, nextEligibleAt: 2000 });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', now: () => 1000 });
        expect(f.runCount()).toBe(0);
        expect(f.save).not.toHaveBeenCalled();
        const emptyStatus = f.execute.mock.calls.find(([id, input]) => id === 'automation.event.source.status.report' && input.kind === 'source')?.[1];
        // A healthy scan's clock/deadline is live freshness, not durable source content.
        expect(emptyStatus).toMatchObject({ state: 'observing', code: 'none', nextRetryAt: null, observedDelta: 0 });
        expect(emptyStatus).not.toHaveProperty('lastObservedAt');
        f.observe.mockResolvedValueOnce({ observations: [], complete: true, nextEligibleAt: 3000 });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', now: () => 2000 });
        const nextEmptyStatus = f.execute.mock.calls.filter(([id, input]) => id === 'automation.event.source.status.report' && input.kind === 'source').at(-1)?.[1];
        expect(nextEmptyStatus).toEqual(emptyStatus);
        expect(f.runCount()).toBe(0);
        expect(f.save).not.toHaveBeenCalled();
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.runCount()).toBe(1);
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.runCount()).toBe(1);
    });

    it('does not publish catalog current while retirement is incomplete', async () => {
        const f = fixture();
        const retire = vi.fn(async () => ({ complete: false }));
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: { ...f.source, retire }, mode: 'once' });
        expect(retire).toHaveBeenCalledOnce();
        const catalogReports = f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'catalogReconciliation');
        expect(catalogReports.length).toBeGreaterThan(0);
        expect(catalogReports.every(([, value]) => value.state !== 'current')).toBe(true);
    });

    it('uses one interruptible provider deadline and makes no attempt early', async () => {
        const f = fixture();
        let clock = 1000;
        const resume: (() => void)[] = [];
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            resume.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep, now: () => clock });
        await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
        expect(sleep.mock.calls[0]?.[0]).toBe(1000);
        clock = 1999;
        resume.shift()?.();
        await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
        expect(f.observe).toHaveBeenCalledOnce();
        clock = 2000;
        resume.shift()?.();
        await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
        expect(f.runCount()).toBe(1);
        f.controller.abort();
        await running;
    });

    it('retains an unchanged source deadline across a catalog invalidation', async () => {
        const f = fixture();
        let clock = 0;
        const resume: (() => void)[] = [];
        f.observe.mockImplementation(async () => ({ observations: [], complete: false, nextEligibleAt: 600_000 }));
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            resume.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep, now: () => clock });
        try {
            await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
            clock = 120_000;
            f.replace([definition()]);
            await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
            expect(f.observe).toHaveBeenCalledOnce();
            expect(sleep.mock.calls[1]?.[0]).toBe(480_000);
            clock = 600_000;
            resume.at(-1)?.();
            await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(2));
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('unparks an unavailable source after authenticated credential invalidation at the same catalog revision', async () => {
        const f = fixture();
        f.observe.mockResolvedValueOnce({ observations: [], complete: false, nextEligibleAt: null,
            status: { state: 'attention', code: 'credentialRevoked' } });
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep, now: () => 1000 });
        try {
            await vi.waitFor(() => expect(f.execute.mock.calls.some(([, value]) => value.code === 'credentialRevoked')).toBe(true));
            expect(sleep).not.toHaveBeenCalled();
            expect(f.runCount()).toBe(0);
            f.invalidate({ definitionsChanged: false });
            await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
            expect(f.observe).toHaveBeenCalledTimes(2);
            expect(f.runCount()).toBe(1);
            expect(f.executions.filter(id => id === 'automation.event.sources.list')).toHaveLength(1);
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('does not re-confirm adopted definitions on provider deadlines or wakes', async () => {
        const f = fixture();
        let clock = 1000;
        let resume: (() => void) | undefined;
        let providerWake: ((sourceInstanceId?: string) => Promise<void>) | undefined;
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, subscribeWake: listener => { providerWake = listener; return { dispose() {} }; } },
            now: () => clock, sleep: (_delay, signal) => new Promise<void>(resolve => {
                resume = resolve; signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        });
        try {
            await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
            for (let n = 0; n < 5; n += 1) await providerWake?.('source:1');
            clock = 2000; resume?.();
            await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(7));
            expect(f.executions.filter(id => id === 'automation.event.sources.list')).toHaveLength(1);
        } finally { f.controller.abort(); await running; }
    });

    it.each([999, 1000, 2000])('bounds persistent non-host catalog failures at provider deadline %s', async retryAt => {
        const f = fixture();
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        let reads = 0;
        // An Action transport need not implement the daemon's deferred read.
        // Abort a runaway old implementation so the RED itself cannot hang.
        f.execute.mockImplementation(async id => {
            if (id !== 'automation.event.sources.list') return {};
            reads += 1;
            if (reads > 8) f.controller.abort();
            throw new Error('Catalog remains unavailable');
        });
        const running = runCheckpointedPluginEventObserverV1({ context: f.context,
            source: { ...f.source, retryAt: () => retryAt } });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(reads).toBe(retryAt > 1000 ? 1 : 2);
            await vi.advanceTimersByTimeAsync(999);
            expect(reads).toBe(retryAt > 1000 ? 1 : 2);
            await vi.advanceTimersByTimeAsync(60_001);
            expect(reads).toBe(2);
            // An expired retry parks until actual catalog invalidation, which
            // still reaches the reader immediately without a new local cap.
            f.invalidate({ reason: 'reconnect' });
            await vi.advanceTimersByTimeAsync(0);
            expect(reads).toBe(4);
        } finally {
            f.controller.abort();
            await running;
            vi.useRealTimers();
        }
    });

    it.each(['deadline', 'invalidation'] as const)('keeps one failed-catalog retry and no idle reads after recovery by %s', async recovery => {
        const f = fixture();
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        f.failBoundary('current read');
        f.observe.mockResolvedValue({ observations: [], complete: true, nextEligibleAt: null });
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source });
        const catalogReads = () => f.executions.filter(id => id === 'automation.event.sources.list').length;
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(catalogReads()).toBe(1);
            expect(f.observe).not.toHaveBeenCalled();
            expect(f.execute.mock.calls.filter(([id]) => id === 'automation.event.sources.list')).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(999);
            expect(catalogReads()).toBe(1);
            expect(f.observe).not.toHaveBeenCalled();
            if (recovery === 'invalidation') for (let n = 0; n < 10; n += 1) f.invalidate({ reason: 'reconnect' });
            await vi.advanceTimersByTimeAsync(recovery === 'deadline' ? 1 : 0);
            expect(catalogReads()).toBe(2);
            expect(f.execute.mock.calls.filter(([id]) => id === 'automation.event.sources.list').at(-1)?.[1])
                .toMatchObject({ catalogRefresh: recovery === 'deadline' ? { kind: 'retry', retryAt: 2000 } : { kind: 'refresh' } });
            expect(f.observe).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(catalogReads()).toBe(2);
            expect(f.observe).toHaveBeenCalledOnce();
        } finally {
            f.controller.abort();
            await running;
            vi.useRealTimers();
        }
    });

    it.each([false, true])('publishes empty-source status once per transition across a minute of provider polls (first report fails: %s)', async firstReportFails => {
        const f = fixture();
        if (firstReportFails) f.failBoundary('source status');
        let clock = 1000;
        f.observe.mockImplementation(async () => ({ observations: [], complete: true, nextEligibleAt: clock + 1000,
            ...(clock >= 2000 ? { status: { state: 'observing' as const, code: 'none' as const } } : {}) }));
        let minuteFinished!: () => void;
        const minute = new Promise<void>(resolve => { minuteFinished = resolve; });
        let resume!: () => void;
        const sleep = async (delay: number, signal: AbortSignal) => {
            clock += delay;
            if (clock < 61_000) return;
            await new Promise<void>(resolve => {
                resume = resolve;
                signal.addEventListener('abort', () => resolve(), { once: true });
                minuteFinished();
            });
        };
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, now: () => clock, sleep });
        try {
            await minute;
            expect(f.observe).toHaveBeenCalledTimes(60);
            expect(f.executions.filter(id => id === 'automation.event.sources.list')).toHaveLength(1);
            const reports = () => f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source');
            expect(reports()).toHaveLength(firstReportFails ? 2 : 1);
            expect(reports()[0]?.[1]).toMatchObject({ state: 'observing', code: 'none', nextRetryAt: null, observedDelta: 0 });
            f.observe.mockResolvedValueOnce({ observations: [], complete: true, nextEligibleAt: null,
                status: { state: 'attention', code: 'credentialRevoked' } });
            resume();
            await vi.waitFor(() => expect(reports().at(-1)?.[1]).toMatchObject({ state: 'attention', code: 'credentialRevoked' }));
            expect(reports()).toHaveLength(firstReportFails ? 3 : 2);
        } finally { f.controller.abort(); await running; }
    });

    it('retries an unsettled admission on the source backoff even when its replay deadline is already due', async () => {
        // A replaying source (P03 QA health-observer) reports the stale probe
        // deadline it did not advance; a deferred-approval receipt is not an
        // admission. Without backoff this retried 1,691 times in ~30 minutes.
        const f = fixture();
        let clock = 1000;
        f.observe.mockImplementation(async () => ({ ...f.observation(), nextEligibleAt: clock }));
        f.setAdmissionResult({ kind: 'approval_request_created', artifactId: 'ask', actionId: 'automation.event.admit' });
        const admissions = () => f.executions.filter(id => id === 'automation.event.admit').length;
        const sleep = vi.fn(async (delay: number) => {
            clock += delay;
            if (clock >= 11_000 || admissions() >= 50) f.controller.abort();
        });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep, now: () => clock });
        // 10 s of source time at the adapter's 1 s retryAt.
        expect({ admissions: admissions(), clock: clock >= 11_000 }).toEqual({ admissions: 10, clock: true });
    });

    it.each(['catalog status', 'source status'] as const)('preserves finite observations and Event custody after a %s transport failure', async boundary => {
        const f = fixture();
        f.failBoundary(boundary);
        let clock = 1000;
        const resume: (() => void)[] = [];
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            resume.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        f.observe.mockImplementation(async () => ({ ...f.observation(),
            observations: [{ ...f.observation().observations[0]!, occurrenceId: `event-${clock}` }],
            nextEligibleAt: clock + 1000, status: { state: 'observing', code: 'none' } }));
        const source: typeof f.source = { ...f.source,
            retryAt: ({ definition, now }) => definition === undefined ? null : now + 1000 };
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source, sleep, now: () => clock });
        try {
            await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
            expect(sleep.mock.calls[0]?.[0]).toBe(1000);
            expect(f.runCount()).toBe(1);
            expect(f.save).toHaveBeenCalledOnce();
            const reportKind = boundary === 'catalog status' ? 'catalogReconciliation' : 'source';
            const failedReport = f.execute.mock.calls.findIndex(([id, value]) => id === 'automation.event.source.status.report' && value.kind === reportKind);
            await expect(f.execute.mock.results[failedReport]!.value).rejects.toBeInstanceOf(Error);
            clock = 2000;
            resume.shift()?.();
            await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
            expect(f.runCount()).toBe(2);
            expect(f.save).toHaveBeenCalledTimes(2);
            expect(sleep.mock.calls[1]?.[0]).toBe(1000);
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('counts an unsafe observation once while retry admission remains idempotent', async () => {
        const f = fixture();
        let clock = 1000;
        const resume: (() => void)[] = [];
        const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            resume.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        f.setSafe(false);
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep, now: () => clock });
        try {
            await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
            expect(f.save).not.toHaveBeenCalled();
            f.setSafe(true); clock = 2000; resume.shift()?.();
            await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
            const statuses = f.execute.mock.calls.filter(([id, value]) => id === 'automation.event.source.status.report' && value.kind === 'source');
            expect(statuses.map(([, value]) => value.observedDelta)).toEqual([1, 0]);
            expect(f.runCount()).toBe(1);
        } finally {
            f.controller.abort();
            await running;
        }
    });

    it('does not advance an unsettled or incomplete candidate', async () => {
        const f = fixture();
        f.setSafe(false);
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.save).not.toHaveBeenCalled();
        f.observe.mockResolvedValueOnce({ observations: [], checkpoint: 'cursor-2', complete: false, nextEligibleAt: 2000 });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.save).not.toHaveBeenCalled();
    });

    it.each(['observation', 'admission'] as const)('adopts reassignment after the finite cycle admitted during %s settles', async boundary => {
        const f = fixture();
        const reassign = () => {
            const d = definition();
            f.replace([{ ...d, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { ...materialization, machineId: 'other' } } }]);
        };
        if (boundary === 'observation') f.observe.mockImplementationOnce(async () => {
            reassign();
            return f.observation();
        });
        else {
            const execute = f.execute.getMockImplementation();
            if (execute === undefined) throw new Error('Missing host Action boundary');
            f.execute.mockImplementation(async (id, input) => {
                const result = await execute(id, input);
                if (id === 'automation.event.admit') reassign();
                return result;
            });
        }
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.runCount()).toBe(1);
        expect(f.save).toHaveBeenCalledOnce();
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' });
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('rejects mismatched transport revisions at finite cycle admission', async () => {
        const f = fixture();
        const pull = definition();
        f.replace([pull, { ...pull, triggerId: 'trigger-2', observationTransport: { kind: 'durablePush',
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', endpointMaterializationRef: materialization, observationStartsAt: 0 } }]);
        const execute = f.execute.getMockImplementation();
        if (execute === undefined) throw new Error('Missing host Action boundary');
        f.execute.mockImplementation(async (id, input) => {
            const transport = input.transport;
            return id === 'automation.event.sources.list' && typeof transport === 'object'
                && transport !== null && Reflect.get(transport, 'kind') === 'durablePush'
                ? { kind: 'page', revision: '3', definitions: [], nextCursor: null }
                : execute(id, input);
        });
        await runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once', transportKinds: ['checkpointedPull', 'durablePush'] });
        expect(f.observe).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
    });

    it('cancels admitted work before publication when the invocation is stopped', async () => {
        const f = fixture();
        f.observe.mockImplementationOnce(async () => {
            f.controller.abort();
            return f.observation();
        });
        await expect(runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, mode: 'once' })).rejects.toThrow();
        expect(f.runCount()).toBe(0);
        expect(f.save).not.toHaveBeenCalled();
    });

    it('joins an authenticated early wake with its parked source without a timer', async () => {
        const f = fixture();
        let notify: ((id?: string) => Promise<void>) | undefined;
        const sleep = vi.fn(async () => {});
        f.observe.mockImplementation(async () => ({ ...f.observation(), nextEligibleAt: null }));
        const running = runCheckpointedPluginEventObserverV1({ context: f.context, source: { ...f.source,
            subscribeWake(wake) { notify = wake; return { dispose() {} }; },
        }, sleep });
        await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
        await notify?.('source:1');
        expect(f.observe).toHaveBeenCalledTimes(2);
        expect(f.runCount()).toBe(1);
        expect(sleep).not.toHaveBeenCalled();
        f.controller.abort();
        await running;
    });

    it('waits on invalidation with zero timer/network work for a healthy empty catalog', async () => {
        const f = fixture();
        f.empty();
        const sleep = vi.fn(async () => {});
        const pending = runCheckpointedPluginEventObserverV1({ context: f.context, source: f.source, sleep });
        await vi.waitFor(() => expect(f.execute).toHaveBeenCalled());
        const readCount = f.execute.mock.calls.length;
        await Promise.resolve();
        expect(f.execute.mock.calls.length).toBe(readCount);
        expect(f.observe).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
        f.controller.abort();
        await pending;
    });
});
