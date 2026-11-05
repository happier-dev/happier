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

type PermissionRequestCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }>;

export function DesktopActivityOverlayPermissionRequestCard(props: Readonly<{
    card: PermissionRequestCard;
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
    initialFocusActionId?: string | null;
    initialFocusRef?: React.Ref<View>;
    onAction?: DesktopActivityOverlayActionHandler;
}>): React.ReactElement {
    const actions = resolveDesktopActivityOverlayRequestCardActions(props.card);

    return (
        <DesktopActivityOverlayCardFrame
            testID={props.testID}
            visualMode={props.visualMode}
            ask
            eyebrow={props.card.toolLabel}
            title={props.card.title}
            subject={props.card.subject}
            body={props.card.body}
            badgeText={props.card.count > 1 ? String(props.card.count) : null}
        >
            <DesktopActivityOverlayCardActions
                cardId={props.card.id}
                visualMode={props.visualMode}
                actions={actions}
                initialFocusActionId={props.initialFocusActionId}
                initialFocusRef={props.initialFocusRef}
                onAction={props.onAction}
            />
        </DesktopActivityOverlayCardFrame>
    );
}
