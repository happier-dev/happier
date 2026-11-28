import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type RuntimeRecoverySelection =
  | Readonly<{
      kind: 'profile';
      serviceId: string;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: string;
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

function shouldUseDurableSelection<TSelection extends RuntimeRecoverySelection>(
  selection: TSelection | null,
  reportedGroupId: string,
  preferDurableGroup: boolean,
): selection is TSelection {
  if (!selection) return false;
  if (selection.kind === 'profile') return true;
  return !preferDurableGroup
    || !reportedGroupId
    || matchesReportedGroupId(selection, reportedGroupId);
}

/**
 * A runner can still be on the direct account it was launched with after its session was bound to
 * a pool (the pool restart is pending or was missed). Its failure is a pool member's failure: route
 * recovery through the session's current pool instead of waiting for that account to reset.
 */
export function resolveRuntimeRecoverySelectionThroughBoundPool(input: Readonly<{
  selection: RuntimeRecoverySelection;
  trackedConnectedServices: unknown;
}>): RuntimeRecoverySelection {
  if (input.selection.kind !== 'profile') return input.selection;
  const serviceId = input.selection.serviceId;
  const boundPool = parseConnectedServiceBindingSelections(input.trackedConnectedServices)
    .find((candidate) => candidate.serviceId === serviceId && candidate.kind === 'group');
  if (!boundPool || boundPool.kind !== 'group') return input.selection;
  return {
    kind: 'group',
    serviceId,
    groupId: boundPool.groupId,
    activeProfileId: input.selection.profileId,
    fallbackProfileId: input.selection.profileId,
  };
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
  const serviceId = normalizeNonEmptyString(input.classification.serviceId);
  if (!serviceId) return { selection: null, source: null };

  const reportedProfileId = normalizeNonEmptyString(input.classification.profileId);
  const reportedGroupId = normalizeNonEmptyString(input.classification.groupId);
  const preferDurableGroup = Boolean(reportedProfileId);

  const childEnvSelection = readConnectedServiceChildSelectionsFromEnv(
    input.environmentVariables ?? {},
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (shouldUseDurableSelection(childEnvSelection, reportedGroupId, preferDurableGroup)) {
    if (childEnvSelection.kind === 'profile') {
      return {
        selection: {
          kind: 'profile',
          serviceId: childEnvSelection.serviceId,
          profileId: childEnvSelection.profileId,
        },
        source: 'child_env',
      };
    }
    return {
      selection: {
        kind: 'group',
        serviceId: childEnvSelection.serviceId,
        groupId: childEnvSelection.groupId,
        activeProfileId: childEnvSelection.activeProfileId,
        fallbackProfileId: reportedProfileId || childEnvSelection.fallbackProfileId,
      },
      source: 'child_env',
    };
  }

  const trackedSelection = parseConnectedServiceBindingSelections(
    input.trackedConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (shouldUseDurableSelection(trackedSelection, reportedGroupId, preferDurableGroup)) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(trackedSelection, reportedProfileId),
      source: 'tracked_spawn_options',
    };
  }

  const metadataSelection = parseConnectedServiceBindingSelections(
    input.sessionMetadataConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (shouldUseDurableSelection(metadataSelection, reportedGroupId, preferDurableGroup)) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(metadataSelection, reportedProfileId),
      source: 'session_metadata',
    };
  }
  if (reportedProfileId) {
    if (reportedGroupId) {
      return {
        selection: {
          kind: 'group',
          serviceId,
          groupId: reportedGroupId,
          fallbackProfileId: reportedProfileId,
        },
        source: 'classification',
      };
    }
    return {
      selection: {
        kind: 'profile',
        serviceId,
        profileId: reportedProfileId,
      },
      source: 'classification',
    };
  }
  return { selection: null, source: null };
}
