import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createRegistryHostV1 } from '@happier-dev/protocol/registries/registryHostV1';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries/registrySourcesV1';
import type { RegistryHttpV1 } from '@happier-dev/protocol/registries/formats/registryFormatAdapterV1';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import { PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import type { ServerFetch } from '@/sync/http/client';
import { createUiPetActionExecute } from './petActionDeps';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';

// Machine RPC is the external daemon transport; the Action and Account request path stay real.
const boundary = vi.hoisted(() => ({ machineRpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.machineRpc }));

const pet: AccountPetLibraryEntryV1 = {
    accountPetId: 'account-winter', packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: { id: 'winter', displayName: 'Winter', description: 'A companion', spritesheetPath: 'spritesheet.webp' },
    spritesheetAssetRef: { assetId: 'asset', mediaType: 'image/webp', digest: 'sha256:server', sizeBytes: 3 },
    digest: 'sha256:server', sizeBytes: 3, createdAt: 1, updatedAt: 1,
    origin: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' },
};
const context = { surface: 'ui' as const, authority: 'present_user' as const };
const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };

function account(request: ServerFetch) {
    return { serverId: 'home', credentials: { token: 'token' },
        assertCurrent: () => {}, request };
}

describe('pet Actions through their import and Account boundaries', () => {
    it('prepares the existing pending import with daemon preview evidence and an opaque locator', async () => {
        const { createUiPetImportPrepare } = await import('./petActionDeps');
        const validation = { ok: true, packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, manifest: pet.manifest,
            spritesheetPath: pet.manifest.spritesheetPath, mediaType: 'image/webp', width: 1536, height: 1872,
            digest: pet.digest, sizeBytes: pet.sizeBytes };
        boundary.machineRpc.mockResolvedValueOnce({ ok: true, validation,
            previewHandle: { kind: 'daemonSourceKey', sourceKey: 'pet:validated' } });
        const input = { source: { kind: 'machine', machineId: 'machine', packagePath: '/run/final' } };
        const prepared = await prepareApprovalRequest({ actionId: PET_IMPORT_ACTION_ID_V1, input, actionArgs: input,
            context, deps: { preparePetImport: createUiPetImportPrepare(account(unused)) } });
        expect(prepared).toEqual({ actionArgs: { source: { kind: 'machine', machineId: 'machine', sourceKey: 'pet:validated' } },
            preview: { validation, previewHandle: { kind: 'daemonSourceKey', sourceKey: 'pet:validated' } } });
    });

    it('acquires a registry pet on a native host without a Machine, returns its Account identity, and Undo deletes it', async () => {
        const effects: { path: string; method?: string; body?: unknown }[] = [];
        const http: RegistryHttpV1 = { getText: unused,
            getJson: async () => ({ ok: true, fetchedAt: 1, value: { pet: {
                id: 'winter', displayName: 'Winter', description: 'A companion', spritesheetUrl: 'https://codex-pets.net/assets/winter.webp',
            } } }),
            getBytes: async () => ({ ok: true, fetchedAt: 1, value: new Uint8Array([1, 2, 3]) }),
        };
        const registry = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
        const request: ServerFetch = async (path, init) => {
            effects.push({ path, method: init?.method, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
            return new Response(JSON.stringify(init?.method === 'DELETE'
                ? { ok: true, accountPetId: pet.accountPetId, deletedAt: 2 } : { ok: true, pet }));
        };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), async () => registry) });
        const imported = await execute.execute(PET_IMPORT_ACTION_ID_V1,
            { source: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' } }, context);
        expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true, result: { pet: { accountPetId: 'account-winter' } } });
        expect(effects[0]).toMatchObject({ path: '/v1/account/pets', method: 'POST', body: {
            origin: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' },
            spritesheet: { data: 'AQID', encoding: 'base64', sizeBytes: 3,
                digest: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' },
        } });
        expect(await execute.execute(PET_DELETE_ACTION_ID_V1, { accountPetId: pet.accountPetId }, context))
            .toMatchObject({ ok: true, result: { accountPetId: pet.accountPetId, deletedAt: 2 } });
        expect(effects[1]).toMatchObject({ path: '/v1/account/pets/account-winter', method: 'DELETE' });
    });

    it('imports a Machine package through the existing daemon importer and preserves server refusals', async () => {
        boundary.machineRpc.mockResolvedValueOnce({ ok: true, target: 'account', account: { ok: true, pet } });
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(unused), unused) });
        const imported = await execute.execute(PET_IMPORT_ACTION_ID_V1,
            { source: { kind: 'machine', machineId: 'machine', packagePath: '/pets/winter' } }, context);
        expect(imported, JSON.stringify(imported))
            .toMatchObject({ ok: true, result: { pet: { accountPetId: pet.accountPetId } } });
        boundary.machineRpc.mockResolvedValueOnce({ ok: false, errorCode: 'quota_exceeded', error: 'Library full' });
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1,
            { source: { kind: 'machine', machineId: 'machine', packagePath: '/pets/winter' } }, context))
            .toMatchObject({ ok: false, errorCode: 'quota_exceeded' });
        boundary.machineRpc.mockResolvedValueOnce({ ok: false, errorCode: 'validation_failed', error: 'Bad sheet',
            validation: { ok: false, issues: [{ code: 'spritesheet_invalid_dimensions', message: 'Invalid dimensions' }] } });
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1,
            { source: { kind: 'machine', machineId: 'machine', packagePath: '/pets/winter' } }, context))
            .toMatchObject({ ok: false, errorCode: 'validation_failed', details: {
                validation: { issues: [{ code: 'spritesheet_invalid_dimensions' }] },
            } });
    });
});
