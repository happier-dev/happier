import {
    HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
    HappierFocusLiveActivityContentStateV1Schema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import {
    buildLiveActivityInstanceKey,
    type LiveActivityIdentity,
} from '../liveActivities/liveActivityIdentity';
import { resolveLiveActivityUpdateBudget } from '../liveActivities/resolveLiveActivityUpdateBudget';

const BackgroundWakeActivityKeySchema = z.object({
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
}).strict();

const BackgroundWakePayloadSchema = z.object({
    type: z.literal('happier.liveActivityRemoteUpdate.v1'),
    v: z.literal(1),
    requestId: z.string().trim().min(1),
    createdAt: z.number().int().nonnegative(),
    event: z.enum(['update', 'end']),
    activityKey: BackgroundWakeActivityKeySchema,
    snapshotFingerprint: z.string().trim().min(1),
    contentState: HappierFocusLiveActivityContentStateV1Schema.nullable().optional(),
}).strict().superRefine((payload, ctx) => {
    if (payload.event !== 'update') return;
    if (payload.contentState !== null && payload.contentState !== undefined) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentState'],
        message: 'Background wake update payload requires content state',
    });
});

export type LiveActivityBackgroundWakeCurrentState = Readonly<{
    activityInstanceKey: string;
    generatedAt: number;
    snapshotFingerprint: string;
}> | null;

export type LiveActivityBackgroundWakeApplicationResult =
    | Readonly<{ action: 'apply_update'; snapshot: LiveActivitySnapshot; snapshotFingerprint: string }>
    | Readonly<{ action: 'apply_end'; activityInstanceKey: string }>
    | Readonly<{
        action: 'ignore';
        reason:
            | 'invalid_payload'
            | 'same_fingerprint'
            | 'older_than_current'
            | 'activity_mismatch';
    }>;

export function resolveLiveActivityBackgroundWakePayloadActivityInstanceKey(payload: unknown): string | null {
    const parsed = BackgroundWakePayloadSchema.safeParse(payload);
    if (!parsed.success) {
        return null;
    }

    return buildLiveActivityInstanceKey(buildIdentity(parsed.data.activityKey));
}

function resolveRelevanceScore(snapshot: Pick<LiveActivitySnapshot, 'attentionState'>): number {
    if (snapshot.attentionState === 'permission_required' || snapshot.attentionState === 'action_required') {
        return 100;
    }
    if (snapshot.attentionState === 'thinking') {
        return 50;
    }
    if (snapshot.attentionState === 'pending' || snapshot.attentionState === 'unread') {
        return 30;
    }
    return 10;
}

function buildIdentity(activityKey: z.infer<typeof BackgroundWakeActivityKeySchema>): LiveActivityIdentity {
    return {
        serverId: activityKey.serverId,
        sessionId: activityKey.sessionId,
        activityName: activityKey.activityName,
    };
}

function buildSnapshot(
    payload: z.infer<typeof BackgroundWakePayloadSchema> & Readonly<{
        event: 'update';
        contentState: NonNullable<z.infer<typeof BackgroundWakePayloadSchema>['contentState']>;
    }>,
): LiveActivitySnapshot {
    const identity = buildIdentity(payload.activityKey);
    const updateBudget = resolveLiveActivityUpdateBudget({
        attentionState: payload.contentState.attentionState,
        runtimeVisibility: 'background_or_locked',
    });
    const snapshot = {
        ...payload.contentState,
        serverId: identity.serverId,
        activityName: identity.activityName,
        activityInstanceKey: buildLiveActivityInstanceKey(identity),
        presentationTemplate: updateBudget.template,
        apnsPriority: updateBudget.apnsPriority,
        relevanceScore: 0,
    } satisfies Omit<LiveActivitySnapshot, 'relevanceScore'> & Readonly<{ relevanceScore: number }>;

    return {
        ...snapshot,
        relevanceScore: resolveRelevanceScore(snapshot),
    };
}

export function resolveLiveActivityBackgroundWakePayloadApplication(params: Readonly<{
    payload: unknown;
    current: LiveActivityBackgroundWakeCurrentState;
}>): LiveActivityBackgroundWakeApplicationResult {
    const parsed = BackgroundWakePayloadSchema.safeParse(params.payload);
    if (!parsed.success) {
        return { action: 'ignore', reason: 'invalid_payload' };
    }

    const identity = buildIdentity(parsed.data.activityKey);
    const activityInstanceKey = buildLiveActivityInstanceKey(identity);
    const current = params.current;
    if (current && current.activityInstanceKey !== activityInstanceKey) {
        return { action: 'ignore', reason: 'activity_mismatch' };
    }
    if (current && current.snapshotFingerprint === parsed.data.snapshotFingerprint) {
        return { action: 'ignore', reason: 'same_fingerprint' };
    }

    if (parsed.data.event === 'end') {
        if (current && current.generatedAt > parsed.data.createdAt) {
            return { action: 'ignore', reason: 'older_than_current' };
        }
        return { action: 'apply_end', activityInstanceKey };
    }

    const contentState = parsed.data.contentState;
    if (!contentState) {
        return { action: 'ignore', reason: 'invalid_payload' };
    }
    if (current && current.generatedAt > contentState.generatedAt) {
        return { action: 'ignore', reason: 'older_than_current' };
    }

    return {
        action: 'apply_update',
        snapshot: buildSnapshot({
            ...parsed.data,
            event: 'update',
            contentState,
        }),
        snapshotFingerprint: parsed.data.snapshotFingerprint,
    };
}
