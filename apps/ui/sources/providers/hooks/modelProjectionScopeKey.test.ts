import { describe, expect, it, vi } from 'vitest';
import { modelProjectionScopeKey } from './modelProjectionScopeKey';

describe('model projection query identity', () => {
    it('does not serialize admitted catalog bodies on repeated renders and changes identity with the admitted input', () => {
        const resources = Array.from({ length: 400 }, (_, id) => ({ id: `resource-${id}`, displayName: `Resource ${id}` }));
        const input = { enabled: true, machineId: 'machine', agentTargetKey: 'agent', selectionKey: '',
            favoriteKeys: [], teamCredentialResources: resources,
            accountScopeKey: 'home-account', credentialKey: 'credential' };
        const stringify = JSON.stringify;
        let catalogSerializations = 0;
        const serialization = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
            const result = stringify(...args);
            if (result?.includes('resource-399')) catalogSerializations += 1;
            return result;
        });
        try {
            const first = modelProjectionScopeKey(input);
            for (let i = 0; i < 22; i += 1) expect(modelProjectionScopeKey(input)).toBe(first);
            expect(catalogSerializations).toBe(0);
            const changed = resources.map((row, id) => id === 200 ? { ...row, displayName: 'Renamed' } : row);
            expect(modelProjectionScopeKey({ ...input, teamCredentialResources: changed })).not.toBe(first);
            // Refresh/currentness may recompose a gathered array while its admitted source bodies stay unchanged.
            const gathered = { ...input, teamCredentialCatalogSources: [resources] };
            const admittedKey = modelProjectionScopeKey(gathered);
            expect(modelProjectionScopeKey({ ...gathered, teamCredentialResources: [...resources] })).toBe(admittedKey);
            expect(modelProjectionScopeKey({ ...gathered, teamCredentialResources: changed,
                teamCredentialCatalogSources: [changed] })).not.toBe(admittedKey);
        } finally { serialization.mockRestore(); }
    });
});
