import * as React from 'react';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import {
    useProjectedQualifiedConnectedAccountTargetPresentations,
    type ProjectedQualifiedConnectedAccountTarget,
} from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import type { QualifiedConnectedAccountTargetPresentation } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';

/** The account or pool the limit was recorded against; null when the limit names none. */
export function readUsageLimitAccountTarget(
    issue: Pick<SessionRuntimeIssueV1, 'usageLimit'> | null | undefined,
): ProjectedQualifiedConnectedAccountTarget | null {
    const connected = issue?.usageLimit?.connectedService;
    const service = connected ? parseQualifiedPluginContributionKey(connected.serviceId) : null;
    if (!connected || !service) return null;
    if (connected.groupId) return { key: 'limited', target: { kind: 'group', service, groupId: connected.groupId } };
    return connected.profileId
        ? { key: 'limited', target: { kind: 'account', account: { service, accountId: connected.profileId } } }
        : null;
}

/** The shared target presenter's name plus the identity that tells same-named accounts apart. */
export function formatUsageLimitAccountLabel(
    presentation: QualifiedConnectedAccountTargetPresentation | undefined,
): string | null {
    if (!presentation || presentation.targetMissing) return null;
    return [presentation.primaryLabel, presentation.identityLabel].filter(Boolean).join(' · ') || null;
}

const NO_TARGETS: readonly ProjectedQualifiedConnectedAccountTarget[] = [];

/** Mounted only with the usage-limit card: names the limited account through the one target presenter. */
export function useUsageLimitAccountLabel(
    issue: SessionRuntimeIssueV1 | null | undefined,
    serverId: string | null | undefined,
): string | null {
    const targets = React.useMemo(() => {
        const target = readUsageLimitAccountTarget(issue);
        return target ? [target] : NO_TARGETS;
    }, [issue]);
    const { presentationsByKey } = useProjectedQualifiedConnectedAccountTargetPresentations(serverId, targets);
    return formatUsageLimitAccountLabel(presentationsByKey.limited);
}
