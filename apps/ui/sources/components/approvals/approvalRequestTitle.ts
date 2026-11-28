import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetLayoutFragmentApprovalNameV1 } from '@happier-dev/protocol/widgets';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { t } from '@/text';
import { useEnvironmentName } from '@/components/projects/deployments/useEnvironmentName';
import { readPluginEventTriggerApprovalEnvironmentId, readPluginEventTriggerApprovalSummary } from './approvalFieldValues';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { presentActionApproval, readActionApprovalSubject, readApprovalPreviewSummary } from './actionApprovalPresentation';
import { readPluginInstallApprovalChange, readPluginInstallSourceName } from './pluginInstallApprovalFacts';
import { useApprovalReferenceReading } from './approvalReferenceReading';
import { useIncomingDiscussionApprovalNames } from './useIncomingDiscussionApprovalNames';
import type { ActionApprovalPresentationInput } from './actionApprovalPresentation';
import { describeDeploymentEnvironmentUpdateDecision, describeDeploymentPreviewCreateDecision, readDeploymentPreviewCreateApproval,
  describeDeploymentReviewDecision, readDeploymentEnvironmentUpdateApproval,
  readDeploymentReviewApproval } from './DeploymentReviewApprovalFacts';

export type ApprovalRequestTitleInput = Pick<ActionApprovalPresentationInput, 'execution' | 'executionOriginV1' | 'incomingDiscussionNames'> & Readonly<{
    storedTitle: string | null | undefined;
    /** The request's own generated summary: a first line that only restates it is not a title the person chose. */
    previewSummary?: string | null;
    /** A mounted page already resolved its subject; retained tabs reuse that base. */
    publishedTitle?: Readonly<{ title: string | null; source: 'page' | 'fallback' }>;
    actionId?: string | null;
    qualifiedActionId?: string | null;
    actionArgs?: unknown;
    status?: ApprovalRequest['status'];
    preview?: unknown;
    subject?: string | null;
    /** The Environment a health trigger or an Environment update names, once its name is read. */
    triggerEnvironmentName?: string | null;
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
  // A plugin Update travels as `plugins.install`; its evaluated review says it updates the installed plugin.
  const actionTitle = actionId === 'plugins.install' && readPluginInstallApprovalChange(input.preview) === 'update'
    ? t('settingsPlugins.updatePluginTitle') : readApprovalActionTitle(actionId);
  // A subject named by the very value the request sets (a renamed Session already reads by its new title) would say
  // that value twice; the title then names the Action alone and the value reads once, in the facts.
  // The declared model id is its person-facing name when no friendly name is available.
  const subject = input.subject?.trim() && (readActionApprovalSubject(input)?.kind === 'providerModel'
    || !readsActionArgValue(input.actionArgs, input.subject.trim())) ? input.subject : null;
  const presentation = presentActionApproval({ ...input, actionId, subject });
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
      ? readWidgetLayoutFragmentApprovalNameV1(input.actionArgs, input.preview)
      : generated && !subject ? readPluginEventTriggerApprovalSummary(input, input.triggerEnvironmentName) : null;
  // A deploy, Create or Delete leads with the decision its host reviewed ("Create orders-api on Railway"), never the
  // Action's name: the page, its Inbox row and its retained tab read it from here.
  const reviewedDecision = describeDeploymentReviewDecision(readDeploymentReviewApproval({ preview: input.preview }), actionId || null, null);
  // An Environment update names the Environment it changes once its name is read, never "Update deployment environment".
  const environmentUpdateTitle = reviewedDecision ? null
    : describeDeploymentEnvironmentUpdateDecision(readDeploymentEnvironmentUpdateApproval(input), input.triggerEnvironmentName ?? null)
      // A pull request's preview Create names the Environment it copies ("Create a preview of field-guide-site").
      ?? describeDeploymentPreviewCreateDecision(readDeploymentPreviewCreateApproval(input), input.triggerEnvironmentName ?? null);
  const title = reviewedDecision ? reviewedDecision.title : environmentUpdateTitle ? environmentUpdateTitle : subjectName && actionTitle ? `${actionTitle} · ${subjectName}` :
    generated
      ? (presentation.title ?? actionTitle ?? t('inbox.work.rows.approvalUntitled'))
      : firstLine;
  const detail = rest.join('\n').trim();
  // A generated title already identifies the Action, including its named subject.
  // The Inbox facts and page Action row must not repeat it beside that title.
  const titleNamesAction = Boolean(subjectName && actionTitle) || generated;
  const publishedBase = input.publishedTitle?.source === 'page' ? input.publishedTitle.title : null;
  return { title: publishedBase || title, actionTitle: titleNamesAction ? null : actionTitle, detail: detail || null };
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
    status: parsed.request.status,
    execution: parsed.request.execution,
    preview: parsed.request.preview,
    executionOriginV1: parsed.request.v === 2 ? parsed.request.executionOriginV1 : undefined,
    sessionIds,
  };
}

function readsActionArgValue(actionArgs: unknown, text: string): boolean {
  if (!actionArgs || typeof actionArgs !== 'object' || Array.isArray(actionArgs)) return false;
  return Object.values(actionArgs).some(value => typeof value === 'string' && value.trim() === text);
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
  const incomingDiscussionNames = useIncomingDiscussionApprovalNames(input, serverId);
  const reference = readActionApprovalSubject({ ...input, actionId: input.actionId ?? '' });
  const reading = useApprovalReferenceReading(reference, reference?.id ?? '', serverId);
  // A subject still being read is not a name yet; the title gains it once the read lands.
  const environmentId = readPluginEventTriggerApprovalEnvironmentId(input)
    ?? readDeploymentEnvironmentUpdateApproval(input)?.environmentId
    ?? readDeploymentPreviewCreateApproval(input)?.templateEnvironmentId ?? null;
  const { name: triggerEnvironmentName } = useEnvironmentName(serverId, environmentId);
  return resolveApprovalRequestTitle({ ...input, incomingDiscussionNames, triggerEnvironmentName,
      subject: reading.named && !reading.resolving ? reading.text : null });
}
