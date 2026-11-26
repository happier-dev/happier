import * as React from 'react';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { BotTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { BotTemplateReleaseV1Schema, type BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { ToolCall } from '@happier-dev/session-core/messages';

import { resolveApprovalDisplayStatus } from '@/components/approvals/approvalStatusLabel';
import { useApprovalArtifact } from '@/components/approvals/useApprovalArtifact';
import { readHappierActionCallId } from '@/components/sessions/transcript/references/happierActionToolResult';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { resolveToolCallOutcome } from '../presentation/resolveToolCallOutcome';
import { presentApprovalFailureOutcome } from './approvalFailureOutcome';

type CopyToolApproval = Readonly<{
  artifactId: string;
  status: string | null;
  content: BotTemplateContentV1 | null;
  botHref: ReturnType<typeof buildScopedSessionRouteHref> | null;
  failure: ReturnType<typeof presentApprovalFailureOutcome> | null;
}>;

const CopyToolApprovalContext = React.createContext<CopyToolApproval | null>(null);

export function useCopyToolApproval() {
  return React.useContext(CopyToolApprovalContext);
}

/** The opened tool page's header and body share the exact approval returned by the native call. */
export function CopyToolApprovalScope({ tool, serverId, children }: Readonly<{
  tool: ToolCall;
  serverId: string | null;
  children: React.ReactNode;
}>) {
  if (!serverId || readHappierActionCallId(tool.name, tool.input) !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) return children;
  const outcome = resolveToolCallOutcome(tool);
  if (outcome.kind !== 'approval_requested') return children;
  return <CopyToolApprovalReader artifactId={outcome.artifactId} serverId={serverId}>{children}</CopyToolApprovalReader>;
}

function CopyToolApprovalReader({ artifactId, serverId, children }: Readonly<{
  artifactId: string;
  serverId: string;
  children: React.ReactNode;
}>) {
  const { artifact } = useApprovalArtifact({ artifactId, serverId });
  const approval = React.useMemo<CopyToolApproval>(() => {
    const matched = artifact?.isDecrypted !== false && typeof artifact?.body === 'string'
      ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
    if (matched?.family !== 'built_in' || matched.request.actionId !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
      return { artifactId, status: null, content: null, botHref: null, failure: null };
    }
    const { request } = matched;
    const executionFailure = readApprovalExecutionFailure(request);
    const status = resolveApprovalDisplayStatus(request, executionFailure);
    const reviewed = readRecord(readRecord(request.preview).hostReviewedContent);
    const release = BotTemplateReleaseV1Schema.safeParse(reviewed.release);
    const result = status === 'executed' && request.execution?.ok === true
      ? BotTemplateInstantiateResultV1Schema.safeParse(request.execution.result) : null;
    const bot = result?.success && result.data.type === 'success' ? result.data : null;
    return {
      artifactId,
      status,
      content: release.success ? release.data.content : null,
      botHref: bot ? buildScopedSessionRouteHref({ sessionId: bot.sessionId, serverId: bot.executionTarget.serverId }) : null,
      failure: executionFailure ? presentApprovalFailureOutcome(request, executionFailure) : null,
    };
  }, [artifact, artifactId]);
  return <CopyToolApprovalContext.Provider value={approval}>{children}</CopyToolApprovalContext.Provider>;
}
