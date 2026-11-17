import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createRegistryHostV1 } from '@happier-dev/protocol/registries/registryHostV1';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries/registrySourcesV1';
import type { RegistryHttpV1 } from '@happier-dev/protocol/registries/formats/registryFormatAdapterV1';
import type { AccountPetCreateRequestV1, AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import { PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import type { ServerFetch } from '@/sync/http/client';
import { createUiPetActionExecute } from './petActionDeps';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { readPetImportOutcomeV1 } from '@happier-dev/protocol/pets/importActionV1';

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
            if (!init?.method) return new Response(JSON.stringify({ ok: true, pets: [] }));
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

    it('imports browser registry bytes through a Machine carrier and preserves needs_machine without an Account write', async () => {
        const writes: unknown[] = [];
        const request: ServerFetch = async (_path, init) => {
            if (!init?.method) return new Response(JSON.stringify({ ok: true, pets: [] }));
            writes.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ ok: true, pet }));
        };
        const browserHttp: RegistryHttpV1 = { getText: unused, getJson: unused, getBytes: unused };
        const missingCarrier = createRegistryHostV1({ host: 'web', http: browserHttp,
            readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
        const input = { source: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' } };
        const unavailable = createActionExecutor({ petAction: createUiPetActionExecute(account(request), async () => missingCarrier) });
        expect(await unavailable.execute(PET_IMPORT_ACTION_ID_V1, input, context)).toMatchObject({
            ok: false, errorCode: 'needs_machine', details: { registryStatus: { state: 'needs_machine' } },
        });
        expect(writes).toEqual([]);

        const daemonHttp: RegistryHttpV1 = { getText: unused,
            getJson: async () => ({ ok: true, fetchedAt: 1, value: { pet: {
                id: 'winter', displayName: 'Winter', description: 'A companion',
                spritesheetUrl: 'https://codex-pets.net/assets/winter.webp',
            } } }),
            getBytes: async () => ({ ok: true, fetchedAt: 1, value: new Uint8Array([0, 128, 255]) }),
        };
        const daemon = createRegistryHostV1({ host: 'node', http: daemonHttp,
            readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
        const browser = createRegistryHostV1({ host: 'web', http: browserHttp,
            readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
            // The daemon transport is the process boundary; both registry hosts and adapters stay real.
            daemonFetch: async request => JSON.parse(JSON.stringify(await daemon.fetchRequest(request))),
        });
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), async () => browser) });
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context)).toMatchObject({
            ok: true, result: { pet: { accountPetId: pet.accountPetId } },
        });
        expect(writes).toEqual([expect.objectContaining({ manifest: pet.manifest,
            origin: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' },
            spritesheet: expect.objectContaining({ encoding: 'base64', data: 'AID/', sizeBytes: 3, mediaType: 'image/webp' }),
        })]);
    });

    it('reuses an authenticated registry-origin match before acquiring bytes or creating another pet', async () => {
        let creates = 0;
        let reads = 0;
        const request: ServerFetch = async (_path, init) => {
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
            if (init?.method === 'POST') { creates++; return new Response(JSON.stringify({ ok: true, pet })); }
            reads++;
            return new Response(JSON.stringify({ ok: true, pets: [pet] }));
        };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), unused) });
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1,
            { source: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' } }, context))
            .toMatchObject({ ok: true, result: { pet, reused: true } });
        expect(creates).toBe(0);
        expect(reads).toBe(1);
    });

    it('lets Account admission reuse bundled packages without a library preflight', async () => {
        const bundled: AccountPetCreateRequestV1 = { manifest: pet.manifest, origin: { kind: 'manualImport' },
            spritesheet: { mediaType: 'image/webp', encoding: 'base64', data: 'AQID', sizeBytes: 3, digest: pet.digest } };
        let creates = 0;
        let reads = 0;
        const request: ServerFetch = async (path, init) => {
            expect(path).toBe('/v1/account/pets');
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
            if (init?.method === 'POST') {
                creates++;
                expect(JSON.parse(String(init.body))).toEqual(bundled);
                return new Response(JSON.stringify({ ok: true, pet, ...(creates > 1 ? { reused: true } : {}) }));
            }
            reads++;
            return new Response(JSON.stringify({ ok: true, pets: [] }));
        };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), unused) });
        const input = { source: { kind: 'package', package: bundled } };
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context))
            .toMatchObject({ ok: true, result: { pet: { accountPetId: pet.accountPetId } } });
        expect(creates).toBe(1);
        expect(reads).toBe(0);
        const reused = await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context);
        expect(readPetImportOutcomeV1(reused)).toEqual({ kind: 'added', pet, reused: true });
        expect(creates).toBe(2);
        expect(reads).toBe(0);
    });

    it('preserves package quota and feature refusals from Account admission', async () => {
        const bundled: AccountPetCreateRequestV1 = { manifest: pet.manifest, origin: { kind: 'manualImport' },
            spritesheet: { mediaType: 'image/webp', encoding: 'base64', data: 'AQID', sizeBytes: 3, digest: pet.digest } };
        let creates = 0;
        let unavailable = false;
        const request: ServerFetch = async () => {
            creates++;
            return new Response(JSON.stringify(unavailable
                ? { ok: false, errorCode: 'feature_disabled', error: 'Pet sync disabled' }
                : { ok: false, errorCode: 'quota_exceeded', error: 'Library full' }));
        };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), unused) });
        const input = { source: { kind: 'package', package: bundled } };
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context))
            .toMatchObject({ ok: false, errorCode: 'quota_exceeded' });
        unavailable = true;
        expect(await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context))
            .toMatchObject({ ok: false, errorCode: 'feature_disabled' });
        expect(creates).toBe(2);
    });

    it.each(['package', 'machine'] as const)('forwards validated server reuse without an Undo deletion for %s', async sourceKind => {
        const normalized = { ...pet, manifest: { ...pet.manifest, spriteVersionNumber: 2 as const } };
        const bundled: AccountPetCreateRequestV1 = { manifest: pet.manifest, origin: { kind: 'manualImport' },
            spritesheet: { mediaType: 'image/webp', encoding: 'base64', data: 'AQID', sizeBytes: 3, digest: pet.digest } };
        const request: ServerFetch = async (_path, init) => new Response(JSON.stringify(init?.method === 'POST'
            ? { ok: true, pet: normalized, reused: true } : { ok: true, pets: [] }));
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request), unused) });
        if (sourceKind === 'machine') boundary.machineRpc.mockResolvedValueOnce({ ok: true, target: 'account', account: { ok: true, pet: normalized, reused: true } });
        const source = sourceKind === 'package' ? { kind: 'package' as const, package: bundled }
            : { kind: 'machine' as const, machineId: 'machine', packagePath: '/pets/winter' };
        const result = await execute.execute(PET_IMPORT_ACTION_ID_V1, { source }, context);
        expect(readPetImportOutcomeV1(result)).toEqual({ kind: 'added', pet: normalized, reused: true });
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
