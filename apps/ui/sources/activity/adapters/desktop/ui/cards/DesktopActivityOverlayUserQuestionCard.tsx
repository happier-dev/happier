import * as React from 'react';
import type { View } from 'react-native';

import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from '../shared/desktopActivityOverlaySelectors';
import type {
    DesktopActivityOverlayActionHandler,
    DesktopActivityOverlayExpandedCard,
} from '../shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayCardActions } from './DesktopActivityOverlayCardActions';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';
import { resolveDesktopActivityOverlayRequestCardActions } from './resolveDesktopActivityOverlayCardActions';

type UserQuestionCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'user_question' }>;

export function DesktopActivityOverlayUserQuestionCard(props: Readonly<{
    card: UserQuestionCard;
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
    initialFocusActionId?: string | null;
    initialFocusRef?: React.Ref<View>;
    onAction?: DesktopActivityOverlayActionHandler;
    onDismissKey?: () => void;
}>): React.ReactElement {
    const actions = resolveDesktopActivityOverlayRequestCardActions(props.card);
    // The asker's options are equal answers (chips); only the allow/deny fallback is a decision.
    const layout = actions.some((action) => action.tone === 'primary') ? 'decision' : 'choices';

    return (
        <DesktopActivityOverlayCardFrame
            testID={props.testID}
            visualMode={props.visualMode}
            ask
            title={props.card.title}
            body={props.card.body}
            badgeText={props.card.count > 1 ? String(props.card.count) : null}
        >
            <DesktopActivityOverlayCardActions
                cardId={props.card.id}
                visualMode={props.visualMode}
                actions={actions}
                layout={layout}
                inlineQuestionText={props.card.questionText ?? props.card.title}
                initialFocusActionId={props.initialFocusActionId}
                initialFocusRef={props.initialFocusRef}
                onAction={props.onAction}
                onDismissKey={props.onDismissKey}
            />
        </DesktopActivityOverlayCardFrame>
    );
}
