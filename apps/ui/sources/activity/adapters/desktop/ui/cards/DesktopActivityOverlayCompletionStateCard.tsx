import * as React from 'react';
import { View } from 'react-native';

import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type {
    DesktopActivityOverlayActionDescriptor,
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
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
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
                    onAction={props.onAction}
                />
            </DesktopActivityOverlayCardFrame>
        </View>
    );
}
