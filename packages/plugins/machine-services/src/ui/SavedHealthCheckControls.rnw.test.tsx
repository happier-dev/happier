// @vitest-environment jsdom
import { createElement as h, act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, type HealthCheckStatusV1 } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { SavedHealthCheckControls } from './SavedHealthCheckControls.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mounted: PluginUiTestkit | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

it.each([
    { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, kind: 'heartbeat', status: 'unknown', label: 'Waiting for first ping' },
    { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, kind: 'heartbeat', status: 'down', label: 'Heartbeat late' },
    { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, kind: 'heartbeat', status: 'up', label: 'Receiving pings' },
    { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, kind: 'http', status: 'unknown', label: 'Unknown' },
    { pluginId: 'example.custom-checks', kind: 'heartbeat', status: 'unknown', label: 'Unknown' },
] satisfies ReadonlyArray<{ pluginId: string; kind: string; status: HealthCheckStatusV1; label: string }>)
('presents $pluginId/$kind $status from the finite owner as $label', async ({ pluginId, kind, status, label }) => {
    const subject = { kind: 'environment' as const, environmentId: 'production' };
    const check = { checkId: 'saved-check', kind: { pluginId, localId: kind }, binding: { kind: 'healthCheck' as const },
        config: {}, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 };
    const calls: unknown[] = [];
    await act(async () => {
        mounted = await createPluginUiTestkit({
            identity: { instanceId: 'saved-health', mountNonce: 'saved-health-mount' },
            authorPlugin: { id: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, version: '0.0.0' },
            surface: defineUiSurface(context => h(SavedHealthCheckControls, { subject, checks: [check], signal: context.signal })),
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            // The host Action transport is the boundary; the real saved-check
            // selector, kind dispatch and rendered status remain under test.
            handlers: { executeAction: async ({ action, input }) => {
                calls.push({ action, input });
                if (typeof action === 'object' && action.localId === 'health/kinds') return [{
                    pluginId, id: kind, title: kind, action: `health/${kind}`,
                    configSchema: { type: 'object', additionalProperties: false, properties: {} },
                }];
                return { status, observedAt: 1000, evidence: { v: 1, items: [{
                    source: { kind: 'alert', label: kind }, author: { kind: 'process' }, text: 'Finite check observation',
                }] } };
            } },
        });
    });
    const page = mounted!;
    expect(calls).toEqual([]);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Check now' })); });
    await expect(page.getByText(label)).resolves.toBeDefined();
    expect(calls.at(-1)).toMatchObject({ action: { pluginId, localId: `health/${kind}` },
        input: { checkId: check.checkId } });
});
