import * as React from 'react';
import { Button, Status, Text, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';

import {
  readTriageListFailureLine,
  type TriageListShellFailureV1,
} from './windowState.js';
import type { TriageOutsideSourcesAttentionV1 } from '../../projection/sourceHealth.js';

/** The press beside a failure line: it never outweighs the sentence it serves. */
export function TriageFailureLineAction(props: Readonly<{
  label: string;
  /** Names what it acts on where several sit together ("Retry acme/widgets"); defaults to the label. */
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => unknown;
}>): React.ReactElement {
  return <Button accessibilityLabel={props.accessibilityLabel ?? props.label} variant="plain" size="small" onPress={props.onPress}
    // A busy Button swaps its words for a spinner, stranded under the line at phone width: it holds its word instead.
    {...(props.busy === true || props.disabled === true ? { disabled: true } : {})}>
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

/**
 * Sources outside the selected view that need attention, said once in the status line (UI refinements 2026-11-08):
 * the view keeps its own state, and Review opens the one source-health surface (Manage sources).
 */
export function TriageOutsideSourcesNotice(props: Readonly<{
  attention: TriageOutsideSourcesAttentionV1;
  /** Manage sources is open: each source says its own state there, so this line steps aside. */
  managing?: boolean;
  onReview: (target: TriageOutsideSourcesAttentionV1['target']) => void;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (props.managing === true) return null;
  const { count, target } = props.attention;
  const label = count === 1
    ? text('plugins.triage.surface.sources.outsideAttention.one', '1 other source needs attention')
    : text('plugins.triage.surface.sources.outsideAttention.other', '{count} other sources need attention', { count });
  return <Status tone="warning" label={label}
    action={<TriageFailureLineAction label={text('plugins.triage.surface.sources.outsideAttention.review', 'Review')}
      onPress={() => { props.onReview(target); }} />} />;
}
