import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import {
    SessionPullRequestLinkCompletionInputV1Schema,
    SessionPullRequestLinkCompletionResultV1Schema,
} from '@happier-dev/channels-protocol/v1';

import { ensureTriagePullRequestCompanionV1 } from '../sessions/sessionPullRequestPlacement.js';

export const TRIAGE_COMPLETE_PULL_REQUEST_LINK_ACTION_LOCAL_ID_V1 = 'sessions/complete-pull-request-link-v1';

/** The bound invocation owns the Account; no mounted client context is fabricated. */
export function createTriageCompletePullRequestLinkActionHandler(): ActionHandler<
    ReturnType<typeof SessionPullRequestLinkCompletionInputV1Schema.parse>,
    ReturnType<typeof SessionPullRequestLinkCompletionResultV1Schema.parse>
> {
    return async (input, context) => {
        try {
            if (context.signal.aborted) return { kind: 'unavailable' };
            const request = SessionPullRequestLinkCompletionInputV1Schema.parse(input);
            const options = { signal: context.signal };
            const profile = await context.services.actions.execute('account.profile.get', {}, options);
            if (context.signal.aborted || isPluginActionApprovalRequestCreated(profile)) return { kind: 'unavailable' };
            return { kind: await ensureTriagePullRequestCompanionV1(context.services.actions, request.session, profile.id, options) };
        } catch {
            // Placement is best effort after a known link; never replay its mutation.
            return { kind: 'unavailable' };
        }
    };
}
