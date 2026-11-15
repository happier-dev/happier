import * as React from 'react';
import { Banner, Stack, TechnicalDetailsDisclosure, usePluginTranslation } from '@happier-dev/plugin-ui';
import { describeTriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageSourceReadFailureV1 } from '../invocation/failure.js';

/** Show the source and host owners' bounded diagnostics without raw provider data. */
export function TriageSourceReadFailureDetails({ failures }: Readonly<{
  failures: readonly (TriageSourceReadFailureV1 | null)[];
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const lines = failures.flatMap(failure => failure === null ? [] : [{
    key: failure.code,
    label: text('plugins.github.ui.readFailure.code', 'Code'),
    value: [...new Set([failure.code, ...(failure.diagnostics?.map(value => value.code) ?? [])]),
      ...(failure.retryable === undefined ? [] : [`retryable=${failure.retryable}`])].join('\n'),
  }, ...(failure.detail === undefined ? [] : [{
    key: `${failure.code}:detail`, label: text('plugins.github.ui.readFailure.detail', 'Reason'), value: failure.detail,
  }]), ...(failure.requestId === undefined ? [] : [{
    key: `${failure.code}:requestId`, label: text('plugins.github.ui.readFailure.requestId', 'Request ID'), value: failure.requestId,
  }])]);
  return <TechnicalDetailsDisclosure title={text('plugins.github.ui.parity.details', 'Details')}
    lines={lines.filter((line, index) => lines.findIndex(other => other.value === line.value) === index)
      .map((line, index) => ({ ...line, key: `${index}:${line.key}` }))} />;
}

/**
 * What a paged panel owes its reader when a walk stopped short over rows that already arrived: one warning that the
 * rows are what was read so far, why, and the diagnostics. A first-page failure is a different presentation — the
 * panel says it could not look. The source supplies its own words for a failed read and, when its walk stopped
 * without a failure (a next-page position it would not follow), the sentence that says so.
 */
export function TriageSourcePartialReadBanner({ failure, incomplete = null, readFailed }: Readonly<{
  failure: TriageSourceReadFailureV1 | null;
  /** Why the walk stopped without a failure, in the source's words; shown only when nothing failed. */
  incomplete?: string | null;
  /** The source's sentence for a read that did not complete ("GitHub could not complete this read."). */
  readFailed: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const description = failure === null ? incomplete : describeTriageSourceFailureV1(failure, readFailed, text);
  if (description === null) return null;
  return <Stack gap="small">
    <Banner tone="warning" title="Showing what was read so far" titleKey="plugins.triage.readPartial" description={description} />
    {failure === null ? null : <TriageSourceReadFailureDetails failures={[failure]} />}
  </Stack>;
}
