import * as React from 'react';
import { Button, Stack, Status, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorResultV1Schema,
  type TriageTaskOriginErrorV1Schema } from '../../actions/taskOriginProtocol.js';
import { TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1, TriageReadTaskOriginReviewResultV1Schema,
  type TriageTaskOriginReviewV1 } from '../../actions/taskReviewProtocol.js';
import { openTriageLinkedEntry } from '../navigation/openLinkedEntry.js';
import { isHostCancellation } from '../../hostCancellation.js';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';

type OriginError = ReturnType<typeof TriageTaskOriginErrorV1Schema.parse>;

/** Drafts and saved tasks use the same exact-entry navigation owner. */
export function TriageTaskOriginLink({ origin }: Readonly<{ origin: OriginError }>) {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [failed, setFailed] = React.useState(false);
  return <Stack gap="small" align="flex-start">
    <Button variant="plain" size="small" title={text('plugins.triage.tasks.origin.label', 'From error: {title}', { title: origin.display.title })}
      onPress={async () => {
        const result = await openTriageLinkedEntry(host, origin.entryRef);
        setFailed(result.kind === 'refused');
        if (result.kind === 'refused' && result.reason === 'unavailable') await presentTriageMountedUiActionFailure(host, result.error, text);
      }} />
    {!failed ? null : <Status tone="warning" label={text('plugins.triage.tasks.origin.openFailed', 'The origin error could not be opened. Try the link again.')} />}
  </Stack>;
}

/** One relationship read per opened task, and on explicit refresh; no provider mirror or polling. */
export function TriageTaskOrigin(props: Readonly<{ entryRef: TriageEntryRefV1; refreshGeneration?: number }>) {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [origin, setOrigin] = React.useState<OriginError | null>(null);
  const [originReview, setOriginReview] = React.useState<TriageTaskOriginReviewV1 | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const key = triageEntryRowKey(props.entryRef);
  React.useEffect(() => {
    const controller = new AbortController();
    setOrigin(null);
    setOriginReview(null);
    setFailed(false);
    const input = { v: 1, entryRef: props.entryRef };
    const options = { signal: controller.signal };
    void Promise.all([
      host.executeAction(TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, input, options)
        .then(raw => TriageReadTaskOriginErrorResultV1Schema.parse(raw).originError),
      host.executeAction(TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1, input, options)
        .then(raw => TriageReadTaskOriginReviewResultV1Schema.parse(raw).originReview),
    ])
      .then(([error, review]) => { if (!controller.signal.aborted) { setOrigin(error); setOriginReview(review); } })
      .catch(async (error: unknown) => {
        if (isHostCancellation(error, controller.signal)) return;
        setFailed(true);
        await presentTriageMountedUiActionFailure(host, error, text);
      });
    return () => controller.abort();
  }, [host, key, props.refreshGeneration, retry, text]);
  if (failed) return <Button variant="plain" size="small" title={text('plugins.triage.tasks.origin.retry', 'Retry origin link')}
    onPress={() => setRetry(value => value + 1)} />;
  if (origin === null && originReview === null) return null;
  return <Stack gap="small" align="flex-start">
    {origin === null ? null : <TriageTaskOriginLink origin={origin} />}
    {originReview === null ? null : <Button variant="plain" size="small" title={text('plugins.triage.surface.session.review', 'Review')}
      onPress={async () => {
        try { await host.openResource({ kind: 'artifact', artifactId: originReview.reviewId }); }
        catch (error: unknown) { await presentTriageMountedUiActionFailure(host, error, text); }
      }} />}
  </Stack>;
}
