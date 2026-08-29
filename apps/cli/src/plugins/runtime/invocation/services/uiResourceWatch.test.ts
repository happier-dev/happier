import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import type { ImmutablePluginGenerationRecord } from '@/plugins/store/registry/generationStore';
import type { HostRuntimeLimitMeasurementSample } from '@/agent/runtime/state/runtimeLimitMeasurement';

import {
    createStablePluginResourcesOwner,
    type ResolveSessionResourceAccess,
    type StablePluginResourcesOwner,
} from './resources';
import { STABLE_PLUGIN_EVENT_QUEUE_LIMITS } from './events';
import { createStablePluginUiResourceWatchOwner } from './uiResourceWatch';

/**
 * The daemon half of the EU-4b invalidation transport.
 *
 * Every case runs the REAL producer (`createStablePluginResourcesOwner`, bound
 * exactly as a plugin receives it) into the REAL delivery owner. No test stub is
 * the only producer in any passing case: the only authored fake is the plugin's
 * own `read`/`observe`, which is the code a plugin genuinely supplies.
 */

const GENERATION = 'registry:eu4b';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function dynamicContribution(
    pluginId: string,
    localId: string,
    scope: 'global' | 'session' = 'global',
): ResolvedResourceContribution {
    return {
        provenance: 'external',
        source: { kind: 'archive' },
        pluginId,
        pluginRootPath: '/tmp/does-not-matter',
        manifestPath: '/tmp/does-not-matter/.happier-plugin/plugin.json',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'archive',
            locator: `${pluginId}.tgz`,
            trustPolicy: 'prompt',
            installPolicy: 'copy',
        },
        definition: {
            kindVersion: 1,
            id: localId,
            type: 'config',
            source: 'dynamic',
            contentType: 'application/json',
            ...(scope === 'global' ? {} : { scope }),
        },
    } as ResolvedResourceContribution;
}

async function packagedFixture(pluginId: string, localId: string, bytes = Buffer.from('packaged')) {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-ui-watch-'));
    roots.push(rootPath);
    await mkdir(join(rootPath, 'resources'));
    const relativePath = `resources/${localId}.txt`;
    await writeFile(join(rootPath, relativePath), bytes);
    const contribution = {
        provenance: 'external',
        source: { kind: 'archive' },
        pluginId,
        pluginRootPath: rootPath,
        manifestPath: join(rootPath, '.happier-plugin/plugin.json'),
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'archive',
            locator: `${pluginId}.tgz`,
            trustPolicy: 'prompt',
            installPolicy: 'copy',
        },
        definition: {
            kindVersion: 1,
            id: localId,
            type: 'prompt',
            path: relativePath,
            digest: digest(bytes),
            contentType: 'text/plain',
        },
    } as ResolvedResourceContribution;
    const file: ImmutablePluginGenerationRecord['files'][number] = {
        relativePath,
        byteLength: bytes.byteLength,
    };
    return { rootPath, contribution, file };
}

function registry(
    resources: readonly ResolvedResourceContribution[],
): Pick<ResolvedContributionRegistry, 'resources'> {
    return { resources };
}

type LiveProducer = Readonly<{
    set: (value: string) => void;
    notify: () => void;
    owner: StablePluginResourcesOwner;
}>;

async function createLiveResource(input?: Readonly<{
    packaged?: Awaited<ReturnType<typeof packagedFixture>>;
}>): Promise<LiveProducer> {
    let current = Buffer.from('A');
    let raise: (() => void) | null = null;
    const packaged = input?.packaged;
    const owner = await createStablePluginResourcesOwner({
        registry: registry([
            dynamicContribution('acme.alpha', 'live'),
            ...(packaged ? [packaged.contribution] : []),
        ]),
        generations: packaged
            ? new Map([[
                'acme.alpha',
                {
                    pluginId: 'acme.alpha',
                    immutableGenerationId: 'alpha-1',
                    rootPath: packaged.rootPath,
                    files: [packaged.file],
                },
            ]])
            : new Map(),
        immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
        dynamicProducers: [{
            pluginId: 'acme.alpha',
            localId: 'live',
            runtime: {
                read: () => new Uint8Array(current),
                observe: (notify: () => void) => {
                    raise = notify;
                    return { dispose: () => { raise = null; } };
                },
            },
        }],
    });
    return {
        owner,
        set: (value: string) => { current = Buffer.from(value); },
        notify: () => { raise?.(); },
    };
}

