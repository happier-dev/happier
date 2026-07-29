import type { TerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import type { SessionRunnerServiceabilityProbe } from '../sessions/isSessionRunnerActive';
import type { TrackedSession } from '../types';
import { shouldPublishReportedTerminalControlServiceability } from './terminalControlServiceabilityProjection';

export async function publishReportedTerminalControlServiceability(params: Readonly<{
  tracked: TrackedSession;
  readTerminalAttachmentInfo: (sessionId: string) => Promise<TerminalHostAttachmentInfo | null>;
  probeSessionRunnerServiceability: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  publishSessionRunnerControlServiceability: (
    sessionId: string,
    probe: SessionRunnerServiceabilityProbe,
  ) => Promise<boolean>;
}>): Promise<void> {
  const sessionId = typeof params.tracked.happySessionId === 'string'
    ? params.tracked.happySessionId.trim()
    : '';
  const terminal = params.tracked.happySessionMetadataFromLocalWebhook?.terminal;
  if (!sessionId || !terminal || terminal.mode === 'plain') return;

  const attachment = await params.readTerminalAttachmentInfo(sessionId);
  if (
    attachment?.version !== 2
    || !shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: attachment.attachmentId,
      publishedAttachmentId: params.tracked.publishedTerminalControlServiceabilityAttachmentId,
    })
  ) {
    return;
  }

  const probe = await params.probeSessionRunnerServiceability(sessionId);
  const published = await params.publishSessionRunnerControlServiceability(sessionId, probe);
  if (published && probe.state === 'runner_present' && probe.control.state === 'servable') {
    params.tracked.publishedTerminalControlServiceabilityAttachmentId = attachment.attachmentId;
  }
}
