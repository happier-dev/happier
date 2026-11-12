import * as React from 'react';
import { TechnicalDetailsDisclosure, usePluginTranslation } from '@happier-dev/plugin-ui';
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
