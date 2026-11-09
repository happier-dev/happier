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
 */
export async function runApprovalStartupPasses(store: StartupPassStore): Promise<void> {
  await store.approvalsCancelDuplicateOpen().then(result => {
    if (result.failed || result.coverage !== 'complete') logger.warn('[DAEMON RUN] Duplicate open approval cancel incomplete', result);
    else if (result.groups || result.unclassified) logger.infoFile('[DAEMON RUN] Duplicate open approval cancel', result);
  }, error => {
    logger.warn('[DAEMON RUN] Duplicate open approval cancel unavailable', { code: 'approval_duplicate_cancel_unavailable', ...readPassFailure(error) });
  });
  await store.approvalsClassifyListFacts().then(result => {
    if (result.failed || result.coverage !== 'complete') logger.warn('[DAEMON RUN] Approval list-fact classification incomplete', result);
    // Mismatched rows are a stored-data condition (body disagrees with its header), reported by kind.
    else if (result.mismatched) logger.infoFile('[DAEMON RUN] Approval list-fact classification', result);
    else if (result.classified) logger.debug('[DAEMON RUN] Approval list-fact classification', result);
  }, error => {
    logger.warn('[DAEMON RUN] Approval list-fact classification unavailable', { code: 'approval_list_facts_unavailable', ...readPassFailure(error) });
  });
}
