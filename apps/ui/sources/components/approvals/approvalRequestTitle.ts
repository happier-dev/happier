import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetLayoutFragmentApprovalNameV1 } from '@happier-dev/protocol/widgets';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { presentActionApproval, readActionApprovalSubject, readApprovalPreviewSummary } from './actionApprovalPresentation';
import { readPluginInstallSourceName } from './pluginInstallApprovalFacts';
import { useApprovalReferenceReading } from './approvalReferenceReading';

export type ApprovalRequestTitleInput = Readonly<{
    storedTitle: string | null | undefined;
    /** The request's own generated summary: a first line that only restates it is not a title the person chose. */
    previewSummary?: string | null;
    actionId?: string | null;
    qualifiedActionId?: string | null;
    actionArgs?: unknown;
    preview?: unknown;
    subject?: string | null;
    /** Session ids the request carries; a legacy " — <id>" suffix naming one of them is dropped. */
    sessionIds?: ReadonlyArray<string | null | undefined>;
}>;

/**
 * The one title rule for an approval request, shared by its Inbox row, its page and its retained tab (all fed by `readApprovalArtifactTitleInput`).
 *
 * A request names itself by its first line. Requests stored before the producer stopped doing it
 * carry " — <session id>" after the title: that id is never copy, the session is named by the page
 * and the row from the request's own session. A stored title that is only the raw Action id names
 * nothing, so the Action's own title is used, or a plain "Approval request".
 */
export function resolveApprovalRequestTitle(
  input: ApprovalRequestTitleInput,
): Readonly<{
  title: string;
  actionTitle: string | null;
  detail: string | null;
}> {
  const actionId = input.actionId?.trim() ?? '';
  const qualifiedActionId = input.qualifiedActionId?.trim() ?? '';
  const actionTitle = readApprovalActionTitle(actionId);
  const presentation = presentActionApproval({ ...input, actionId, subject: input.subject });
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
  let isSpecCopy = false;
  try {
    const spec = getActionSpec(actionId as ActionId);
    isSpecCopy = firstLine === spec.title || firstLine === buildApprovalPreviewSummary(spec, input.actionArgs)
      || (firstLine !== '' && firstLine === input.previewSummary?.trim());
  } catch { /* Authored/plugin requests retain their copy. */ }
  const generated = isRawId || isSpecCopy || firstLine === '';
  // A generated install title names what it installs: the reviewed plugin, else its own source until a review lands.
  const subjectName = actionId === 'plugins.install'
    ? readPluginInstallApprovalPendingReview(input.preview)?.review.displayName.trim()
      || (generated ? readPluginInstallSourceName(input.actionArgs) : null)
    : WidgetLayoutFragmentActionIdV1Schema.safeParse(actionId).success
      ? readWidgetLayoutFragmentApprovalNameV1(input.actionArgs, input.preview) : null;
  const title = subjectName && actionTitle ? `${actionTitle} · ${subjectName}` :
    generated
      ? (presentation.title ?? actionTitle ?? t('inbox.work.rows.approvalUntitled'))
      : firstLine;
  const detail = rest.join('\n').trim();
  // A generated title already identifies the Action, including its named subject.
  // The Inbox facts and page Action row must not repeat it beside that title.
  const titleNamesAction = Boolean(subjectName && actionTitle) || generated;
  return { title, actionTitle: titleNamesAction ? null : actionTitle, detail: detail || null };
}

/**
 * What the stored request says about its own title, read once for every surface that titles it.
 *
 * The page, the Inbox row and the retained tab each used to assemble their own input, so a request
 * whose stored sentence was an older generated summary read as that sentence in a tab and as its
 * Action's name on its page. The loaded body (when this device holds it) wins over the header's
 * copy of the same facts.
 */
export function readApprovalArtifactTitleInput(
  artifact: Pick<DecryptedArtifact, 'header' | 'title'> | null,
  parsed: ParsedApprovalArtifactBodyV1 | null,
  extraSessionIds: ReadonlyArray<string | null | undefined> = [],
): ApprovalRequestTitleInput {
  const header = artifact?.header ?? null;
  const headerText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
  const headerSessions = Array.isArray(header?.sessions) ? header.sessions.filter((id): id is string => typeof id === 'string') : [];
  const sessionIds = [...extraSessionIds, headerText(header?.sessionId), parsed?.request.createdBy.sessionId, ...headerSessions];
  const storedTitle = parsed?.request.summary ?? headerText(header?.title) ?? artifact?.title ?? null;
  if (!parsed) {
    return { storedTitle, actionId: headerText(header?.actionId), qualifiedActionId: headerText(header?.qualifiedActionId), sessionIds };
  }
  if (parsed.family === 'target_action') {
    return { storedTitle, qualifiedActionId: parsed.request.qualifiedActionId, sessionIds };
  }
  const actionId = String(parsed.request.actionId);
  if (parsed.family === 'execution_run_host_action') return { storedTitle, actionId, sessionIds };
  return {
    storedTitle,
    previewSummary: readApprovalPreviewSummary(parsed.request.preview, parsed.request),
    actionId,
    actionArgs: parsed.request.actionArgs,
    preview: parsed.request.preview,
    sessionIds,
  };
}

/** A person-facing name for a built-in Action, or none: a raw Action id is never shown as copy. */
export function readApprovalActionTitle(
  actionIdRaw: string | null | undefined,
): string | null {
  const actionId = actionIdRaw?.trim() ?? '';
  if (!actionId) return null;
  try {
    const specTitle = presentActionApproval({ actionId }).title?.trim();
    return specTitle && specTitle !== actionId ? specTitle : null;
  } catch {
    return null;
  }
}

/** Row and page resolve the same declared subject through the same scoped reference reader. */
export function useApprovalRequestTitle(input: ApprovalRequestTitleInput, serverId: string | null) {
  usePreferredLanguage();
  const reference = readActionApprovalSubject({ ...input, actionId: input.actionId ?? '' });
  const reading = useApprovalReferenceReading(reference, reference?.id ?? '', serverId);
  // A subject still being read is not a name yet; the title gains it once the read lands.
  return resolveApprovalRequestTitle({ ...input, subject: reading.named && !reading.resolving ? reading.text : null });
}
