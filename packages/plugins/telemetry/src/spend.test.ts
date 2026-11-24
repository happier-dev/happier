import { describe, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TELEMETRY_METRICS_READ_ACTION_ID_V1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1, type DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { localCaptureBackground } from './background.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

const catalog: UsageModelPriceCatalog = { v: 1, models: { model: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
    provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1000, revision: 'spend-owner-revision', fetchStatus: 'ready' } };
const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2_000_000 };
const genAi: DatabaseCaptureCostMetadataV1 = { provider: 'openai', modelId: 'model', requestedModel: 'model',
    operation: 'chat', tokens, tokenCategories: tokens, reportedCost: { amount: 4.25, currency: 'EUR' } };

async function fixture() {
    const sqlite = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(sqlite.db);
    // SQLite and the SDK's host Action/admission services are process boundaries;
    // the plugin, retained reads, Usage estimator and health evaluator remain real.
    const storage = { daemon: { database: async () => sqlite.db } } as unknown as PluginServices['storage'];
    let overrides: UsageModelPriceOverridesV1 = {};
    let enabled = true;
    let prices = 0;
    const capabilities = () => ({ metrics: false, appLlmCost: enabled, exceptions: false });
    const actions = { execute: async (id: string) => {
        if (id === 'settings.get') return { anchor: 'usage.modelPrices', value: overrides };
        if (id === 'usage.prices.get') { prices += 1; return catalog; }
        throw new Error(`Unexpected host Action: ${id}`);
    } } as unknown as PluginServices['actions'];
    const deploymentDatabases = { admitTelemetryRead: async () => ({
        environment: { serverId: 'home', environmentId: 'env', revision: 1 }, collectorMachineId: 'collector',
        capabilities: capabilities(),
    }) } as unknown as PluginServices['deploymentDatabases'];
    const deploymentTelemetry = { readAssignments: async () => [{ environmentId: 'env', tokenHash: null,
        capabilities: capabilities() }] } as unknown as PluginServices['deploymentTelemetry'];
    const config = { environmentId: 'env', serviceName: 'api', windowMs: 1000,
        measure: { kind: 'spend', costMode: 'api_equivalent' }, threshold: { operator: 'above', value: 10 } };
    const healthChecks = { readSource: async () => ({ v: 1, subject: { kind: 'environment', environmentId: 'env' },
        checks: [{ checkId: 'spend', kind: { pluginId: 'happier.telemetry', localId: 'key-flow' },
            binding: { kind: 'healthCheck' }, config, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] })
    } as unknown as PluginServices['healthChecks'];
    const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
    const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
        services: { storage, actions, deploymentDatabases, deploymentTelemetry, healthChecks } });
    await lease.runtime.store.write([{ id: 'call', kind: 'span', source: 'otlp', worktree: 'environment:env', at: 1000,
        serviceName: 'api', genAi }, { id: 'sibling', kind: 'span', source: 'otlp', worktree: 'environment:other', at: 1000,
        serviceName: 'api', genAi }]);
    return { sqlite, lease, host, setOverrides(value: UsageModelPriceOverridesV1) { overrides = value; },
        disable() { enabled = false; }, priceCalls: () => prices,
        read: () => host.invokeAction(databaseActionLocalIdV1(TELEMETRY_METRICS_READ_ACTION_ID_V1), {
            serverId: 'home', environmentId: 'env', serviceName: 'api', since: 1000, until: 2000,
            measure: { kind: 'spend', costMode: 'api_equivalent' },
        }),
        check: () => host.invokeAction(databaseActionLocalIdV1(TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1), {
            sourceInstanceId: 'saved', checkId: 'spend',
        }, { chosenMachine: { machineId: 'collector', installationId: 'installed' },
            requesterAccount: { accountId: 'check-owner' } }),
        async close() { vi.useRealTimers(); await host.dispose(); await lease.release(); sqlite.close(); },
    };
}

describe('App spend on the collector', () => {
    it('prices a saved check with its owning Account and leaves viewer pricing outside the collector', async () => {
        const f = await fixture();
        try {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2000);
            await expect(f.read()).rejects.toMatchObject({ code: 'unsupported_action' });
            expect(f.priceCalls()).toBe(0);
            expect(await f.check()).toMatchObject({ status: 'up', measurements: { value: 6, unit: 'USD' } });
            f.setOverrides({ model: { kind: 'rates', inputUsdPerMillion: 10, outputUsdPerMillion: 20 } });
            const failed = await f.check();
            expect(failed).toMatchObject({ status: 'degraded', measurements: { value: 30, unit: 'USD' },
                cause: { reason: 'threshold_exceeded' }, evidence: { items: expect.arrayContaining([
                    expect.objectContaining({ text: expect.stringMatching(/API-equivalent estimate.*check-owner.*spend-owner-revision/) }),
                ]) } });
            expect(f.priceCalls()).toBe(2); // One catalog read for each saved check evaluation.
        } finally { await f.close(); }
    });

    it('keeps unknown prices and lost observations inconclusive, and performs no pricing when app cost is disabled', async () => {
        const f = await fixture();
        try {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2000);
            await f.lease.runtime.store.write([{ id: 'unknown', kind: 'span', source: 'otlp', worktree: 'environment:env', at: 1100,
                serviceName: 'api', genAi: { ...genAi, modelId: 'unpriced', requestedModel: 'unpriced', reportedCost: null } }]);
            expect(await f.check()).toMatchObject({ status: 'unknown', measurements: { completeness: 'unknown',
                reasons: expect.arrayContaining(['unpriced_calls']) } });
            f.lease.runtime.recordCoverage('environment:env', 'capture_write_failed');
            expect(await f.check()).toMatchObject({ status: 'unknown', measurements: { completeness: 'unknown',
                reasons: expect.arrayContaining(['capture_coverage_lost']) } });
            f.disable();
            const before = f.priceCalls();
            expect(await f.check()).toMatchObject({ status: 'unknown', measurements: { reasons: ['app_llm_cost_disabled'] } });
            expect(f.priceCalls()).toBe(before);
        } finally { await f.close(); }
    });
});
