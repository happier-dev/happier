import type { SharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { DesktopActivityOverlayAttentionMark, DesktopActivityOverlayModel } from './desktopActivityOverlayModelTypes';

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

/**
 * The Sessions a side dock's rest stacks beside the faces: the shared projection decides who needs you; a
 * Bot already drawn as a face is not marked twice. Identity comes from the selected Session snapshot.
 */
export function buildDesktopActivityOverlayAttentionMarks(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    sharedActivity: SharedActivityProjection;
}>): readonly DesktopActivityOverlayAttentionMark[] {
    const needsYou = params.sharedActivity.entries.filter(entry => entry.activity === 'needsYou');
    if (needsYou.length === 0) return NO_MARKS;
    const faces = new Set(params.snapshot.bots.faces.map(face => sessionAddressKey(face)));
    const sessions = new Map(params.snapshot.sessions.flatMap(session => session.serverId
        ? [[sessionAddressKey({ serverId: session.serverId, sessionId: session.sessionId }), session] as const] : []));
    return needsYou.flatMap(entry => {
        if (faces.has(entry.id)) return [];
        const session = sessions.get(entry.id);
        return [{ serverId: entry.address.serverId, sessionId: entry.address.sessionId, agentId: session?.agentId ?? null,
            machineId: session?.machineId ?? null, botFace: session?.botFace ?? null }];
    });
}

const NO_MARKS: readonly DesktopActivityOverlayAttentionMark[] = Object.freeze([]);
