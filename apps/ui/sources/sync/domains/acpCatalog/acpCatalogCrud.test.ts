import { describe, expect, it } from 'vitest';

import {
    deleteAcpBackendDefinitionV1,
    upsertAcpBackendDefinitionV1,
} from './acpCatalogCrud';

const baseSettings = {
    v: 2 as const,
    backends: [
        {
            id: 'backend-1',
            name: 'backend-1',
            title: 'Backend 1',
            command: 'kiro-cli',
            args: ['acp'],
            env: {},
            transportProfile: 'kiro' as const,
            capabilities: {
                supportsLoadSession: true,
                supportsModes: 'yes' as const,
                supportsModels: 'yes' as const,
                supportsConfigOptions: 'unknown' as const,
                promptImageSupport: 'yes' as const,
            },
            createdAt: 1,
            updatedAt: 1,
        },
    ],
};

describe('acpCatalogCrud', () => {
    it('upserts a backend and rejects duplicate backend names', () => {
        const next = upsertAcpBackendDefinitionV1(baseSettings, {
            id: 'backend-2',
            name: 'backend-2',
            title: 'Backend 2',
            command: 'custom-cli',
            args: ['acp'],
            env: {},
            transportProfile: 'generic',
            capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
            },
            createdAt: 2,
            updatedAt: 2,
        });

        expect(next.backends.map((backend) => backend.id)).toEqual(['backend-1', 'backend-2']);
        expect(() => upsertAcpBackendDefinitionV1(next, {
            ...next.backends[1]!,
            id: 'backend-3',
            name: 'backend-1',
        })).toThrow('Duplicate ACP backend name');
    });

    it('deletes a backend definition', () => {
        const next = deleteAcpBackendDefinitionV1(baseSettings, 'backend-1');
        expect(next.backends).toEqual([]);
    });
});
