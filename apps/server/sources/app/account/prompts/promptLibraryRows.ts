import {
  PromptLibraryCatalogKeyV1Schema, PromptLibraryContentV1Schema, StoredPromptLibraryContentV1Schema,
  assertPromptLibraryContentForModeV1, buildPromptLibraryPhysicalKeyV1, parsePromptLibraryPhysicalKeyV1,
  PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1, type PromptLibraryContentV1, type PromptLibraryCatalogKeyV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { listReservedAccountScopedKvRowsInTx, mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
  type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';

export const promptLibraryRowDomain: ReservedAccountScopedKvRowDomain<PromptLibraryContentV1> = {
  label: 'Prompt library catalog',
  parseStoredEnvelope(value) { const parsed = StoredPromptLibraryContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  parseCandidateEnvelope(value) { const parsed = PromptLibraryContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  assertEnvelopeForMode: assertPromptLibraryContentForModeV1,
};

export function markPromptLibraryRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; key: PromptLibraryCatalogKeyV1; revision: number }>): Promise<number> {
  return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: buildPromptLibraryPhysicalKeyV1(input.key),
    hint: { promptLibrary: true, key: input.key, revision: input.revision } });
}
export async function readPromptLibraryRowInTx(tx: Tx, input: Readonly<{ accountId: string; key: PromptLibraryCatalogKeyV1 }>) {
  const result = await readReservedAccountScopedKvRowInTx(tx, { ...input, physicalKey: buildPromptLibraryPhysicalKeyV1(input.key), domain: promptLibraryRowDomain });
  if (result.status !== 'present') return result;
  if (result.envelope.t === 'plain' && result.envelope.v.key !== input.key) return { status: 'invalid-stored-content' as const };
  return { status: 'present' as const, revision: result.revision, content: result.envelope };
}
export async function listPromptLibraryRowsInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
  const result = await listReservedAccountScopedKvRowsInTx(tx, { ...input, physicalPrefix: PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1, domain: promptLibraryRowDomain });
  if (result.status !== 'listed') return result;
  const rows: Array<{ key: PromptLibraryCatalogKeyV1; revision: number; content: PromptLibraryContentV1 | null }> = [];
  for (const row of result.rows) {
    const key = parsePromptLibraryPhysicalKeyV1(row.physicalKey);
    if (key === null || (row.envelope?.t === 'plain' && row.envelope.v.key !== key)) return { status: 'invalid-stored-content' as const };
    rows.push({ key, revision: row.revision, content: row.envelope });
  }
  return { status: 'listed' as const, rows };
}
export async function mutatePromptLibraryRowInTx(tx: Tx, input: Readonly<{
  accountId: string; key: PromptLibraryCatalogKeyV1; expectedRevision: number | 'absent'; content: PromptLibraryContentV1 | null;
  sourceSettingsVersion?: number;
}>) {
  const key = PromptLibraryCatalogKeyV1Schema.parse(input.key);
  if (input.content?.t === 'plain' && input.content.v.key !== key) return { status: 'invalid-stored-content' as const };
  if (input.expectedRevision === 'absent') {
    if (input.sourceSettingsVersion === undefined || input.content === null) throw new Error('Prompt catalog initialization requires captured source currentness');
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
    const source = await tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { settingsVersion: true } });
    if (source.settingsVersion !== input.sourceSettingsVersion) return { status: 'settings-conflict' as const, revision: source.settingsVersion };
  } else if (input.sourceSettingsVersion !== undefined) throw new Error('Only catalog initialization admits a source Settings version');
  return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: buildPromptLibraryPhysicalKeyV1(key),
    expectedRevision: input.expectedRevision, envelope: input.content, domain: promptLibraryRowDomain,
    markChanged: ({ tx: changeTx, revision }) => markPromptLibraryRowChangedInTx(changeTx, { accountId: input.accountId, key, revision }) });
}
