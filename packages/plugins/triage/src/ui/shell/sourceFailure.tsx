import * as React from 'react';
import { Button, Status, TechnicalDetailsDisclosure, Text, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';

import {
  readTriageListFailureLine,
  readTriageListFailureNotice,
  type TriageListShellFailureV1,
} from './windowState.js';

/** The press beside a failure line: it never outweighs the sentence it serves. */
export function TriageFailureLineAction(props: Readonly<{
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => unknown;
}>): React.ReactElement {
  return <Button accessibilityLabel={props.label} variant="plain" size="small" onPress={props.onPress}
    {...(props.busy === undefined ? {} : { busy: props.busy })}
    {...(props.disabled === undefined ? {} : { disabled: props.disabled })}>
    <Text variant="meta" tone="secondary" value={props.label} />
  </Button>;
}

/** The failure beside retained rows: one line, with the one press that can help. */
export function TriageListFailureStatus(props: Readonly<{
  failure: TriageListShellFailureV1;
  /** Read the sources again. */
  retry: React.ReactNode;
  /** Open the connections to fix one. Absent where this page has no source management. */
  manageSources?: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const line = readTriageListFailureLine(props.failure, text, locale);
  return <Status tone="warning" label={line.label}
    action={line.recovery === 'manageSources' ? props.manageSources ?? props.retry : props.retry} />;
}

/** Each connection's own reason and its typed cause, where the reader went to fix them (Manage sources). */
export function TriageListFailureDetails(props: Readonly<{ failure: TriageListShellFailureV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const notice = readTriageListFailureNotice(props.failure, text, locale);
  return <TechnicalDetailsDisclosure
    title={text('plugins.triage.surface.detail.tab.details', 'Details')}
    lines={[
      { key: 'source-reason', label: notice.title, value: notice.description },
      ...(notice.details === undefined ? [] : [{ key: 'source-invocation', label: notice.title, value: notice.details }]),
    ]}
  />;
}
