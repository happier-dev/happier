import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { deriveEd25519KeyPair } from '@happier-dev/protocol/crypto/ed25519';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetV1Schema, ManagedMachinePresetAcquireRoutingInputV1Schema,
    MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { prepareOriginalAccountManagedPresetAcquire, prepareOriginalAccountWorkflowPlacement } from './managedPresetOrigination';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

afterEach(() => vi.restoreAllMocks());

it('binds an authored saved preset address to its current revision before root signing', async () => {
    const homeId = 'srv_saved_preset';
    const controller = { machineId: 'saved-controller', installationId: 'saved-installation' };
    const controllerAccess = { custodian: { accountId: 'owner' },
        installationPublicKey: encodeBase64(deriveEd25519KeyPair(new Uint8Array(32).fill(19)).publicKey, 'base64url') };
    const preset = ManagedMachinePresetV1Schema.parse({ id: 'saved-preset', homeId, revision: 9,
        owner: { kind: 'account', accountId: 'owner' }, controller,
        contentEncryptionMode: 'plain', content: { t: 'plain', v: {} }, recipients: [] });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines/managed/actions/get') return { status: 404, data: { code: 'managed_not_found' } };
        if (path === '/v1/machines/presets/get') return { status: 200, data: { kind: 'found', preset } };
        expect(path).toBe(MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1);
        expect(ManagedMachinePresetAcquireRoutingInputV1Schema.parse(body)).toEqual({ homeId, id: preset.id, revision: 9, controller });
        return { status: 200, data: { kind: 'resolved', controller, controllerAccess } };
    });
    const project = { machineId: 'authored-machine', directory: '~/repo',
        sessionPlacement: { kind: 'preset' as const, homeId, presetId: preset.id } };
    const result = await prepareOriginalAccountWorkflowPlacement({
        start: WorkflowRunStartRequestV1Schema.parse({ runId: '11111111-1111-4111-8111-111111111111',
            source: { kind: 'saved', definitionId: 'definition', revision: { headerVersion: 1, bodyVersion: 1 } } }),
        project, accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        credentials: { token: 'requester-account', encryption: null }, serverHttpBaseUrl: 'https://saved-home.test',
    });
    const acquisition = { selection: { kind: 'preset', homeId, id: preset.id, revision: 9 }, controller };
    expect(result).toEqual({ kind: 'bound', input: acquisition, controllerAccess,
        workflowPreparation: { project, acquisition }, retainedRoot: undefined });
});

it.each(['bound', 'unbound', 'withdrawn'] as const)('resolves exact preset custody through the Home without Machine inventory (%s)', async state => {
    const homeId = 'srv_exact_preset';
    const controller = { machineId: 'company-controller', installationId: 'company-installation' };
    const controllerAccess = { custodian: { accountId: 'company' },
        installationPublicKey: encodeBase64(deriveEd25519KeyPair(new Uint8Array(32).fill(17)).publicKey, 'base64url') };
    const preset = ManagedMachinePresetV1Schema.parse({ id: 'exact-preset', homeId, revision: 3,
        owner: { kind: 'team', teamId: 'company-team' }, controller, teamAcquireDelegated: true,
        contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40).fill(1), 'base64') }, recipients: [] });
    const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: preset.id, revision: 3 },
        ...(state === 'unbound' ? {} : { controller }), retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        presetContentOverride: { content: preset.content } });
    const paths: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === '/v1/machines/presets/get') return { status: 200, data: { kind: 'found', preset } };
        expect(path).toBe(MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1);
        expect(ManagedMachinePresetAcquireRoutingInputV1Schema.parse(body)).toEqual({ homeId, id: preset.id, revision: 3, controller });
        return { status: 200, data: state === 'withdrawn' ? { kind: 'refused', code: 'preset_not_found' }
            : { kind: 'resolved', controller, controllerAccess } };
    });
    const result = await prepareOriginalAccountManagedPresetAcquire({ input, requestId: 'exact-create',
        credentials: { token: 'requester-account', encryption: null }, serverHttpBaseUrl: 'https://exact-home.test' });
    expect(result).toEqual(state === 'withdrawn' ? { kind: 'refused', code: 'preset_not_found' }
        : { kind: 'bound', input: { ...input, controller }, controllerAccess });
    expect(paths).toEqual(['/v1/machines/presets/get', MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1]);
});
