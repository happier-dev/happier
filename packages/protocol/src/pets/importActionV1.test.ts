import { describe, expect, it } from 'vitest';
import { PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1 } from '../actions/actionIdsPetsV1.js';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from './constants.js';
import type { AccountPetLibraryEntryV1 } from './accountLibrary.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { projectSettledApprovalExecution } from '../actions/executor/approvalResults.js';
import type { ActionExecuteResult } from '../actions/executor/types.js';

const manifest = { id: 'capy', displayName: 'Capy', description: 'A companion', spritesheetPath: 'spritesheet.webp' } as const;
const pet: AccountPetLibraryEntryV1 = { accountPetId: 'account-capy', packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
  manifest, spritesheetAssetRef: { assetId: 'asset', mediaType: 'image/webp', digest: 'sha256:a', sizeBytes: 3 },
  digest: 'sha256:a', sizeBytes: 3, createdAt: 1, updatedAt: 1, origin: { kind: 'manualImport' } };

describe('pet import confirmation projection', () => {
  it('accepts bundled packages through the import Action and keeps registry identities closed', async () => {
    const { PetImportInputV1Schema } = await import('./importActionV1.js');
    const source = { kind: 'package', package: { manifest, origin: { kind: 'manualImport' },
      spritesheet: { mediaType: 'image/webp', encoding: 'base64', data: 'AQID', sizeBytes: 3, digest: 'sha256:a' } } };
    expect(PetImportInputV1Schema.parse({ source })).toEqual({ source });
    expect(PetImportInputV1Schema.safeParse({ source: { kind: 'registry', sourceId: 'catalog', itemId: 'capy',
      spritesheetUrl: 'https://unexpected.test/pet' } }).success).toBe(false);
  });

  it('projects one set of import outcomes and derives Undo from the Account identity', async () => {
    const api = await import('./importActionV1.js');
    expect(api.readPetImportOutcomeV1({ ok: true, result: { pet } })).toEqual({ kind: 'added', pet,
      undo: { actionId: PET_DELETE_ACTION_ID_V1, input: { accountPetId: pet.accountPetId } } });
    expect(api.readPetImportOutcomeV1({ ok: true, result: { pet, reused: true } }))
      .toEqual({ kind: 'added', pet, reused: true });
    for (const [errorCode, kind] of [['quota_exceeded', 'library_full'], ['feature_disabled', 'pet_sync_off'],
      ['custom_pet_sync_requires_plaintext', 'pet_sync_off'], ['custom_pet_sync_unavailable', 'pet_sync_off'],
      ['invalid_request', 'could_not_add'], ['validation_failed', 'could_not_add']] as const) {
      expect(api.readPetImportOutcomeV1({ ok: false, errorCode }))
        .toMatchObject({ kind, errorCode });
    }
    expect(api.readPetImportOutcomeV1({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId: PET_IMPORT_ACTION_ID_V1 } })).toBeNull();
  });

  it('reads Added, Undo and refusals from the existing persisted approval execution', async () => {
    const { readPetImportOutcomeV1 } = await import('./importActionV1.js');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: PET_IMPORT_ACTION_ID_V1,
      actionArgs: { source: { kind: 'machine', machineId: 'machine', sourceKey: 'pet:generated' } },
      summary: 'Keep generated pet', decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'home', accountId: 'owner', actionId: PET_IMPORT_ACTION_ID_V1, requestId: 'keep-pet' } });
    const cases = [
      { exec: { ok: true, result: { pet } }, kind: 'added' },
      { exec: { ok: false, errorCode: 'quota_exceeded', error: 'quota_exceeded' }, kind: 'library_full' },
      { exec: { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled' }, kind: 'pet_sync_off' },
      { exec: { ok: false, errorCode: 'validation_failed', error: 'validation_failed' }, kind: 'could_not_add' },
    ] satisfies ReadonlyArray<{ exec: ActionExecuteResult; kind: string }>;
    for (const { exec, kind } of cases) {
      const settled = projectSettledApprovalExecution({ request, actionId: PET_IMPORT_ACTION_ID_V1,
        exec, dispatchEffectAttempted: true, executedAtMs: 3 });
      const recorded = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(settled.request)));
      expect(recorded.execution).toBeDefined();
      const outcome = readPetImportOutcomeV1(recorded.execution!);
      expect(outcome).toMatchObject({ kind });
      if (kind === 'added') expect(outcome).toMatchObject({ pet,
        undo: { actionId: PET_DELETE_ACTION_ID_V1, input: { accountPetId: pet.accountPetId } } });
    }
  });

  it('reads the existing approval preview and execution without accepting a failed check as preview evidence', async () => {
    const api = await import('./importActionV1.js');
    const request = { actionId: PET_IMPORT_ACTION_ID_V1,
      actionArgs: { source: { kind: 'machine', machineId: 'machine', sourceKey: 'pet:generated' } },
      preview: { validation: { ok: true, packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, manifest,
        spritesheetPath: 'spritesheet.webp', mediaType: 'image/webp', width: 1536, height: 1872, digest: 'sha256:a', sizeBytes: 3 },
        previewHandle: { kind: 'daemonSourceKey', sourceKey: 'pet:generated' } },
      execution: { ok: true as const, result: { pet } } };
    expect(api.readPetImportConfirmationV1(request)).toMatchObject({ actionId: PET_IMPORT_ACTION_ID_V1,
      input: request.actionArgs, preview: request.preview, outcome: { kind: 'added', pet } });
    expect(api.readPetImportConfirmationV1({ ...request, preview: { validation: { ok: false, issues: [{ code: 'spritesheet_invalid_dimensions', message: 'Invalid' }] } } })).toBeNull();
  });
});
