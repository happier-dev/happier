import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { clearNewSessionOrdinaryEntryDraftIdExact } from '@/sync/domains/settings/localOnlyAccountSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
    captureSessionDraftCurrentness,
    captureSessionDraftLaunchCurrentness,
    clearSessionDraftCurrentness,
    clearSessionDraftLaunchCurrentness,
    readSessionDraftLaunchCurrentness,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

function addressFor(draftId: string) {
    return { kind: 'newSession' as const, draftId };
}

/**
 * Captures the submitted field revisions before execution receives custody.
 * The token is local-only, but crash-stable, so terminal re-entry can clear
 * exactly those revisions without deleting edits made after submission.
 */
export function captureNewSessionDraftLaunchCurrentness(params: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    launchUserAttemptId: string;
}>): SessionDraftCurrentness | null {
    const address = addressFor(params.draftId);
    return captureSessionDraftLaunchCurrentness({
        scope: params.scope,
        address,
        userAttemptId: params.launchUserAttemptId,
    });
}

export function captureNewSessionDraftWorkflowCurrentness(params: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
}>): SessionDraftCurrentness {
    return captureSessionDraftCurrentness({
        scope: params.scope,
        address: addressFor(params.draftId),
    });
}

/**
 * Completes launch custody by clearing only fields whose mutation ids still
 * match the submitted snapshot. Later edits remain in the same draft.
 */
export async function clearCapturedNewSessionDraftAfterLaunch(params: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    currentness?: SessionDraftCurrentness | null;
    launchUserAttemptId?: string | null;
}>): Promise<void> {
    const address = addressFor(params.draftId);
    const launchUserAttemptId = params.launchUserAttemptId?.trim() || null;
    const currentness = launchUserAttemptId
        ? readSessionDraftLaunchCurrentness({
            scope: params.scope,
            address,
            userAttemptId: launchUserAttemptId,
        })
        : params.currentness ?? null;
    if (currentness) {
        await clearSessionDraftCurrentness({ scope: params.scope, address, currentness });
    }
    if (launchUserAttemptId) {
        clearSessionDraftLaunchCurrentness({
            scope: params.scope,
            address,
            userAttemptId: launchUserAttemptId,
        });
    }
    const pointerDelta = clearNewSessionOrdinaryEntryDraftIdExact(
        getStorage().getState().settings ?? settingsDefaults,
        params.draftId,
    );
    if (pointerDelta) {
        getSyncSingleton().applySettings(pointerDelta, { source: 'ui' });
    }
}
