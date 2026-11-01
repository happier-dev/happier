import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MarketplaceRegistryProfileRequiredResultV1Schema } from '@happier-dev/protocol/marketplace';
import { projectPluginMutationResult } from './pluginMarketplaceModel';

describe('plugin install Action result adaptation', () => {
    it('keeps the requested update identity and the daemon committed result', () => {
        const change = { kind: 'committed', pluginId: 'acme.plugin', desiredGeneration: 'new', appliedGeneration: 'new', pendingSurfaces: [] };
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: true, kind: 'plugins_install', outcome: 'applied', change });
        expect(projectPluginMutationResult(emitted, 'update', 'acme.plugin').kind).toBe('committed');
    });

    it('preserves an ambiguous daemon result for the existing exact-target reconciler', () => {
        const change = { kind: 'outcomeUnknown', pluginId: 'acme.plugin', expectedCandidate: 'candidate-2' };
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed', change });
        expect(projectPluginMutationResult(emitted, 'install', 'acme.plugin').kind).toBe('outcomeUnknown');
    });

    it('preserves the installing Home’s registry selection requirement', () => {
        const change = MarketplaceRegistryProfileRequiredResultV1Schema.parse({ kind: 'registryProfileRequired',
            registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: null });
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed', change });
        expect(projectPluginMutationResult(emitted, 'install', 'acme.plugin').registryRequirement).toEqual({
            registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: null,
        });
    });

    it('reads the daemon\'s safe failure message for the exact requested plugin and nothing else', () => {
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const message = 'Plugin acme.plugin Settings group "general" field "enabled" has an invalid default.';
        const emitted = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed',
            change: { kind: 'failed', code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', message } });
        expect(projectPluginMutationResult(emitted, 'install', 'acme.plugin').failureReason).toBe(message);
        const mismatched = outputSchema.parse({ ok: true, kind: 'plugins_install', outcome: 'applied',
            change: { kind: 'committed', pluginId: 'other.plugin', desiredGeneration: 'new', appliedGeneration: 'new', pendingSurfaces: [] } });
        expect(projectPluginMutationResult(mismatched, 'install', 'acme.plugin').kind).toBeNull();
        const generic = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed' });
        expect(projectPluginMutationResult(generic, 'install', 'acme.plugin').failureReason).toBeNull();
        const blank = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed',
            change: { kind: 'failed', code: 'x', message: '   ' } });
        expect(projectPluginMutationResult(blank, 'install', 'acme.plugin').failureReason).toBeNull();
    });
});
