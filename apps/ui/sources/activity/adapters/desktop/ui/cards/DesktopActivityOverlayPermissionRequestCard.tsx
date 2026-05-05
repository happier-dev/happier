import * as React from 'react';

import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayExpandedCard,
} from '../shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayCardActions } from './DesktopActivityOverlayCardActions';
import { DesktopActivityOverlayCardFrame } from './DesktopActivityOverlayCardFrame';
import { resolveDesktopActivityOverlayRequestCardActions } from './resolveDesktopActivityOverlayCardActions';

type PermissionRequestCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }>;

export function DesktopActivityOverlayPermissionRequestCard(props: Readonly<{
    card: PermissionRequestCard;
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
            body={props.card.summary ?? props.card.questionText}
            badgeText={props.card.count > 1 ? String(props.card.count) : null}
        >
            <DesktopActivityOverlayCardActions
                cardId={props.card.requestId}
                visualMode={props.visualMode}
                actions={actions}
                onAction={props.onAction}
            />
        </DesktopActivityOverlayCardFrame>
    );
}
