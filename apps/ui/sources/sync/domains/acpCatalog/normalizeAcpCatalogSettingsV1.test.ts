import { describe, expect, it } from 'vitest';

import { normalizeAcpCatalogSettingsV1 } from './normalizeAcpCatalogSettingsV1';

describe('normalizeAcpCatalogSettingsV1', () => {
    it('strips released auth-parser and transport-profile carriers from v2 settings', () => {
        const normalized = normalizeAcpCatalogSettingsV1({
            v: 2,
            backends: [{
                id: 'legacy-acp',
                name: 'legacy-acp',
                title: 'Legacy ACP',
                command: 'legacy-acp',
                args: [],
                env: {},
                auth: {
                    support: 'status_only',
                    statusCommand: ['whoami'],
                    parser: 'kiroWhoamiJson',
                },
                transportProfile: 'kiro',
                capabilities: {},
                createdAt: 1,
                updatedAt: 2,
            }],
        });

        expect(normalized.backends[0]).not.toHaveProperty('transportProfile');
        expect(normalized.backends[0]?.auth).not.toHaveProperty('statusCommand');
        expect(normalized.backends[0]?.auth).not.toHaveProperty('parser');
    });

    it('fails closed to an empty v2 backend-only catalog for legacy preset-based data', () => {
        const normalized = normalizeAcpCatalogSettingsV1({
            v: 1,
            backends: [
                {
                    id: 'backend-1',
                    name: 'backend-1',
                    title: 'Backend 1',
                    command: 'kiro-cli',
                    args: ['acp'],
                    env: {},
                    transportProfile: 'kiro',
                    capabilities: {
                        supportsLoadSession: true,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'yes',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            presets: [],
        });

        expect(normalized).toEqual({ v: 2, backends: [] });
    });
});
