import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createHealthCheckSourceInstanceIdV1, type HealthCheckResultV1 } from '@happier-dev/plugin-sdk';
import { plugin } from '../../../../../../packages/plugins/machine-services/src/manifest';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import * as configured from './configuredHealthResults';

describe('configured saved health public Action bridge', () => {
    it('keeps an old checkpoint available when the same result is read again', async () => {
        const kv = { list: async () => ({ items: [{ key: 'health:saved', version: 1, value: { current: {
            v: 1,
            members: [{ automationId: 'automation', triggerId: 'trigger', triggerRevision: 1, sourceSelectorId: 'selector' }],
            checks: [{ checkId: 'site', result: { status: 'down', observedAt: 1000,
                evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' }, author: { kind: 'process' }, text: 'Check failed.' }] } } }],
        } } }] }) };
        const signal = new AbortController().signal;
        const first = await configured.readConfiguredHealthResults(kv, signal, { results: new Map(), preceding: false });
        expect(first.results.get(configured.configuredHealthResultKey('automation', 'trigger'))?.state.kind).toBe('available');
        const second = await configured.readConfiguredHealthResults(kv, signal, first);
        expect(second.results.get(configured.configuredHealthResultKey('automation', 'trigger'))?.state)
            .toMatchObject({ kind: 'available', checks: [{ checkId: 'site', result: { status: 'down', observedAt: 1000 } }] });
        expect(second).toBe(first);
    });
    it.each([503, '503'])('reads additive stored cause facts while rejecting an invalid known status (%s)', async httpStatus => {
        const page = await configured.readConfiguredHealthResults({ list: async () => ({ items: [{ key: 'health:saved', version: 1,
            value: { current: { v: 1, futureProjection: true,
                members: [{ automationId: 'automation', triggerId: 'trigger', triggerRevision: 1, sourceSelectorId: 'selector' }],
                checks: [{ checkId: 'site', result: { status: 'down', observedAt: 1000,
                    cause: { kind: 'http', vantage: 'outside', observerMachineId: 'observer', httpStatus, futureDiagnostic: true },
                    evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' }, author: { kind: 'process' }, text: 'Check failed.' }] } } }],
            } },
        }] }) }, new AbortController().signal, { results: new Map(), preceding: false });
        const state = page.results.get(configured.configuredHealthResultKey('automation', 'trigger'))?.state;
        if (typeof httpStatus === 'number') {
            expect(state).toMatchObject({ kind: 'available', checks: [{ result: { cause: { httpStatus: 503 } } }] });
            expect(JSON.stringify(state)).not.toContain('futureDiagnostic');
        } else expect(state).toBeUndefined();
    });
    it.each([true, false])('runs the saved selector through the public Action front door when approval is %s', async approved => {
        let probes = 0;
        let confirmations = 0;
        const expected = { status: 'down', observedAt: 1000, latencyMs: 12,
            cause: { kind: 'http', vantage: 'outside', observerMachineId: 'observer', httpStatus: 503, expectStatus: 200 },
            evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' }, author: { kind: 'process' }, text: 'HTTP check failed.' }] } } satisfies HealthCheckResultV1;
        const parsed = ingestPluginManifestV2(plugin.manifest);
        if (!parsed.ok) throw new Error('Expected bundled health plugin manifest');
        const catalog = parsed.manifest.contributes.healthCheckKinds.map(kind => ({ ...kind, pluginId: plugin.manifest.id }));
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
            healthChecks: { listKinds: async () => catalog,
                readSource: async () => { throw new Error('Unexpected saved source lookup'); },
                manageHeartbeat: async () => { throw new Error('Unexpected heartbeat mutation'); },
                setup: async () => { throw new Error('Unexpected health setup'); },
                read: async ({ sourceInstanceId, checkIds }) => {
                expect(sourceInstanceId).toBe(createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId: 'production' }));
                expect(checkIds).toEqual(['site']);
                probes++;
                return [{ checkId: 'site', result: expected }];
            } },
        } });
        try {
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                // Permit catalog discovery, then apply the person's finite-run decision.
                presentUserActionConfirmation: async () => ++confirmations === 1 || approved,
                // Only contributed code/finite observation is a substituted process boundary.
                invokeContributedAction: async request => ({ ok: true, result: await kit.invokeAction(request.action.localId, normalizeStrictJsonValue(request.input)) }),
            }));
            const execute = createFrontDoorUiActionExecutor({ ...executor, execute: (id, input, context) => executor.execute(id, input, {
                ...context, authority: 'present_user', runtimeAccountId: 'account', actionCaller: { kind: 'host' },
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'action.invoke': { approvalRequiredSurfaces: ['ui'] } } }),
            }) }, { serverId: 'home' });
            const operation = configured.checkNowConfiguredHealthCheck({ serverId: 'home', subject: { kind: 'environment', environmentId: 'production' },
                check: { checkId: 'site', kind: { pluginId: plugin.manifest.id, localId: 'http' } },
                signal: new AbortController().signal }, execute);
            if (approved) expect(await operation).toEqual(expected);
            else await expect(operation).rejects.toMatchObject({ code: 'approval_canceled' });
            expect(probes).toBe(approved ? 1 : 0);
        } finally { await kit.dispose(); }
    });
});
