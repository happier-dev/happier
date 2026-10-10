import type { PluginApi, PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { UsageCoachFinding } from '@happier-dev/plugin-sdk/actions';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

/**
 * A standalone author example: ordinary Resources and Actions carry findings.
 * These illustrative plugin-owned observations contain no host transcript or
 * path. A real integration supplies its own authorized, witnessed facts here.
 */
export const finding = {
    detectorId: 'repeated_file_reads',
    evidenceKey: 'same-selection-same-version',
    queryKey: 'plugin-local-read-evidence',
    period: { startMs: 1, endMs: 3 },
    asOfMs: 3,
    currentness: 'current',
    coverage: 'complete',
    severity: 'info',
    summaryCode: 'redundant_unchanged_read_observed',
    evidence: [
        { kind: 'file_read', id: 'read-one', observedAtMs: 1 },
        { kind: 'file_read', id: 'read-two', observedAtMs: 2 },
    ],
    measurements: [{ metric: 'unchanged_reads', value: 1, unit: 'count' }],
    remedy: null,
    action: null,
    state: { dismissed: false, snoozedUntilMs: null, applied: null },
} satisfies UsageCoachFinding;

export const manifest = {
    schemaVersion: 2,
    id: 'acme.live-resources',
    version: '1.0.0',
    displayName: 'Coach finding example',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    entrypoints: { daemon: './daemon.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    contributes: {
        resources: [{ id: 'findings', source: 'dynamic', kind: 'config', contentType: 'application/json' }],
        actions: [{
            id: 'inspect-finding', title: 'Inspect finding', scopes: ['global'], surfaces: ['cli'],
            execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
    },
} satisfies PluginManifest;

/** The ordinary qualified Action reference; it grants no execution authority. */
export const inspectAction = { pluginId: manifest.id, localId: 'inspect-finding' } satisfies PluginContributionRef;

export function activate(api: PluginApi): void {
    api.resources.registerDynamicResource('findings', {
        read({ signal }) {
            signal.throwIfAborted();
            return JSON.stringify(finding);
        },
        // This illustrative observation is immutable; integrations with changing
        // facts subscribe to their producer here and dispose that subscription.
        observe() { return { dispose() {} }; },
    });
    api.actions.register(inspectAction.localId, async (_input, context) => {
        context.signal.throwIfAborted();
        return finding;
    });
}
