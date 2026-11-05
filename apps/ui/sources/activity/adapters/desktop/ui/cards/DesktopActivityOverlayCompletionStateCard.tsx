import * as React from 'react';
import { View } from 'react-native';

import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import type {
    DesktopActivityOverlayActionHandler,
    DesktopActivityOverlayExpandedCard,
} from '../shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayCardActions } from './DesktopActivityOverlayCardActions';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';
import { resolveDesktopActivityOverlayCompletionStateActions } from './resolveDesktopActivityOverlayCardActions';

type CompletionStateCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'completion_state' }>;

export function DesktopActivityOverlayCompletionStateCard(props: Readonly<{
    card: CompletionStateCard;
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
    initialFocusActionId?: string | null;
    initialFocusRef?: React.Ref<View>;
    onAction?: DesktopActivityOverlayActionHandler;
}>): React.ReactElement {
    const actions = resolveDesktopActivityOverlayCompletionStateActions(props.card);
    const variantKey = props.card.variant === 'turn_complete'
        ? 'turn'
        : props.card.variant === 'subagent_done'
            ? 'subagent'
            : 'tool';

    return (
        <View
            data-auto-dismiss-ms={props.card.autoDismissMs}
            data-sticky={props.card.sticky}
            data-variant={props.card.variant}
            testID={`desktop-activity-overlay-completion-${variantKey}`}
        >
            <DesktopActivityOverlayCardFrame
                testID={props.testID}
                visualMode={props.visualMode}
                title={props.card.title}
                body={props.card.summary}
            >
                <DesktopActivityOverlayCardActions
                    cardId={props.card.sessionId}
                    visualMode={props.visualMode}
                    actions={actions}
                    initialFocusActionId={props.initialFocusActionId}
                    initialFocusRef={props.initialFocusRef}
                    onAction={props.onAction}
                />
            </DesktopActivityOverlayCardFrame>
        </View>
    );
}
