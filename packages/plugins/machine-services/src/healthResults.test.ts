import { afterEach, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { AccountKvService } from '@happier-dev/plugin-sdk/storage';
import { plugin } from './manifest.js';
import { retainHealthResult, readHealthResultProjections } from './healthResultProjection.js';
import { activate as activateAccount } from './accountRuntime.js';
import { HEALTH_RESULTS_ACTION_ID } from './actionIds.js';
import { createHealthCheckSourceAdapter } from './healthObserver.js';

afterEach(() => vi.useRealTimers());

it('reads retained health history through the public Account Action without probing, preserving native continuation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.UTC(2026, 10, 15);
    vi.setSystemTime(now);
    const evidence = { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'HTTP' },
        author: { kind: 'process' as const }, text: 'Retained observation' }] };
    const first = retainHealthResult(undefined, 'site', { status: 'up', observedAt: now - 1000, evidence });
    const retained = retainHealthResult(first, 'site', { status: 'down', observedAt: now, evidence });
    const projection = { v: 1, members: [{ automationId: 'automation', triggerId: 'trigger', triggerRevision: 4,
        sourceSelectorId: 'selector' }], checks: [retained] };
    const source = { sourceInstanceId: 'health:production', subject: { kind: 'environment' as const, environmentId: 'production' } };
    const reads: Array<string | undefined> = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected probe or storage mutation'); };
    const kv = { get: unused, set: unused, delete: unused, transaction: unused,
        async list(options) {
            reads.push(options?.cursor);
            expect(options?.prefix).toBe('health:');
            return options?.cursor ? { items: [] } : { items: [
                { key: 'health:deleted', version: 1, deleted: true as const },
                { key: 'health:invalid', version: 1, value: { current: { ...projection, checks: [{}] } } },
                { key: 'health:saved', version: 2, value: { source, current: { ...projection, futureField: true } } },
            ], nextCursor: 'native-next' };
        },
    } satisfies AccountKvService;
    // The SDK host owns Account mode/envelope handling. This boundary supplies its decoded KV rows.
    const services = { storage: { account: { kv, collection() { throw new Error('Unexpected Collection read'); } },
        get ephemeral() { throw new Error('Unexpected ephemeral read'); },
        get daemonSession() { throw new Error('Unexpected daemon storage'); },
        get daemon() { throw new Error('Unexpected daemon database'); } } } satisfies PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: plugin.manifest,
        module: { activate: plugin.activate, activateAccount }, services });
    try {
        const result = await kit.invokeAction(HEALTH_RESULTS_ACTION_ID, {}, { surface: 'agent' });
        expect(result).toEqual({ items: [{ key: 'health:saved', source, projection }], nextCursor: 'native-next' });
        expect(await kit.invokeAction(HEALTH_RESULTS_ACTION_ID, { cursor: 'native-next' }, { surface: 'mcp' })).toEqual({ items: [] });
        vi.setSystemTime(now + 31 * 86_400_000);
        expect(await kit.invokeAction(HEALTH_RESULTS_ACTION_ID, {}, { surface: 'cli' })).toMatchObject({
            items: [{ projection: { checks: [{ result: retained.result,
                history: { days: [], uptimePercent: null }, recentResults: [] }] } }],
        });
        expect(reads).toEqual([undefined, 'native-next', undefined]);
    } finally { await kit.dispose(); }
});

it('projects legacy unknown-only daily buckets without treating them as downtime', async () => {
    const now = Date.UTC(2026, 10, 28, 10);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const saved = retainHealthResult(undefined, 'checkout', { status: 'unknown', observedAt: now, evidence: {
        v: 1, items: [{ source: { kind: 'alert', label: 'Checkout' }, author: { kind: 'process' }, text: 'No requests' }],
    } });
    const day = saved.history!.days[0]!;
    const page = await readHealthResultProjections({ async list() {
        return { items: [{ key: 'health:checkout', version: 1, value: { current: { v: 1, members: [],
            checks: [{ ...saved, history: { ...saved.history!, uptimePercent: 0, days: [{ ...day, uptimePercent: 0 }] } }],
        } } }] };
    } }, { signal: new AbortController().signal });
    expect(page.items[0]?.projection.checks[0]?.history).toMatchObject({
        uptimePercent: null, days: [{ unknown: 1, uptimePercent: null }],
    });
});

it('does not disclose a retained page after cancellation and keeps Account read failures typed', async () => {
    const controller = new AbortController();
    const canceled = readHealthResultProjections({ async list({ signal } = {}) {
        expect(signal).toBe(controller.signal);
        controller.abort();
        return { items: [] };
    } }, { signal: controller.signal });
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    const failure = Object.assign(new Error('Account KV unavailable'), { code: 'account_data_unavailable' });
    await expect(readHealthResultProjections({ async list() { throw failure; } },
        { signal: new AbortController().signal })).rejects.toBe(failure);
});

it('opens no observation subscriptions until a health check needs their events', () => {
    const host = { subscribe: vi.fn(() => ({ dispose() {} })) };
    const pluginEvents = { subscribe: vi.fn(() => ({ dispose() {} })), publish: vi.fn() };
    const adapter = createHealthCheckSourceAdapter(Date.now, host, pluginEvents);
    const subscription = adapter.subscribeWake!(async () => {});
    try {
        expect([host.subscribe.mock.calls.length, pluginEvents.subscribe.mock.calls.length]).toEqual([0, 0]);
    } finally {
        subscription.dispose();
    }
});
