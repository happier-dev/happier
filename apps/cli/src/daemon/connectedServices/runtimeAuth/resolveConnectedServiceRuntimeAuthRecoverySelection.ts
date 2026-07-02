import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type RuntimeRecoverySelection =
    | Readonly<{
        kind: 'profile';
        serviceId: ConnectedServiceId;
        profileId: string;
    }>
    | Readonly<{
        kind: 'group';
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId?: string;
        fallbackProfileId?: string;
    }>;

export type ConnectedServiceRuntimeAuthRecoverySelectionSource =
    | 'child_env'
    | 'tracked_spawn_options'
    | 'session_metadata'
    | 'classification';

type ResolvedRuntimeRecoverySelection = Readonly<{
    selection: RuntimeRecoverySelection | null;
    source: ConnectedServiceRuntimeAuthRecoverySelectionSource | null;
}>;

function normalizeNonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function parseConnectedServiceId(value: unknown): ConnectedServiceId | null {
    const parsed = ConnectedServiceIdSchema.safeParse(normalizeNonEmptyString(value));
    return parsed.success ? parsed.data as ConnectedServiceId : null;
}

function mapParsedBindingSelectionToRuntimeRecoverySelection(
    selection: RuntimeRecoverySelection | null,
    failedProfileId?: string,
): RuntimeRecoverySelection | null {
    if (selection?.kind === 'group' && failedProfileId) {
        return {
            ...selection,
            fallbackProfileId: failedProfileId,
        };
    }
    return selection;
}

function matchesReportedGroupId(
    selection: RuntimeRecoverySelection | null,
    reportedGroupId: string,
): boolean {
    return selection?.kind === 'group' && selection.groupId === reportedGroupId;
}

export function isGroupRuntimeRecoverySelection(
    selection: RuntimeRecoverySelection,
): selection is Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>> {
    return selection.kind === 'group';
}

export function resolveConnectedServiceRuntimeAuthRecoverySelection(input: Readonly<{
    classification: ConnectedServiceRuntimeFailureClassification;
    trackedConnectedServices?: unknown;
    sessionMetadataConnectedServices?: unknown;
    environmentVariables?: Readonly<Record<string, string | undefined>> | null;
}>): ResolvedRuntimeRecoverySelection {
    const serviceId = parseConnectedServiceId(input.classification.serviceId);
    if (!serviceId) return { selection: null, source: null };

    const reportedProfileId = normalizeNonEmptyString(input.classification.profileId);
    const reportedGroupId = normalizeNonEmptyString(input.classification.groupId);
    const preferDurableGroup = Boolean(reportedProfileId);

    const childEnvSelection = readConnectedServiceChildSelectionsFromEnv(
        input.environmentVariables ?? {},
    )?.get(serviceId) ?? null;
    if (
        childEnvSelection
        && (
            !preferDurableGroup
            || (
                childEnvSelection.kind === 'group'
                && (!reportedGroupId || matchesReportedGroupId(childEnvSelection, reportedGroupId))
            )
        )
    ) {
        if (childEnvSelection.kind === 'profile') {
            return {
                source: 'child_env',
                selection: {
                    kind: 'profile',
                    serviceId: childEnvSelection.serviceId,
                    profileId: childEnvSelection.profileId,
                },
            };
        }
        return {
            source: 'child_env',
            selection: {
                kind: 'group',
                serviceId: childEnvSelection.serviceId,
                groupId: childEnvSelection.groupId,
                activeProfileId: childEnvSelection.activeProfileId,
                fallbackProfileId: reportedProfileId || childEnvSelection.fallbackProfileId,
            },
        };
    }

    const trackedSelection = parseConnectedServiceBindingSelections(
        input.trackedConnectedServices,
    ).find((candidate) => candidate.serviceId === serviceId) ?? null;
    if (
        trackedSelection
        && (
            !preferDurableGroup
            || (
                trackedSelection.kind === 'group'
                && (!reportedGroupId || matchesReportedGroupId(trackedSelection, reportedGroupId))
            )
        )
    ) {
        return {
            source: 'tracked_spawn_options',
            selection: mapParsedBindingSelectionToRuntimeRecoverySelection(trackedSelection, reportedProfileId),
        };
    }

    const metadataSelection = parseConnectedServiceBindingSelections(
        input.sessionMetadataConnectedServices,
    ).find((candidate) => candidate.serviceId === serviceId) ?? null;
    if (
        metadataSelection
        && (
            !preferDurableGroup
            || (
                metadataSelection.kind === 'group'
                && (!reportedGroupId || matchesReportedGroupId(metadataSelection, reportedGroupId))
            )
        )
    ) {
        return {
            source: 'session_metadata',
            selection: mapParsedBindingSelectionToRuntimeRecoverySelection(metadataSelection, reportedProfileId),
        };
    }

    if (reportedProfileId) {
        if (reportedGroupId) {
            return {
                source: 'classification',
                selection: {
                    kind: 'group',
                    serviceId,
                    groupId: reportedGroupId,
                    fallbackProfileId: reportedProfileId,
                },
            };
        }
        return {
            source: 'classification',
            selection: {
                kind: 'profile',
                serviceId,
                profileId: reportedProfileId,
            },
        };
    }

    return { selection: null, source: null };
}
