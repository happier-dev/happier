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
import { admitAccountPetEncryptedCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// Machine RPC is the external daemon transport; the Action and Account request path stay real.
const boundary = vi.hoisted(() => ({ machineRpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.machineRpc }));
// test-policy-boundary: image decoding is the platform codec (canvas/Skia); the protocol pixel rules stay real upstream.
vi.mock('@/sync/domains/pets/inspectPetAtlasImage', () => ({
    inspectPetAtlasImage: async () => ({ width: 1536, height: 1872, hasAlpha: true }),
}));

const pet: AccountPetLibraryEntryV1 = {
    accountPetId: 'account-winter', packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: { id: 'winter', displayName: 'Winter', description: 'A companion', spritesheetPath: 'spritesheet.webp' },
    spritesheetAssetRef: { assetId: 'asset', mediaType: 'image/webp', digest: 'sha256:server', sizeBytes: 3 },
    digest: 'sha256:server', sizeBytes: 3, createdAt: 1, updatedAt: 1,
    origin: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' },
};
const context = { surface: 'ui' as const, authority: 'present_user' as const };
const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };

const legacySecret = new Uint8Array(32).fill(21);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x18, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

/** The Home answers Account currentness for the credential's mode; other paths reach the test's request. */
function account(request: ServerFetch, credentials: AuthCredentials = { token: 'token' }) {
    const currentness = 'secret' in credentials
        ? createLegacyAccountEncryptionCurrentnessFixture({ secret: legacySecret })
        : createPlainAccountEncryptionCurrentnessFixture();
    const home: ServerFetch = async (path, init, options) => path === '/v1/account/encryption/currentness'
        ? Response.json(currentness) : request(path, init, options);
    return { serverId: 'home', credentials, assertCurrent: () => {}, request: home };
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

    it('validates and seals a registry pet for an E2EE Account, then reuses it by origin from the opened library', async () => {
        const credentials: AuthCredentials = { token: 'token', secret: encodeBase64(legacySecret, 'base64url') };
        const http: RegistryHttpV1 = { getText: unused,
            getJson: async () => ({ ok: true, fetchedAt: 1, value: { pet: {
                id: 'winter', displayName: 'Winter', description: 'A companion', spritesheetUrl: 'https://codex-pets.net/assets/winter.webp',
            } } }),
            getBytes: async () => ({ ok: true, fetchedAt: 1, value: WEBP }),
        };
        const registry = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
        const stored: unknown[] = [];
        const posted: unknown[] = [];
        const request: ServerFetch = async (_path, init) => {
            if (!init?.method) return Response.json({ ok: true, pets: stored });
            const body = JSON.parse(String(init.body));
            posted.push(body);
            const admitted = admitAccountPetEncryptedCreateRequestV1(body);
            if (!admitted) return Response.json({ ok: false, errorCode: 'account_encryption_mode_mismatch', error: 'mismatch' }, { status: 400 });
            const entry = { accountPetId: 'sealed-winter', packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, content: admitted.content,
                spritesheetAssetRef: { assetId: 'asset', digest: admitted.spritesheetDigest, sizeBytes: admitted.spritesheetCiphertext.byteLength },
                digest: 'sha256:ciphertext', sizeBytes: 1, createdAt: 1, updatedAt: 1 };
            stored.push(entry);
            return Response.json({ ok: true, pet: entry }, { status: 201 });
        };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request, credentials), async () => registry) });
        const input = { source: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' } };

        const imported = await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context);
        expect(readPetImportOutcomeV1(imported)).toMatchObject({ kind: 'added', pet: { accountPetId: 'sealed-winter',
            manifest: { displayName: 'Winter' }, origin: { kind: 'registry', itemId: 'winter' } } });
        expect(JSON.stringify(posted)).not.toContain('Winter');
        expect(JSON.stringify(posted)).not.toContain('codex-pets');

        expect(readPetImportOutcomeV1(await execute.execute(PET_IMPORT_ACTION_ID_V1, input, context)))
            .toMatchObject({ kind: 'added', reused: true, pet: { accountPetId: 'sealed-winter' } });
        expect(posted).toHaveLength(1);
    });

    it('refuses an invalid package for an E2EE Account on this client with could_not_add details', async () => {
        const credentials: AuthCredentials = { token: 'token', secret: encodeBase64(legacySecret, 'base64url') };
        const posts: unknown[] = [];
        const request: ServerFetch = async (_path, init) => { posts.push(init?.body); return Response.json({ ok: true, pets: [] }); };
        const execute = createActionExecutor({ petAction: createUiPetActionExecute(account(request, credentials), unused) });
        const bundled: AccountPetCreateRequestV1 = { manifest: pet.manifest, origin: { kind: 'manualImport' },
            spritesheet: { mediaType: 'image/webp', encoding: 'base64', data: encodeBase64(WEBP), sizeBytes: WEBP.byteLength, digest: 'sha256:wrong' } };

        const result = await execute.execute(PET_IMPORT_ACTION_ID_V1, { source: { kind: 'package', package: bundled } }, context);
        expect(readPetImportOutcomeV1(result)).toEqual({ kind: 'could_not_add', errorCode: 'invalid_request',
            details: { reason: 'spritesheet_digest' } });
        expect(posts).toEqual([]);
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
