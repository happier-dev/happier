import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import type { ProfileRecordV1, ProfileRowsListResponseV1 } from './profileRecordV1.js';
import { ProfileReferenceGuardReadResponseV1Schema, openProfileRecordContentV1 } from './profileRecordV1.js';
import { openProfileTransferContentV1, type ProfileTransferControlV1, type ProfileTransferRowReadResponseV1 } from './profileTransferV1.js';
import { resolveProfileCatalogAuthorityV1 } from './read.js';

export type ProfileCatalogRecordV1 = Readonly<{ record: ProfileRecordV1; revision: number }>;
export type ProfileCatalogTombstoneV1 = Readonly<{ id: string; revision: number }>;
export type ProfileCatalogDiagnosticV1 = Readonly<{
  id: string;
  revision: number;
  reason: 'invalid-stored-content' | 'identity-mismatch' | 'unreadable-content';
}>;
export type ProfileCatalogUnavailableReasonV1 =
  | 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch'
  | 'encryption-material-unavailable' | 'invalid-stored-content' | 'invalid-reference'
  | 'reference-conflict' | 'incomplete-pages' | 'unauthorized' | 'forbidden'
  | 'unsupported' | 'unreachable' | 'scope-retired' | 'cancelled';

type ProfileCatalogInventoryV1 = Readonly<{
      records: readonly ProfileCatalogRecordV1[];
      tombstones?: readonly ProfileCatalogTombstoneV1[];
      diagnostics: readonly ProfileCatalogDiagnosticV1[];
      referenceGuardRevision: number | 'absent';
      authority: 'inactive' | 'active';
      /** Captured read selection; absent on a pure row/reference census, never a persisted phase. */
      source?: 'destination' | 'legacy';
      control: Readonly<{ record: ProfileTransferControlV1; revision: number }> | null;
      controlRevision: number | 'absent';
}>;

/** An incomplete inventory is display/repair data, never runtime or mutation authority. */
export type ProfileCatalogSnapshotV1 =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: ProfileCatalogUnavailableReasonV1 }>
  | (ProfileCatalogInventoryV1 & Readonly<{ status: 'ready' }>)
  | (ProfileCatalogInventoryV1 & Readonly<{ status: 'partial' }>);

export async function loadProfileCatalogV1(input: Readonly<{
  mode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  readPage(cursor?: string): Promise<ProfileRowsListResponseV1>;
  readReferenceGuard(): Promise<ReturnType<typeof ProfileReferenceGuardReadResponseV1Schema.parse>>;
  readTransfer(): Promise<ProfileTransferRowReadResponseV1>;
  /** Genuine captured predecessor baseline; omitted for pure conversion/reference censuses. */
  readSource?: () => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<ProfileCatalogSnapshotV1> {
  if (input.mode === 'e2ee' && input.material === null) {
    return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  }
  if (input.mode === 'plain' && input.material !== null) {
    return { status: 'unavailable', reason: 'account-mode-mismatch' };
  }
  const records: ProfileCatalogRecordV1[] = [];
  const tombstones: ProfileCatalogTombstoneV1[] = [];
  const diagnostics: ProfileCatalogDiagnosticV1[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let referenceGuardRevision: number | 'absent' | undefined;
  let complete = true;
  let transfer: ProfileTransferRowReadResponseV1 | undefined;
  do {
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    const page = await input.readPage(cursor);
    if (page.status !== 'listed') return { status: 'unavailable', reason: page.status };
    if (!transfer) transfer = page.transferControl;
    else if (JSON.stringify(transfer) !== JSON.stringify(page.transferControl)) return { status: 'unavailable', reason: 'reference-conflict' };
    complete &&= page.complete;
    referenceGuardRevision ??= page.referenceGuardRevision;
    if (referenceGuardRevision !== page.referenceGuardRevision) {
      return { status: 'unavailable', reason: 'reference-conflict' };
    }
    diagnostics.push(...page.diagnostics);
    for (const row of page.rows) {
      if (ids.has(row.id)) {
        diagnostics.push({ id: row.id, revision: row.revision, reason: 'identity-mismatch' });
        continue;
      }
      ids.add(row.id);
      if (row.content === null) {
        tombstones.push({ id: row.id, revision: row.revision });
        continue;
      }
      const opened = openProfileRecordContentV1({
        mode: input.mode, material: input.material, expectedId: row.id, content: row.content,
      });
      if (opened.status === 'unavailable') {
        if (opened.reason !== 'invalid-stored-content') return opened;
        diagnostics.push({ id: row.id, revision: row.revision, reason: opened.reason });
      } else {
        records.push({ record: opened.record, revision: row.revision });
      }
    }
    if (page.nextCursor === null) {
      break;
    }
    if (cursors.has(page.nextCursor)) {
      return { status: 'unavailable', reason: 'incomplete-pages' };
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  const guard = await input.readReferenceGuard();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (guard.status !== 'ready') return { status: 'unavailable', reason: guard.status };
  if (guard.revision !== referenceGuardRevision) {
    return { status: 'unavailable', reason: 'reference-conflict' };
  }
  const currentTransfer = await input.readTransfer();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (JSON.stringify(currentTransfer) !== JSON.stringify(transfer)) return { status: 'unavailable', reason: 'reference-conflict' };
  let control: ProfileCatalogInventoryV1['control'] = null;
  let controlRevision: number | 'absent' = 'absent';
  if (currentTransfer.status === 'present') {
    const opened = openProfileTransferContentV1({ mode: input.mode, material: input.material, content: currentTransfer.content });
    if (opened.status !== 'opened') return opened;
    control = { record: opened.record, revision: currentTransfer.revision };
    controlRevision = currentTransfer.revision;
  } else if (currentTransfer.status === 'deleted') {
    controlRevision = currentTransfer.revision;
  } else if (currentTransfer.status !== 'absent') {
    return { status: 'unavailable', reason: currentTransfer.status };
  }
  let source: ProfileCatalogInventoryV1['source'];
  if (control?.record.phase === 'active') {
    source = resolveProfileCatalogAuthorityV1({ rawSettings: undefined, control: control.record });
  } else if (input.readSource) {
    const rawSettings = await input.readSource();
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    // Activation/source cleanup can overtake the baseline read. Never label an
    // earlier empty census native using a later already-cleaned source.
    const [afterGuard, afterTransfer] = await Promise.all([input.readReferenceGuard(), input.readTransfer()]);
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (afterGuard.status !== 'ready') return { status: 'unavailable', reason: afterGuard.status };
    if (afterGuard.revision !== guard.revision || JSON.stringify(afterTransfer) !== JSON.stringify(currentTransfer)) {
      return { status: 'unavailable', reason: 'reference-conflict' };
    }
    source = resolveProfileCatalogAuthorityV1({ rawSettings, control: control?.record ?? null });
  }
  return {
    status: complete && diagnostics.length === 0 ? 'ready' : 'partial', records, tombstones, diagnostics,
    referenceGuardRevision: guard.revision,
    authority: control?.record.phase === 'active' ? 'active' : 'inactive', control, controlRevision,
    ...(source ? { source } : {}),
  };
}
