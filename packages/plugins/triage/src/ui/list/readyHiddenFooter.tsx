import * as React from 'react';
import {
  Button,
  Row,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';

export const TRIAGE_READY_HIDDEN_FOOTER_TEST_ID_V1 =
  'triage-ready-hidden-footer';

/**
 * Under the Ready lens (work-loop R3 `ready:A`), what the lens set aside, in the window's own census: how many
 * Tasks wait on a blocker and how many have a blocker that cannot be read, with "Show them" lifting the Ready
 * filter. Nothing is recounted here; without a census or with nothing set aside there is no line.
 */
export function TriageReadyHiddenFooter(
  props: Readonly<{
    counts: TriageListWindowV1['notReadyReasonCounts'];
    onShow: () => void;
  }>,
): React.ReactElement | null {
  const text = usePluginTranslation();
  const waiting = props.counts?.blocker_not_terminal ?? 0;
  const unreadable = props.counts?.blocker_unreadable ?? 0;
  const total = waiting + unreadable;
  if (total === 0) return null;
  const parts = [
    ...(waiting === 0
      ? []
      : [
          text(
            'plugins.triage.tasks.ready.hiddenWaiting',
            '{count} wait on blockers',
            { count: String(waiting) },
          ),
        ]),
    ...(unreadable === 0
      ? []
      : [
          text(
            'plugins.triage.tasks.ready.hiddenUnreadable',
            '{count} with a blocker that can’t be read',
            { count: String(unreadable) },
          ),
        ]),
  ];
  return (
    <Row
      gap="small"
      align="center"
      wrap
      testID={TRIAGE_READY_HIDDEN_FOOTER_TEST_ID_V1}
    >
      <Text
        variant="meta"
        tone="secondary"
        value={text(
          'plugins.triage.tasks.ready.hidden',
          '{count} not ready: {reasons}',
          { count: String(total), reasons: parts.join(', ') },
        )}
      />
      <Button
        variant="plain"
        size="small"
        title={text('plugins.triage.tasks.ready.showHidden', 'Show them')}
        onPress={props.onShow}
      />
    </Row>
  );
}
