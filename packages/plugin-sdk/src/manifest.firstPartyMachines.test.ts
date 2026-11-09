import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parsePluginManifest } from './manifest.js';
import { PluginConnectedAccountDescriptorContributionV2Schema } from './manifest/connectedAccountDescriptors.js';

const machinePackages = readdirSync(new URL('../../plugins/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('machine-'))
    .map(entry => entry.name).sort();
// Source modules are fixture collection, like static imports; transform them before test execution.
const machineManifests = await Promise.all(machinePackages.map(async packageName => {
    const source: { PLUGIN_MANIFEST: unknown } = await import(`../../plugins/${packageName}/src/manifest.ts`);
    return source.PLUGIN_MANIFEST;
}));

describe('first-party machine account manifest contract', () => {
    it('places every first-party Machine provisioner account under Cloud machines', () => {
        let provisionerAccounts = 0;
        for (const manifest of machineManifests) {
            // Admission, not the workspace name, identifies provisioner contributions.
            const parsed = parsePluginManifest(manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            if (parsed.manifest.contributes.machineProvisioners.length === 0) continue;
            for (const contribution of parsed.manifest.contributes.connectedAccountDescriptors ?? []) {
                const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse(contribution);
                provisionerAccounts += 1;
                expect(descriptor.ui?.category, `${parsed.manifest.id}/${descriptor.id}`).toBe('cloud-machines');
            }
        }
        expect(provisionerAccounts).toBeGreaterThan(0);
    });
});
