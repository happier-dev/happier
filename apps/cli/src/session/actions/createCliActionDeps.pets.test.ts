import '@happier-dev/protocol/actions/actionSettings';
import { describe, expect, it } from 'vitest';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { PET_IMPORT_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import { DaemonPetValidatePackageResponseV1Schema, PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol/pets/daemonRpc';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import { readPetImportConfirmationV1 } from '@happier-dev/protocol/pets/importActionV1';
import { createCliActionDeps } from './createCliActionDeps';

const input = { source: { kind: 'machine', machineId: 'machine-1',
    packagePath: '/home/happier/pet-runs/PET-LIVE-OWNER-1118-existing-gemini-luna' } } as const;
const context = { surface: 'agent', authority: 'account_automation', serverId: 'home-1' } as const;

function prepare(response: unknown) {
    const calls: Array<{ method: string; request: unknown }> = [];
    const deps = createCliActionDeps({ token: 'account-token', sessionId: 'session', mode: 'plain', ctx: null,
        serverId: 'home-1', serverHttpBaseUrl: 'http://home-1.test', machineActionDirectTargetTransport: {
            machineId: input.source.machineId,
            // Machine RPC is the external boundary. Keep the real host factory and approval owner.
            invoke: async (method, request) => { calls.push({ method, request }); return response; },
        } });
    return { calls, review: prepareApprovalRequest({ deps, actionId: PET_IMPORT_ACTION_ID_V1, input,
        actionArgs: input, context }) };
}

describe('Agent pet import approval through CLI host dependencies', () => {
    it('prepares a renderable preview and opaque source before asking to import a Machine package', async () => {
        const response = DaemonPetValidatePackageResponseV1Schema.def.options[0].parse({ ok: true, validation: { ok: true,
            packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, manifest: { id: 'gemini-luna', displayName: 'Luna',
                description: 'A companion', spritesheetPath: 'spritesheet.webp' }, spritesheetPath: 'spritesheet.webp',
            mediaType: 'image/webp', width: 1536, height: 1872, digest: 'sha256:fixture', sizeBytes: 3 },
            previewHandle: { kind: 'daemonSourceKey', sourceKey: 'pet:validated-luna' } });
        const { calls, review } = prepare(response);
        const prepared = await review;
        if (!prepared || 'ok' in prepared) throw new Error('Expected an import review');
        expect(readPetImportConfirmationV1({ actionId: PET_IMPORT_ACTION_ID_V1, ...prepared })).toEqual({
            actionId: PET_IMPORT_ACTION_ID_V1,
            input: { source: { kind: 'machine', machineId: input.source.machineId, sourceKey: 'pet:validated-luna' } },
            preview: { validation: response.validation, previewHandle: response.previewHandle },
            outcome: null,
        });
        // One validation read per review, with no import effect before the person's approval.
        expect(calls).toEqual([{ method: PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE,
            request: { packagePath: input.source.packagePath, strict: true } }]);
    });

    it('refuses an invalid package with validation details before creating an import review', async () => {
        const response = DaemonPetValidatePackageResponseV1Schema.def.options[0].parse({ ok: true,
            validation: { ok: false, issues: [{ code: 'manifest_invalid_shape', message: 'Invalid manifest' }] } });
        const { calls, review } = prepare(response);
        expect(await review).toEqual({ ok: false, errorCode: 'validation_failed', error: 'validation_failed',
            details: { validation: response.validation } });
        expect(calls.map(call => call.method)).toEqual([PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE]);
    });
});