function createWatchOwner(
    resources: StablePluginResourcesOwner,
    options?: Readonly<{
        isPluginConsumerCurrent?: (pluginId: string) => boolean;
        record?: (sample: HostRuntimeLimitMeasurementSample) => void;
    }>,
) {
    return createStablePluginUiResourceWatchOwner({
        generation: GENERATION,
        resources,
        isPluginConsumerCurrent: options?.isPluginConsumerCurrent ?? (() => true),
        ...(options?.record ? { recordRuntimeLimitMeasurement: options.record } : {}),
    });
}

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return Object.freeze({
        promise,
        resolve(value: T): void { resolvePromise(value); },
    });
}

const CALLER = 'acme.alpha';

describe('daemon plugin UI resource invalidation transport (EU-4b)', () => {
    it('establishes a Session watch through one exact contextual Resource binding', async () => {
        const reads: string[] = [];
        const observes: string[] = [];
        const resolveSessionResourceAccess = vi.fn<ResolveSessionResourceAccess>(async (input) => ({
            accountId: input.accountId,
            throughCursor: 2,
            status: 'available',
        }));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: (options) => {
                        const sessionId = options.context.kind === 'session'
                            ? options.context.sessionId
                            : undefined;
                        if (!sessionId) throw new Error('missing context');
                        reads.push(sessionId);
                        return new Uint8Array(Buffer.from(sessionId));
                    },
                    observe: (_notify, options) => {
                        const sessionId = options.context.kind === 'session'
                            ? options.context.sessionId
                            : undefined;
                        if (!sessionId) throw new Error('missing context');
                        observes.push(sessionId);
                        return { dispose: () => undefined };
                    },
                },
            }],
            resolveSessionResourceAccess,
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: { v: 1, throughCursor: 1, entries: [] },
        });
        const watches = createWatchOwner(owner);
        const open = watches.open as unknown as (params: Readonly<{
            subscriptionId: string;
            callerPluginId: string;
            resourceId: string;
            context: { kind: 'session'; sessionId: string };
        }>) => Promise<Readonly<{ subscriptionId: string; digest: string }>>;

        const opened = await open({
            subscriptionId: 'session-a',
            callerPluginId: CALLER,
            resourceId: 'live',
            context: { kind: 'session', sessionId: 'session-a' },
        });

        expect(opened.digest).toBe(digest(Buffer.from('session-a')));
        expect(reads).toEqual(['session-a']);
        expect(observes).toEqual(['session-a']);
        expect(resolveSessionResourceAccess).toHaveBeenCalledWith({
            accountId: 'account-a',
            sessionId: 'session-a',
            signal: expect.any(AbortSignal),
        });
        watches.retire();
    });

    it('does not start a Session producer when exact server proof denies the watch', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const observe = vi.fn(() => ({ dispose: () => undefined }));
        const resolveSessionResourceAccess = vi.fn<ResolveSessionResourceAccess>(async (input) => ({
            accountId: input.accountId,
            throughCursor: 2,
            status: 'unavailable',
        }));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: { read, observe },
            }],
            resolveSessionResourceAccess,
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: { v: 1, throughCursor: 1, entries: [] },
        });
        const watches = createWatchOwner(owner);

        await expect(watches.open({
            subscriptionId: 'session-denied',
            callerPluginId: CALLER,
            resourceId: 'live',
            context: { kind: 'session', sessionId: 'session-a' },
        })).rejects.toMatchObject({ code: 'plugin_resource_session_access_unavailable' });

        expect(resolveSessionResourceAccess).toHaveBeenCalledWith({
            accountId: 'account-a',
            sessionId: 'session-a',
            signal: expect.any(AbortSignal),
        });
        expect(read).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        watches.retire();
    });

    it('does not start a Session producer after the watch becomes stale during exact binding', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const observe = vi.fn(() => ({ dispose: () => undefined }));
        const admission = deferred<Awaited<ReturnType<ResolveSessionResourceAccess>>>();
        const resolveSessionResourceAccess = vi.fn<ResolveSessionResourceAccess>(() => admission.promise);
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: { read, observe },
            }],
            resolveSessionResourceAccess,
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: { v: 1, throughCursor: 1, entries: [] },
        });
        const watches = createWatchOwner(owner);

        const outcome = watches.open({
            subscriptionId: 'session-stale',
            callerPluginId: CALLER,
            resourceId: 'live',
            context: { kind: 'session', sessionId: 'session-a' },
        }).then(
            () => null,
            (error: unknown) => error,
        );
        expect(resolveSessionResourceAccess).toHaveBeenCalledTimes(1);

        watches.retire();
        admission.resolve({ accountId: 'account-a', throughCursor: 2, status: 'available' });

        await expect(outcome).resolves.toMatchObject({ code: 'plugin_generation_stale' });
        expect(read).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
    });

    it('ends a parked Session watch when a newer witness permanently retires its context', async () => {
        const dispose = vi.fn();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(Buffer.from('session-a')),
                    observe: () => ({ dispose }),
                },
            }],
            resolveSessionResourceAccess: async (input) => ({
                accountId: input.accountId,
                throughCursor: 1,
                status: 'available',
            }),
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: { v: 1, throughCursor: 1, entries: [] },
        });
        const watches = createWatchOwner(owner);
        try {
            await watches.open({
                subscriptionId: 'session-retired',
                callerPluginId: CALLER,
                resourceId: 'live',
                context: { kind: 'session', sessionId: 'session-a' },
            });

            const parked = watches.next({
                callerPluginId: CALLER,
                subscriptionId: 'session-retired',
                waitMs: 1_000,
            });
            owner.applySessionAccessWitness({
                accountId: 'account-a',
                witness: {
                    v: 1,
                    throughCursor: 2,
                    entries: [{ sessionId: 'session-a', cursor: 2, status: 'unavailable' }],
                },
            });

            await expect(parked).resolves.toMatchObject({
                status: 'event',
                event: { kind: 'error', code: 'unavailable' },
            });
            expect(dispose).toHaveBeenCalledExactlyOnceWith();
            await expect(watches.next({
                callerPluginId: CALLER,
                subscriptionId: 'session-retired',
                waitMs: 1_000,
            })).rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
        } finally {
            watches.retire();
        }
    });

    it('preserves Session unavailability when retirement races the baseline read continuation', async () => {
        const baseline = deferred<Uint8Array>();
        const read = vi.fn(() => baseline.promise);
        const dispose = vi.fn();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'alpha-1']]),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read,
                    observe: () => ({ dispose }),
                },
            }],
            resolveSessionResourceAccess: async (input) => ({
                accountId: input.accountId,
                throughCursor: 1,
                status: 'available',
            }),
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: { v: 1, throughCursor: 1, entries: [] },
        });
        // The real Resource owner completes the read first. This narrowly
        // schedules retirement before the UI owner's `await` continuation.
        const resources: StablePluginResourcesOwner = Object.freeze({
            ...owner,
            async bindForResource(params) {
                const bound = await owner.bindForResource(params);
                return Object.freeze({
                    ...bound,
                    async read(
                        id: Parameters<typeof bound.read>[0],
                        options: Parameters<typeof bound.read>[1],
                    ) {
                        const snapshot = await bound.read(id, options);
                        owner.applySessionAccessWitness({
                            accountId: 'account-a',
                            witness: {
                                v: 1,
                                throughCursor: 2,
                                entries: [{ sessionId: 'session-a', cursor: 2, status: 'unavailable' }],
                            },
                        });
                        return snapshot;
                    },
                });
            },
        });
        const watches = createWatchOwner(resources);
        try {
            const opening = watches.open({
                subscriptionId: 'session-baseline-retired',
                callerPluginId: CALLER,
                resourceId: 'live',
                context: { kind: 'session', sessionId: 'session-a' },
            }).then(
                () => null,
                (error: unknown) => error,
            );
            await new Promise<void>((resolve) => { setImmediate(resolve); });
            expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                context: { kind: 'session', sessionId: 'session-a' },
            }));

            baseline.resolve(new Uint8Array(Buffer.from('session-a')));

            await expect(opening).resolves.toMatchObject({
                code: 'plugin_resource_session_access_unavailable',
            });
            expect(dispose).toHaveBeenCalledExactlyOnceWith();
            await expect(watches.next({
                callerPluginId: CALLER,
                subscriptionId: 'session-baseline-retired',
                waitMs: 1_000,
            })).rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
        } finally {
            watches.retire();
        }
    });

    it('delivers a real invalidation to a parked long poll when the resource changes', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);

        const opened = await watches.open({
            subscriptionId: 'sub-1',
            callerPluginId: CALLER,
            resourceId: 'live',
        });
        expect(opened.digest).toBe(digest(Buffer.from('A')));

        // The app is already parked in `next` when the change happens: the event
        // must reach the parked poll, not merely be queued for a later one.
        const parked = watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-1', waitMs: 2_000 });
        live.set('B');
        live.notify();

        await expect(parked).resolves.toEqual({
            status: 'event',
            event: {
                version: 1,
                subscriptionId: 'sub-1',
                kind: 'invalidated',
                digest: digest(Buffer.from('B')),
                diagnostics: undefined,
            },
        });

        expect(watches.close({ callerPluginId: CALLER, subscriptionId: 'sub-1' })).toBe(true);
        watches.retire();
    });

    it('delivers an invalidation raised before the poll arrived', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-2', callerPluginId: CALLER, resourceId: 'live' });

        live.set('B');
        live.notify();
        await new Promise((resolve) => { setTimeout(resolve, 10); });

        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-2', waitMs: 2_000 }))
            .resolves.toMatchObject({
                status: 'event',
                event: { kind: 'invalidated', digest: digest(Buffer.from('B')) },
            });
        watches.retire();
    });

    it('answers a poll with idle when nothing changed within its budget', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-3', callerPluginId: CALLER, resourceId: 'live' });

        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-3', waitMs: 1_000 }))
            .resolves.toEqual({ status: 'idle' });
        watches.retire();
    });

    it('bounds an unbounded producer through the existing broker queue instead of flooding the app', async () => {
        // The negative control the Gate names. The bound is the EXISTING
        // per-subscription broker queue limit, not a second limiter invented
        // here: a producer that outruns the app is refused at the broker.
        const samples: HostRuntimeLimitMeasurementSample[] = [];
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner, { record: (sample) => { samples.push(sample); } });
        await watches.open({ subscriptionId: 'sub-4', callerPluginId: CALLER, resourceId: 'live' });

        const flood = STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription + 64;
        for (let index = 0; index < flood; index += 1) {
            live.set(`payload-${index}`);
            live.notify();
            // Let the producer settlement and the broker drain run between
            // notifies so each change really reaches the delivery owner.
            await new Promise((resolve) => { setImmediate(resolve); });
            await new Promise((resolve) => { setImmediate(resolve); });
        }

        const queueSamples = samples.flatMap((sample) => (
            sample.family === 'plugin-event-broker' ? [sample] : []
        ));
        expect(queueSamples.length).toBeGreaterThan(0);
        // Admitted depth never exceeds the canonical per-subscription ceiling…
        const admittedHighWater = Math.max(...queueSamples
            .filter((sample) => !sample.backpressured)
            .map((sample) => sample.queuedItems));
        expect(admittedHighWater).toBeLessThanOrEqual(
            STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription,
        );
        // …because the broker REFUSED the overflow rather than growing for it.
        expect(queueSamples.some((sample) => sample.backpressured)).toBe(true);

        // Bounded, not silenced: the observer still converges, because the event
        // carries no payload and every delivery is a re-read instruction.
        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-4', waitMs: 1_000 }))
            .resolves.toMatchObject({ status: 'event' });
        watches.retire();
    });

    it('refuses to open a watch on a packaged resource in the same plugin', async () => {
        const packaged = await packagedFixture('acme.alpha', 'manual');
        const live = await createLiveResource({ packaged });
        const watches = createWatchOwner(live.owner);

        await expect(watches.open({
            subscriptionId: 'sub-5',
            callerPluginId: CALLER,
            resourceId: 'manual',
        })).rejects.toMatchObject({ code: 'plugin_resource_watch_unavailable' });

        // The dynamic sibling in the SAME plugin still opens, so the refusal is
        // the packaged arm's property and not an owner-wide failure.
        expect((await watches.open({
            subscriptionId: 'sub-5b',
            callerPluginId: CALLER,
            resourceId: 'live',
        })).digest).toBe(digest(Buffer.from('A')));
        watches.retire();
    });

    it('rejects an undeclared resource reference', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await expect(watches.open({
            subscriptionId: 'sub-5c',
            callerPluginId: CALLER,
            resourceId: 'not-declared',
        })).rejects.toMatchObject({ code: 'plugin_resource_not_found' });
        watches.retire();
    });

    it('rejects a poll for a subscription this plugin does not own', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-6', callerPluginId: CALLER, resourceId: 'live' });

        await expect(watches.next({ callerPluginId: 'other.plugin', subscriptionId: 'sub-6', waitMs: 1_000 }))
            .rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
        watches.retire();
    });

    it('releases every parked poll when the generation retires', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-7', callerPluginId: CALLER, resourceId: 'live' });

        const parked = watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-7', waitMs: 30_000 });
        watches.retire();

        await expect(parked).resolves.toMatchObject({
            status: 'event',
            event: { kind: 'error', code: 'stale_surface' },
        });
        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-7', waitMs: 1_000 }))
            .rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
    });

    it('retires a subscription whose plugin consumer is no longer current', async () => {
        const live = await createLiveResource();
        let current = true;
        const watches = createWatchOwner(live.owner, { isPluginConsumerCurrent: () => current });
        await watches.open({ subscriptionId: 'sub-8', callerPluginId: CALLER, resourceId: 'live' });

        current = false;
        live.set('B');
        live.notify();

        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-8', waitMs: 1_000 }))
            .resolves.toMatchObject({
                status: 'event',
                event: { kind: 'error', code: 'stale_surface' },
            });
        watches.retire();
    });

    it('releases the exact subscription when its transport aborts mid-poll', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-abort', callerPluginId: CALLER, resourceId: 'live' });

        const transport = new AbortController();
        const parked = watches.next({
            callerPluginId: CALLER,
            subscriptionId: 'sub-abort',
            waitMs: 30_000,
            signal: transport.signal,
        });
        transport.abort();
        await expect(parked).resolves.toEqual({ status: 'idle' });

        // The transport that owned this watch is gone and no other call will
        // necessarily arrive, so the exact watch is released now: the producer
        // stops observing and the subscription leaves the map instead of
        // waiting for a later open/next to reclaim it.
        expect(watches.close({ callerPluginId: CALLER, subscriptionId: 'sub-abort' })).toBe(false);
        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-abort' }))
            .rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
        watches.retire();
    });

    it('retains the subscription after an ordinary long-poll timeout', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-timeout', callerPluginId: CALLER, resourceId: 'live' });

        await expect(watches.next({
            callerPluginId: CALLER,
            subscriptionId: 'sub-timeout',
            waitMs: 1,
        })).resolves.toEqual({ status: 'idle' });

        // An idle response is ordinary long-poll rotation, not transport
        // retirement. The next request continues to own the same watch.
        expect(watches.close({ callerPluginId: CALLER, subscriptionId: 'sub-timeout' })).toBe(true);
        watches.retire();
    });

    it('releases the exact subscription when the poll starts with an already-aborted transport', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-pre-abort', callerPluginId: CALLER, resourceId: 'live' });

        const transport = new AbortController();
        transport.abort();
        await expect(watches.next({
            callerPluginId: CALLER,
            subscriptionId: 'sub-pre-abort',
            waitMs: 30_000,
            signal: transport.signal,
        })).resolves.toEqual({ status: 'idle' });

        expect(watches.close({ callerPluginId: CALLER, subscriptionId: 'sub-pre-abort' })).toBe(false);
        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-pre-abort' }))
            .rejects.toMatchObject({ code: 'plugin_resource_subscription_unknown' });
        watches.retire();
    });

    it('replaces the predecessor when the same subscription id re-opens after a reconnect', async () => {
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        await watches.open({ subscriptionId: 'sub-9', callerPluginId: CALLER, resourceId: 'live' });
        const parked = watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-9', waitMs: 30_000 });

        await watches.open({ subscriptionId: 'sub-9', callerPluginId: CALLER, resourceId: 'live' });

        // The predecessor's poll settles instead of hanging forever, so a
        // reconnecting app is never left holding a dead long poll.
        await expect(parked).resolves.toEqual({ status: 'idle' });
        watches.retire();
    });

    it('resynchronizes a reconnecting subscription that missed a change entirely', async () => {
        // The producer never notifies across the gap — the app was simply not
        // subscribed while the bytes changed. Establishment must still converge
        // on last-known-good plus a re-read rather than a silent stale view.
        const live = await createLiveResource();
        const watches = createWatchOwner(live.owner);
        const first = await watches.open({ subscriptionId: 'sub-10', callerPluginId: CALLER, resourceId: 'live' });
        expect(first.digest).toBe(digest(Buffer.from('A')));
        watches.close({ callerPluginId: CALLER, subscriptionId: 'sub-10' });

        live.set('B');

        await watches.open({ subscriptionId: 'sub-10', callerPluginId: CALLER, resourceId: 'live' });
        await expect(watches.next({ callerPluginId: CALLER, subscriptionId: 'sub-10', waitMs: 2_000 }))
            .resolves.toMatchObject({
                status: 'event',
                event: { kind: 'invalidated', digest: digest(Buffer.from('B')) },
            });
        watches.retire();
    });
});
