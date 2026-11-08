import type { AgentAcpRuntimeDefinition, AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema, AgentRuntimeJsonValueV1Schema, AgentSessionRuntimeRetryV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { logger } from '@/ui/logger';

type UpdateCodec = NonNullable<AgentAcpRuntimeDefinition['sessionUpdates']>;
export type AcpSessionDiagnosticPublisher = Pick<AgentSessionHostServices['transcripts'], 'publishSessionEvent'>;

export function projectAcpSessionUpdate(
  codec: UpdateCodec | undefined,
  update: unknown,
): ReturnType<UpdateCodec['project']> {
  if (!codec) return null;
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(update);
  if (!parsed.success) return null;
  try {
    const projection = codec.project(parsed.data);
    if (projection?.retry === undefined || projection.retry === null) return projection;
    const retry = AgentSessionRuntimeRetryV1Schema.safeParse(projection.retry);
    if (retry.success) return { ...projection, retry: retry.data };
    logger.debug('[ACP] Native session update projection returned invalid retry evidence');
    return {
      ...(projection.toolMetadata ? { toolMetadata: projection.toolMetadata } : {}),
      ...(projection.diagnostic ? { diagnostic: projection.diagnostic } : {}),
    };
  } catch (error) {
    logger.debug('[ACP] Native session update projection failed', error);
    return null;
  }
}

export async function publishAcpSessionUpdateDiagnostic(
  projection: ReturnType<UpdateCodec['project']>,
  publisher: AcpSessionDiagnosticPublisher | undefined,
): Promise<void> {
  if (!publisher || !projection?.diagnostic) return;
  const parsed = AgentRuntimeDiagnosticDataV1Schema.safeParse(projection.diagnostic);
  if (!parsed.success) {
    logger.debug('[ACP] Native session update projection returned an invalid diagnostic');
    return;
  }
  const diagnostic = parsed.data;
  const message = redactBugReportSensitiveText(diagnostic.message ?? diagnostic.code);
  await publisher.publishSessionEvent({ type: 'message', message,
    diagnostic: { ...diagnostic, ...(diagnostic.message === undefined ? {} : { message }) } });
}
