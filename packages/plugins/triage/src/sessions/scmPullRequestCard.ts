import * as React from 'react';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, ScmPullRequestSummaryProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { usePluginHostApi, useSurfaceContext } from '@happier-dev/plugin-ui';

import { chooseAndLinkTriageSnapshotPullRequestV1, linkTriageSnapshotPullRequestV1, type TriageSnapshotPullRequestLinkResultV1 } from './scmPullRequestLink.js';
import { projectTriageSessionPullRequestCardsV1, useTriageSessionPullRequestStatusV1, type TriageSessionPullRequestProjectionSnapshotV1,
    type TriageSessionPullRequestCardV1 } from './sessionPullRequestStatus.js';

/** The existing SCM mount stamps Home; Session authority remains its mounted target. */
export const TriageScmPullRequestCardInputV1Schema = defineProtocolObject({
    homeServerId: defineProtocolString({ minLength: 1 }), pullRequest: ScmPullRequestSummaryProtocolSchema.optional(),
    origin: defineProtocolLiteral('createdHere').optional(),
}, { policy: 'closed' });
const selectResource = (snapshot: TriageSessionPullRequestProjectionSnapshotV1) => snapshot;
export type TriageScmPullRequestCardControllerV1 = Readonly<{
    cards: readonly TriageSessionPullRequestCardV1[];
    /** The PR was just created from this Session's pane: an intent to link, never an unlinked branch hint. */
    createdHere: boolean;
    linkCreatedHere: boolean;
    resource: TriageSessionPullRequestProjectionSnapshotV1;
    refresh: ReturnType<typeof useTriageSessionPullRequestStatusV1<TriageSessionPullRequestProjectionSnapshotV1>>['refresh'];
    link(signal?: AbortSignal): Promise<TriageSnapshotPullRequestLinkResultV1 | null>;
}>;

/** Data and admitted Actions only. The actual demanded Opus body owns presentation. */
export function useTriageScmPullRequestCardV1(launchInput: unknown, options?: Readonly<{ enabled?: boolean }>): TriageScmPullRequestCardControllerV1 {
    const host = usePluginHostApi();
    const { target } = useSurfaceContext();
    const input = React.useMemo(() => TriageScmPullRequestCardInputV1Schema.safeParse(launchInput), [launchInput]);
    const sessionId = target.kind === 'session' ? target.sessionId : null;
    const enabled = options?.enabled !== false && input.success;
    // Project-only branch discovery does not acquire Session metadata/native status.
    const { value: resource, refresh } = useTriageSessionPullRequestStatusV1(selectResource, enabled && sessionId !== null);
    const cards = React.useMemo(() => input.success
        ? projectTriageSessionPullRequestCardsV1(input.data.pullRequest, sessionId, resource.value) : [],
    [input, resource.value, sessionId]);
    // Channels owns attachment; an unavailable read must not prevent a created PR
    // from being linked. A ready projection still supplies the already-linked card.
    const createdHere = enabled && input.success && input.data.origin === 'createdHere' && sessionId !== null;
    const linkCreatedHere = createdHere;
    const link = React.useCallback(async (signal?: AbortSignal) => {
        if (!enabled || !input.success || !input.data.pullRequest) return null;
        const operand = { homeServerId: input.data.homeServerId, pullRequest: input.data.pullRequest };
        const result = sessionId === null
            ? await chooseAndLinkTriageSnapshotPullRequestV1(host, operand, { signal })
            : await linkTriageSnapshotPullRequestV1(host, { ...operand,
                session: { serverId: operand.homeServerId, sessionId } }, { signal });
        if (result.kind === 'attached' && sessionId !== null) await refresh();
        return result;
    }, [enabled, host, input, refresh, sessionId]);
    return React.useMemo(() => ({ cards, resource, refresh, link, createdHere, linkCreatedHere }),
        [cards, createdHere, link, linkCreatedHere, refresh, resource]);
}
