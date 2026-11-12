import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { logger } from '@/ui/logger';
import { readApprovalPassFailure as readPassFailure } from './passFailure';
import type { cancelDuplicateOpenApprovals } from './cancelDuplicateOpen';
import type { classifyOpenApprovalListFacts } from './classifyListFacts';

type StartupPassStore = Readonly<{
  approvalsCancelDuplicateOpen(): ReturnType<typeof cancelDuplicateOpenApprovals>;
  approvalsClassifyListFacts(): ReturnType<typeof classifyOpenApprovalListFacts>;
}>;

/**
 * One-time owner passes over open approvals written before current identity and list facts.
 * Older duplicate attempts are canceled first, so classification does not rewrite them.
 * Neither blocks startup; their counts and any incomplete or unavailable pass stay visible on
 * default log paths. A failed selection (for example Account encryption currentness not yet
 * known after a reconnect) fails closed: nothing is written and the next daemon start retries.
 * Complete passes persist separately for this Account/Home, including terminal unclassifiable rows.
 */
export async function runApprovalStartupPasses(
  store: StartupPassStore, options?: Readonly<{ settlementPath: string }>,
): Promise<void> {
  const settled = { v: 1, duplicateOpen: false, listFacts: false };
  if (options) {
    try {
      const value: unknown = JSON.parse(await readFile(options.settlementPath, 'utf8'));
      if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1
        || !('duplicateOpen' in value) || typeof value.duplicateOpen !== 'boolean'
        || !('listFacts' in value) || typeof value.listFacts !== 'boolean') {
        throw Object.assign(new Error('Invalid approval startup settlement'), { code: 'approval_startup_settlement_invalid' });
      }
      settled.duplicateOpen = value.duplicateOpen;
      settled.listFacts = value.listFacts;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        logger.warn('[DAEMON RUN] Approval startup settlement unreadable', readPassFailure(error));
      }
    }
  }
  const settle = async (pass: 'duplicateOpen' | 'listFacts') => {
    settled[pass] = true;
    if (!options) return;
    try { await writeJsonAtomic(options.settlementPath, settled); }
    catch (error) { logger.warn('[DAEMON RUN] Approval startup settlement unavailable', readPassFailure(error)); }
  };
  if (!settled.duplicateOpen) await store.approvalsCancelDuplicateOpen().then(async result => {
    if (result.failed || result.coverage !== 'complete') logger.warn('[DAEMON RUN] Duplicate open approval cancel incomplete', result);
    else {
      if (result.groups || result.unclassified) logger.infoFile('[DAEMON RUN] Duplicate open approval cancel', result);
      await settle('duplicateOpen');
    }
  }, error => {
    logger.warn('[DAEMON RUN] Duplicate open approval cancel unavailable', { code: 'approval_duplicate_cancel_unavailable', ...readPassFailure(error) });
  });
  if (!settled.listFacts) await store.approvalsClassifyListFacts().then(async result => {
    if (result.failed || result.coverage !== 'complete') logger.warn('[DAEMON RUN] Approval list-fact classification incomplete', result);
    // Mismatched rows are a stored-data condition (body disagrees with its header), reported by kind.
    else {
      if (result.mismatched) logger.infoFile('[DAEMON RUN] Approval list-fact classification', result);
      else if (result.classified) logger.debug('[DAEMON RUN] Approval list-fact classification', result);
      await settle('listFacts');
    }
  }, error => {
    logger.warn('[DAEMON RUN] Approval list-fact classification unavailable', { code: 'approval_list_facts_unavailable', ...readPassFailure(error) });
  });
}
