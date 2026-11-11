import * as React from 'react';
import { Banner, Button, Row, Stack, Status, TechnicalDetailsDisclosure, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { taskWriteMessage, taskSourceLinkLabel, type TaskWriteMessageContext, type TaskWritePresentationResult } from '../taskWriteMessage.js';

export function TaskWriteNotice({ result, checking, onCheckAgain, sourceUrl, sessionLink, context }: Readonly<{
  result: TaskWritePresentationResult | null; checking?: boolean; onCheckAgain?(): Promise<unknown>; sourceUrl?: string;
  sessionLink?: 'linked' | 'failed' | 'unknown' | null;
  context?: TaskWriteMessageContext;
}>) {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  if (result === null) return null;
  if (result.kind === 'applied' && (sessionLink === 'failed' || sessionLink === 'unknown')) return <Banner tone="warning"
    title={sessionLink === 'failed' ? text('plugins.triage.tasks.write.createdNotLinked', 'The task was created, but this Session could not be linked.')
      : text('plugins.triage.tasks.write.createdLinkUnknown', 'The task was created. Its Session link is not yet confirmed.')} />;
  // A write that landed is confirmed by the change itself (the value, the row, the draft becoming the task); it is
  // said in one quiet line, never a card. Only a write that needs the reader takes the warning banner.
  if (result.kind === 'applied') return <Status tone="muted" label={taskWriteMessage(text, result, context)} />;
  const code = result.kind === 'refused' ? result.reason : result.failure?.code;
  const requestId = result.requestId ?? (result.kind === 'refused' ? undefined : result.failure?.requestId);
  return <Stack gap="small">
    <Banner tone="warning" title={taskWriteMessage(text, result, context)} />
    <TechnicalDetailsDisclosure title={text('plugins.triage.surface.detail.tab.details', 'Details')}
      lines={[
        ...(code === undefined ? [] : [{ key: 'code', label: text('plugins.triage.sourceFailure.code', 'Code'), value: code }]),
        ...(requestId === undefined ? [] : [{ key: 'request-id', label: text('plugins.triage.sourceFailure.requestId', 'Request ID'), value: requestId }]),
        ...(result.phase === undefined ? [] : [{ key: 'phase', label: text('plugins.triage.sourceFailure.phase', 'Phase'), value: result.phase }]),
        ...(result.effectAttempted === undefined ? [] : [{ key: 'effect-attempted', label: text('plugins.triage.sourceFailure.effectAttempted', 'Effect attempted'), value: String(result.effectAttempted) }]),
      ]} />
    {result.kind !== 'uncertain' ? null : <Row gap="small" wrap>
      {onCheckAgain === undefined ? null : <Button variant="secondary" size="small" busy={checking} disabled={checking}
        title={text('plugins.triage.tasks.write.checkAgain', 'Check again')} onPress={() => { void onCheckAgain(); }} />}
      {sourceUrl === undefined ? null : <Button variant="secondary" size="small"
        title={taskSourceLinkLabel(text, context?.sourceName)} onPress={() => host.openExternalLink(sourceUrl)} />}
    </Row>}
  </Stack>;
}
