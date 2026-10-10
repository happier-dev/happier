import { describe, expect, it } from 'vitest';
import {
  AccountEncryptionMigrateSessionDraftsDirectiveSchema,
  NewSessionDraftDocumentV2Schema,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { buildAccountEncryptionSessionDraftsDirective } from './buildAccountEncryptionSessionDraftsDirective';
import { ProjectOpenDraftDocumentV2Schema } from '@happier-dev/protocol/projects/openProjectDraftV1';

const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000001' };
const mutationId = '00000000-0000-4000-8000-000000000002';
const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey: new Uint8Array(32).fill(42) };
const randomBytes = (length: number) => new Uint8Array(length);
const document = NewSessionDraftDocumentV2Schema.parse({
  v: 2,
  composer: {
    text: { mutationId, value: 'Keep this draft' },
    mentions: { mutationId, value: [] },
    attachments: { mutationId, value: [] },
  },
  target: { kind: 'newSession', authoring: {
    executionTarget: { mutationId, value: {
      kind: 'temporary_computer', serverId: 'home-a', artifactTarget: 'linux-x64', workspace: { kind: 'endpoint_home' },
    } },
  } },
  extensions: {},
});

describe('buildAccountEncryptionSessionDraftsDirective', () => {
  it.each(['plain', 'e2ee'] as const)('reseals the exact agent-free Open draft in the Account transition (%s)', async mode => {
    const address = { kind: 'projectOpen' as const, draftId: '00000000-0000-4000-8000-000000000001' };
    const input = { serverId: 'home-a', machineId: 'machine', source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } };
    const field = (value: unknown) => ({ mutationId, value });
    const document = ProjectOpenDraftDocumentV2Schema.parse({ v: 2, target: { kind: 'projectOpen' }, selection: field(input),
      uncertainInputs: field([input]), result: field({ kind: 'outcomeUnknown' }), retiredAttempt: field(null) });
    const directive = buildAccountEncryptionSessionDraftsDirective({ candidates: [{ address, baseRevision: 5, document }],
      target: mode === 'plain' ? { mode } : { mode, material, randomBytes } });
    expect(directive).toMatchObject({ v: 2, items: [{ address }] });
    const cipher = createSessionDraftCipher({ accountMode: mode, accountCryptoMaterial: mode === 'plain' ? null : material,
      randomBytes, getSessionContext: () => { throw new Error('Open cannot use Session keys'); } });
    await expect(cipher.open(address, directive!.items[0]!.content)).resolves.toEqual(document);
  });
  it.each(['plain', 'e2ee'] as const)('preserves successor intent through the migration wire and real Account cipher (%s)', async (mode) => {
    const directive = buildAccountEncryptionSessionDraftsDirective({
      candidates: [{ address, baseRevision: 5, document }],
      target: mode === 'plain' ? { mode } : { mode, material, randomBytes },
    });
    expect(directive).toMatchObject({ v: 2, items: [{ address, expectedRevision: 5 }] });
    const parsed = AccountEncryptionMigrateSessionDraftsDirectiveSchema.parse(directive);
    const cipher = createSessionDraftCipher({
      accountMode: mode, accountCryptoMaterial: mode === 'plain' ? null : material,
      randomBytes, getSessionContext: () => { throw new Error('New-session drafts must use Account encryption'); },
    });
    await expect(cipher.open(address, parsed.items[0]!.content)).resolves.toEqual(document);
  });

  it('retains the unversioned directive for representable V1 drafts and omits empty inventories', () => {
    const legacy = { ...document, v: 1 as const, target: { kind: 'newSession' as const, authoring: {} } };
    const directive = buildAccountEncryptionSessionDraftsDirective({
      candidates: [{ address, baseRevision: 5, document: legacy }], target: { mode: 'plain' },
    });
    expect(directive).toEqual({ items: [{
      address, expectedRevision: 5, content: { t: 'plain', v: { v: 1, address, document: legacy } },
    }] });
    expect(buildAccountEncryptionSessionDraftsDirective({ candidates: [], target: { mode: 'plain' } })).toBeUndefined();
  });
});
