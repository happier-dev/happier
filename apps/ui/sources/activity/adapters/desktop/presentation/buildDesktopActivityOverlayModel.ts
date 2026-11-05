import type { SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

import { buildDesktopActivityOverlayCollapsedModel } from './model/buildDesktopActivityOverlayCollapsedModel';
import {
    buildDesktopActivityOverlayExpandedCards,
    buildDesktopActivityOverlaySessionRows,
} from './model/buildDesktopActivityOverlayExpandedCards';
import type {
    DesktopActivityOverlayModel,
} from './model/desktopActivityOverlayModelTypes';
import type { DesktopActivityOverlaySnapshot } from './snapshot/desktopActivityOverlaySnapshotTypes';

export type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from './model/desktopActivityOverlayModelTypes';

export function buildDesktopActivityOverlayModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    policy: DesktopOverlayPolicy;
    sharedActivity: SharedActivityProjection;
}>): DesktopActivityOverlayModel {
    const rows = buildDesktopActivityOverlaySessionRows(params.snapshot.sessions);
    const cards = buildDesktopActivityOverlayExpandedCards(params.snapshot);

    return {
        visible: params.policy.enabled && (params.sharedActivity.visible || params.snapshot.conversation !== null),
        generatedAt: params.snapshot.generatedAt,
        faces: params.snapshot.bots,
        conversation: params.snapshot.conversation,
        collapsed: buildDesktopActivityOverlayCollapsedModel({
            snapshot: params.snapshot,
            sharedActivity: params.sharedActivity,
        }),
        expanded: {
            title: params.snapshot.labels.sessionsTitle,
            rows,
            cards,
        },
    };
}
