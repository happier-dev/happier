import { describe, expect, it } from 'vitest';

import { normalizeAcpCatalogSettingsV1 } from './normalizeAcpCatalogSettingsV1';

describe('normalizeAcpCatalogSettingsV1', () => {
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
