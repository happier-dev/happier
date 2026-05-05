import * as React from 'react';

import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type {
    DesktopActivityOverlayActionDescriptor,
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
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement {
    const actions = resolveDesktopActivityOverlayRequestCardActions(props.card);

    return (
        <DesktopActivityOverlayCardFrame
            testID={props.testID}
            visualMode={props.visualMode}
            eyebrow={props.card.toolLabel}
            title={props.card.title}
            body={props.card.questionText ?? props.card.summary}
            badgeText={props.card.count > 1 ? String(props.card.count) : null}
        >
            <DesktopActivityOverlayCardActions
                cardId={props.card.requestId}
                visualMode={props.visualMode}
                actions={actions}
                inlineQuestionText={props.card.questionText ?? props.card.title}
                onAction={props.onAction}
            />
        </DesktopActivityOverlayCardFrame>
    );
}
