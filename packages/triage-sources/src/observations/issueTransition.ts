import {
  PluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { publishTriageAttentionV1 } from './attention.js';
import {
  TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1,
  type TriageIssueTransitionV1,
} from './issueSource.js';

/** Notice body's first line per transition: the outcome in the person's words, not the phase id. */
const ISSUE_TRANSITION_SENTENCE: Record<
  TriageIssueTransitionV1['phase'],
  (provider: string) => string
> = {
  open: (provider) => `New issue in ${provider}.`,
  updated: (provider) => `Issue updated in ${provider}.`,
  resolved: (provider) => `Resolved in ${provider}.`,
};

/**
 * The ONE issue transition → attention/notice publisher. Vendor scan-diff
 * observers call it from their checkpoint save; a commit-published source
 * calls it after its own Account write committed and the Automation Engine
 * admitted the occurrence. Automatic Workflow dispatch is owned solely by AE.
 */
export async function publishTriageIssueTransitionV1(
  context: Pick<PluginInvocationContext, 'services' | 'signal'>,
  input: Readonly<{
    providerDisplayName: string;
    sourceInstanceId: string;
    transition: TriageIssueTransitionV1;
    occurrenceId: string;
    entryRef: TriageEntryRefV1;
    title: string;
    webUrl?: string;
  }>,
): Promise<void> {
  const entry = {
    entryRef: input.entryRef,
    sourceInstanceId: input.sourceInstanceId,
  };
  const notice = {
    clientRequestId: input.occurrenceId,
    categoryId: TRIAGE_ISSUE_NOTIFICATION_CATEGORY_ID_V1,
    title: input.title,
    type: 'update',
    resolved: false,
    // The title already names the issue; the body says what changed and where to open it.
    body: [
      ISSUE_TRANSITION_SENTENCE[input.transition.phase](
        input.providerDisplayName,
      ),
      ...(input.webUrl === undefined ? [] : [input.webUrl]),
    ].join('\n'),
    healthPhase: input.transition.phase === 'resolved' ? 'recovered' : 'open',
    investigation: { kind: 'alertEntry', entry },
    data: projectNativeJsonValueForTransport({
      transition: input.transition,
      evidence: { kind: 'alertEntry', entry },
    }),
  } satisfies Parameters<
    PluginInvocationContext['services']['notifications']['send']
  >[0];
  const result = await publishTriageAttentionV1(context, {
    entryRef: input.entryRef,
    reason: 'watchedAlert',
    notice,
  });
  context.signal.throwIfAborted();
  if (!result.notice && input.transition.phase !== 'resolved')
    throw new PluginError({
      code: 'triage_issue_notice_unavailable',
      message: 'The issue notice was not committed.',
    });
}
