import type { SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

import { buildDesktopActivityOverlayAttentionMarks, buildDesktopActivityOverlayCollapsedModel } from './model/buildDesktopActivityOverlayCollapsedModel';
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
    const needsYou = params.sharedActivity.entries.flatMap(entry => entry.activity === 'needsYou' ? [entry.id] : []);
    const rows = buildDesktopActivityOverlaySessionRows(params.snapshot.sessions, needsYou);
    const cards = buildDesktopActivityOverlayExpandedCards(params.snapshot, rows);

    return {
        visible: params.policy.enabled && (params.sharedActivity.visible || params.snapshot.conversation !== null),
        generatedAt: params.snapshot.generatedAt,
        faces: params.snapshot.bots,
        attention: buildDesktopActivityOverlayAttentionMarks({ snapshot: params.snapshot, sharedActivity: params.sharedActivity }),
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
