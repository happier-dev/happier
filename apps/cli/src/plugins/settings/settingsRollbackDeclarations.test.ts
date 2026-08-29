import { describe, expect, it } from 'vitest';

import {
    derivePluginSettingsRollbackDeclarations,
    parseRetainedScopeFieldIds,
} from './settingsRollbackDeclarations';
import type { PluginRollbackRetentionRecord } from '../store/registry/generationStore';

function retention(params: Partial<PluginRollbackRetentionRecord>): PluginRollbackRetentionRecord {
    return {
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-prev',
        retainedAtMs: 1,
        byteAvailability: 'available',
        pluginVersion: '1.0.0',
        distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin' },
        ...params,
    } as PluginRollbackRetentionRecord;
}

const retainedManifest = {
    contributes: {
        settings: [
            {
                id: 'general',
                version: 1,
                title: { key: 'settings.general', fallback: 'General' },
                target: { kind: 'plugin' },
                scope: 'account',
                fields: [
                    { id: 'legacyMode', title: 'Legacy mode', schema: { type: 'string' } },
                    { id: 'apiToken', title: 'Token', schema: { type: 'string' }, secret: true },
                ],
                presentation: { sections: [], subagentSections: [] },
            },
            {
                id: 'daemon-general',
                version: 1,
                title: { key: 'settings.daemon', fallback: 'Daemon' },
                target: { kind: 'plugin' },
                scope: 'daemon',
                fields: [
                    { id: 'pollMs', title: 'Poll', schema: { type: 'integer', minimum: 100 } },
                ],
                presentation: { sections: [], subagentSections: [] },
            },
        ],
    },
};

describe('plugin settings rollback declaration derivation', () => {
    it('derives one supported declaration per scope with secret field ids excluded', async () => {
        const declarations = await derivePluginSettingsRollbackDeclarations({
            revision: { rollbackRetention: [retention({})] },
            readRetainedManifest: async () => retainedManifest,
        });
        const account = declarations.get('acme.plugin')?.get('account');
        expect(account).toEqual({
            generation: 'generation-prev',
            supported: true,
            fieldIds: ['legacyMode'],
        });
        expect(declarations.get('acme.plugin')?.get('daemon')).toEqual({
            generation: 'generation-prev',
            supported: true,
            fieldIds: ['pollMs'],
        });
    });

    it('derives no rollback ownership when the retained artifact bytes are no longer available', async () => {
        const declarations = await derivePluginSettingsRollbackDeclarations({
            revision: { rollbackRetention: [retention({ byteAvailability: 'evicted' })] },
            readRetainedManifest: async () => {
                throw new Error('retired bytes must not be read');
            },
        });
        expect(declarations.size).toBe(0);
    });

    it('derives no rollback ownership when the retained generation declares nothing usable', async () => {
        const declarations = await derivePluginSettingsRollbackDeclarations({
            revision: { rollbackRetention: [retention({})] },
            readRetainedManifest: async () => ({ contributes: {} }),
        });
        expect(declarations.size).toBe(0);
    });

    it('treats an unreadable or malformed available artifact as unknown instead of retirement', async () => {
        await expect(derivePluginSettingsRollbackDeclarations({
            revision: { rollbackRetention: [retention({})] },
            readRetainedManifest: async () => {
                throw new Error('retained bytes unreadable');
            },
        })).rejects.toThrow('retained bytes unreadable');
        await expect(derivePluginSettingsRollbackDeclarations({
            revision: { rollbackRetention: [retention({})] },
            readRetainedManifest: async () => ({ contributes: { settings: [{}] } }),
        })).rejects.toThrow();
    });

    it('rejects duplicate rollback authority rather than synthesizing an unsupported declaration', async () => {
        await expect(derivePluginSettingsRollbackDeclarations({
            revision: {
                rollbackRetention: [
                    retention({ immutableGenerationId: 'generation-a' }),
                    retention({ immutableGenerationId: 'generation-b' }),
                ],
            },
            readRetainedManifest: async () => retainedManifest,
        })).rejects.toThrow("Multiple rollback generations claim 'acme.plugin' Settings scope 'account'");
    });

    it('extracts per-scope non-secret ids from a retained manifest projection', () => {
        const scopes = parseRetainedScopeFieldIds({ pluginId: 'acme.plugin', rawManifest: retainedManifest });
        expect(scopes?.get('account')).toEqual(['legacyMode']);
        expect(scopes?.get('daemon')).toEqual(['pollMs']);
        expect(() => parseRetainedScopeFieldIds({ pluginId: 'acme.plugin', rawManifest: {} })).toThrow();
    });
});
