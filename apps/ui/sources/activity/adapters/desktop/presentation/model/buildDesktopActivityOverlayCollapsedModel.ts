import type { SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';
import type { DesktopActivityOverlayModel } from './desktopActivityOverlayModelTypes';

/** The collapsed surface names shared activity; task/tool/path details belong in the opened list. */
export function buildDesktopActivityOverlayCollapsedModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    sharedActivity: SharedActivityProjection;
}>): DesktopActivityOverlayModel['collapsed'] {
    return {
        title: params.sharedActivity.word,
        activity: params.sharedActivity.activity,
        statusText: null,
        defaultTarget: params.snapshot.defaultTarget,
        sessionCount: null,
    };
}
