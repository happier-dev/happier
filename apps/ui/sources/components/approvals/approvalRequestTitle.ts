import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { t } from '@/text';

/**
 * The one title rule for an approval request, shared by its Inbox row and its page.
 *
 * A request names itself by its first line. Requests stored before the producer stopped doing it
 * carry " — <session id>" after the title: that id is never copy, the session is named by the page
 * and the row from the request's own session. A stored title that is only the raw Action id names
 * nothing, so the Action's own title is used, or a plain "Approval request".
 */
export function resolveApprovalRequestTitle(
  input: Readonly<{
    storedTitle: string | null | undefined;
    actionId?: string | null;
    qualifiedActionId?: string | null;
    /** Session ids the request carries; a legacy " — <id>" suffix naming one of them is dropped. */
    sessionIds?: ReadonlyArray<string | null | undefined>;
  }>,
): Readonly<{
  title: string;
  actionTitle: string | null;
  detail: string | null;
}> {
  const actionId = input.actionId?.trim() ?? '';
  const qualifiedActionId = input.qualifiedActionId?.trim() ?? '';
  const actionTitle = readApprovalActionTitle(actionId);
  const [firstLineRaw, ...rest] = String(input.storedTitle ?? '').split('\n');
  let firstLine = (firstLineRaw ?? '').trim();
  for (const sessionId of input.sessionIds ?? []) {
    const suffix = sessionId?.trim() ? ` — ${sessionId.trim()}` : '';
    if (suffix && firstLine.endsWith(suffix)) {
      firstLine = firstLine.slice(0, -suffix.length).trim();
      break;
    }
  }
  const isRawId =
    firstLine !== '' &&
    (firstLine === actionId || firstLine === qualifiedActionId);
  const title =
    isRawId || firstLine === ''
      ? (actionTitle ?? t('inbox.work.rows.approvalUntitled'))
      : firstLine;
  const detail = rest.join('\n').trim();
  return { title, actionTitle, detail: detail || null };
}

/** A person-facing name for a built-in Action, or none: a raw Action id is never shown as copy. */
export function readApprovalActionTitle(
  actionIdRaw: string | null | undefined,
): string | null {
  const actionId = actionIdRaw?.trim() ?? '';
  if (!actionId) return null;
  try {
    const specTitle = getActionSpec(actionId as ActionId).title.trim();
    return specTitle && specTitle !== actionId ? specTitle : null;
  } catch {
    return null;
  }
}
