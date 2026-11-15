import * as React from 'react';
import { type LayoutChangeEvent, View } from 'react-native';

import {
  normalizeSessionListFilterV1,
  type SessionListFilterV1,
} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { SessionListStoredFilterEditor } from '@/components/sessions/shell/search/SessionListStoredFilterEditor';
import { t } from '@/text';

import { SessionTalkStepBack } from './SessionTalkStepBack';

/**
 * Matching reads one Home's Sessions: the preview resolves on this session's Home (an empty Home list
 * matches nothing), never Runs. The editor hides "Started by" for Sessions, so it must not narrow either.
 */
export function createSessionTalkMatchingFilter(serverId: string): SessionListFilterV1 {
  return normalizeSessionListFilterV1({
    show: 'sessions',
    startedBy: ['you', 'agents', 'triggers'],
    homeServerIds: [serverId],
  });
}

/**
 * The To picker's Matching step: the Sessions list's own filter editor, inline in the same picker. The
 * footer says whom the filter reaches now (the Action's own preview); "Use these" keeps the filter as
 * the selector, never the rows it shows.
 */
export function SessionTalkMatchingStep(
  props: Readonly<{
    serverId: string;
    filter: SessionListFilterV1;
    onFilterChange: (next: SessionListFilterV1) => void;
    /** One line: whom it reaches now, or why that isn't known. */
    summary: string;
    canUse: boolean;
    onUse: () => void;
    /** Absent when a phone sheet pushed the step: its header's Back returns to To. */
    onBack?: () => void;
    /** The picker's frame; the editor scrolls inside it so the picker keeps its size. */
    frameHeight?: number;
  }>,
) {
  const { onFilterChange, serverId } = props;
  const [backHeight, setBackHeight] = React.useState(0);
  const onBackLayout = React.useCallback((event: LayoutChangeEvent) => {
    setBackHeight(Math.ceil(event.nativeEvent.layout.height));
  }, []);

  return (
    <View testID="session-talk-matching">
      <View onLayout={onBackLayout}>
        {props.onBack ? <SessionTalkStepBack testID="session-talk-matching-back" onBack={props.onBack} /> : null}
      </View>
      <SessionListStoredFilterEditor
        serverId={serverId}
        filter={props.filter}
        onFilterChange={onFilterChange}
        onReset={() => onFilterChange(createSessionTalkMatchingFilter(serverId))}
        summary={props.summary}
        doneLabel={t('session.participants.talk.useThese')}
        canDone={props.canUse}
        onDone={props.onUse}
        maxHeight={
          props.frameHeight
            ? Math.max(0, props.frameHeight - backHeight)
            : undefined
        }
      />
    </View>
  );
}
