import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2, readCurrentReleaseLessDeclarationV1, readReleaseLessDeclarationsV2 } from './currentDeclaration';

// The retained Account census has 490 publishers of the same plugin.
describe('Account-scoped declaration storage', () => {
    it('stores one body for 490 Machines, preserves offline selection and divergent publishers', () => {
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
            schemaVersion: 2, id: 'com.example.dedupe', version: '1.0.0', displayName: 'Dedupe',
            engines: { happier: '^1.0.0' }, contributes: {}, metadata: { body: 'unique-body-marker' },
        }));
        let stored: unknown = declaration;
        for (let index = 0; index < 490; index++) stored = mergeReleaseLessDeclarationV2({ stored, declaration,
            publisher: { machineId: `machine-${index}`, installationId: `installation-${index}` } }).stored;
        expect(JSON.stringify(stored).split('unique-body-marker').length - 1).toBe(1);
        expect(readReleaseLessDeclarationsV2(stored, declaration.manifest.id).machines).toHaveLength(490);
        const read = (value: unknown, machineId?: string) => readCurrentReleaseLessDeclarationV1({
            desiredVersion: null, releaseLessDeclaration: value,
        }, declaration.manifest.id, machineId ? { machineId } : undefined);
        expect(read(stored)?.manifest).toEqual(declaration.manifest);
        expect(read(stored, 'machine-489')?.manifest).toEqual(declaration.manifest);
        const divergent = createReleaseLessDeclarationV1({ ...declaration.manifest, version: '2.0.0' });
        stored = mergeReleaseLessDeclarationV2({ stored, declaration: divergent,
            publisher: { machineId: 'machine-489', installationId: 'installation-489' } }).stored;
        expect(read(stored)).toBeNull();
        expect(read(stored, 'machine-489')?.manifest).toEqual(divergent.manifest);
        expect(read(stored, 'machine-0')?.manifest).toEqual(declaration.manifest);
        expect(JSON.stringify(stored).split('unique-body-marker').length - 1).toBe(2);
        expect(read(stored, 'another-account-machine')).toBeNull();
        expect(read(declaration)?.manifest).toEqual(declaration.manifest);
    });
});
