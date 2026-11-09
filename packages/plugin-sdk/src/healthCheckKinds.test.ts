import { expect, it } from 'vitest';
import { createPluginTestkit } from './testing/host.js';
import { createExternalHealthKind } from '../examples/public-authoring/healthChecks.js';
import { parsePluginManifest } from './manifest.js';
import { assertDefinePluginCatalogFamilyPolicyClosure, DEFINE_PLUGIN_FAMILY_POLICY_V2 } from './definePlugin.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { HealthCheckSubjectV1 } from './healthCheckKinds.js';

it('admits and invokes an external author kind for both subjects through the public Action owner', async () => {
    const observed: HealthCheckSubjectV1[] = [];
    const plugin = createExternalHealthKind(async (subject, expected) => {
        observed.push(subject);
        return { status: expected === 'ready' ? 'up' : 'down', observedAt: 1,
            evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'External observation' },
                author: { kind: 'process' }, text: 'Finite observation completed.' }] } };
    });
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.healthCheckKinds).toMatchObject([{ id: 'endpoint', action: 'observe-health' }]);
    expect(() => assertDefinePluginCatalogFamilyPolicyClosure(PLUGIN_CONTRIBUTION_CATALOG_V2, DEFINE_PLUGIN_FAMILY_POLICY_V2)).not.toThrow();
    const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    try {
        const subjects: HealthCheckSubjectV1[] = [
            { kind: 'environment', environmentId: 'env-1' },
            { kind: 'machineService', machineId: 'machine-1', serviceId: 'service-1' },
        ];
        for (const subject of subjects) {
            await expect(testkit.invokeAction('observe-health', { subject, config: { expected: 'ready' } })).resolves.toMatchObject({ status: 'up' });
        }
        expect(observed).toHaveLength(2);
        await expect(testkit.invokeAction('observe-health', { subject: { kind: 'machineService', machineId: 'machine-1' }, config: { expected: 'ready' } })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(observed).toHaveLength(2);
    } finally {
        await testkit.dispose();
    }
});
