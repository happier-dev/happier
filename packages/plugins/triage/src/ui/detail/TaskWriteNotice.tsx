import * as React from 'react';
import { Banner, Button, Row, Stack, Status, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { ActionFailureDetails } from '../ActionFailureDetails.js';
import { taskWriteMessage, taskSourceLinkLabel, type TaskWriteMessageContext, type TaskWritePresentationResult } from '../taskWriteMessage.js';

export function TaskWriteFailureDetails({ result }: Readonly<{
  result: Exclude<TaskWritePresentationResult, { kind: 'applied' }> | null;
}>) {
  if (result === null) return null;
  const code = result.kind === 'refused' ? result.reason : result.failure?.code;
  const requestId = result.requestId ?? (result.kind === 'refused' ? undefined : result.failure?.requestId);
  return <ActionFailureDetails code={code} requestId={requestId} message={result.message} phase={result.phase} effectAttempted={result.effectAttempted}
    details={result.kind === 'refused' ? result.details : undefined}
    detail={result.kind === 'refused' ? undefined : result.failure?.detail} />;
}

export function TaskWriteNotice({ result, checking, onCheckAgain, sourceUrl, sessionLink, sessionLinkFailure, context }: Readonly<{
  result: TaskWritePresentationResult | null; checking?: boolean; onCheckAgain?(): Promise<unknown>; sourceUrl?: string;
  sessionLink?: 'linked' | 'failed' | 'unknown' | null;
  sessionLinkFailure?: React.ComponentProps<typeof TaskWriteFailureDetails>['result'];
  context?: TaskWriteMessageContext;
}>) {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  if (result === null) return null;
  if (result.kind === 'applied' && (sessionLink === 'failed' || sessionLink === 'unknown')) return <Stack gap="small">
    <Banner tone="warning" title={sessionLink === 'failed' ? text('plugins.triage.tasks.write.createdNotLinked', 'The task was created, but this Session could not be linked.')
      : text('plugins.triage.tasks.write.createdLinkUnknown', 'The task was created. Its Session link is not yet confirmed.')} />
    <TaskWriteFailureDetails result={sessionLinkFailure ?? null} />
  </Stack>;
  // A write that landed is confirmed by the change itself (the value, the row, the draft becoming the task); it is
  // said in one quiet line, never a card. Only a write that needs the reader takes the warning banner.
  if (result.kind === 'applied') return <Status tone="muted" label={taskWriteMessage(text, result, context)} />;
  return <Stack gap="small">
    <Banner tone="warning" title={taskWriteMessage(text, { ...result, message: undefined }, context)} />
    <TaskWriteFailureDetails result={result} />
    {result.kind !== 'uncertain' ? null : <Row gap="small" wrap>
      {onCheckAgain === undefined ? null : <Button variant="secondary" size="small" busy={checking} disabled={checking}
        title={text('plugins.triage.tasks.write.checkAgain', 'Check again')} onPress={() => { void onCheckAgain(); }} />}
      {sourceUrl === undefined ? null : <Button variant="secondary" size="small"
        title={taskSourceLinkLabel(text, context?.sourceName)} onPress={() => host.openExternalLink(sourceUrl)} />}
    </Row>}
  </Stack>;
}
