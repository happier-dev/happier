import * as React from 'react';
import { ErrorState, Stack, TechnicalDetailsDisclosure, usePluginTranslation } from '@happier-dev/plugin-ui';
import { describeTriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubReadFailureV1 } from './readBoundary.js';

/** The source and dispatch owners' exact codes stay behind the shared disclosure. */
export function GithubReadFailureDetails({ failures }: Readonly<{ failures: readonly (GithubReadFailureV1 | null)[] }>): React.ReactElement | null {
  const text = usePluginTranslation();
  const lines = failures.flatMap(failure => failure === null ? [] : [{
    key: failure.code,
    label: text('plugins.github.ui.readFailure.code', 'Code'),
    value: [...new Set([failure.code, ...(failure.diagnostics?.map(value => value.code) ?? [])]),
      ...(failure.retryable === undefined ? [] : [`retryable=${failure.retryable}`])].join('\n'),
  }, ...(failure.detail === undefined ? [] : [{
    key: `${failure.code}:detail`,
    label: text('plugins.github.ui.readFailure.detail', 'Reason'),
    value: failure.detail,
  }]), ...(failure.requestId === undefined ? [] : [{
    key: `${failure.code}:requestId`,
    label: text('plugins.github.ui.readFailure.requestId', 'Request ID'),
    value: failure.requestId,
  }])]);
  return <TechnicalDetailsDisclosure
    title={text('plugins.github.ui.parity.details', 'Details')}
    lines={lines.filter((line, index) => lines.findIndex(other => other.value === line.value) === index)
      .map((line, index) => ({ ...line, key: `${index}:${line.key}` }))}
  />;
}

/** One cold-read presentation shared by Activity, Overview, Files and Checks. */
export function GithubReadFailure(props: Readonly<{
  title: string;
  titleKey?: string;
  failures: readonly (GithubReadFailureV1 | null)[];
  refresh?: () => unknown;
}>): React.ReactElement {
  const text = usePluginTranslation();
  return <Stack gap="small">
    <ErrorState title={props.title} titleKey={props.titleKey}
      description={describeTriageSourceFailureV1(props.failures[0] ?? null,
        text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'), text)}
      {...(props.failures.some(failure => failure !== null
        && (failure.retryable ?? failure.class === 'transient')) && props.refresh !== undefined ? {
        onRetry: props.refresh, retryLabel: text('forgeCi.state.retry', 'Retry'),
      } : {})}
    />
    <GithubReadFailureDetails failures={props.failures} />
  </Stack>;
}
