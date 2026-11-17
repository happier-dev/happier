import * as React from 'react';
import {
  resetApprovalProfileActionV1,
  setApprovalProfileActionPolicyV1,
} from '@happier-dev/protocol/actions/actionAudiencePolicy';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  applyApprovalProfileOverlayV1,
  type ApprovalProfileV1,
  type ReadableApprovalProfileV1,
} from '@happier-dev/protocol/actions/approvalProfiles';
import { toApprovalProfileContentV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import {
  normalizeActionsSettingsV1,
  type ActionSettingsActionId,
  type ActionsSettingsV1,
} from '@happier-dev/protocol/actions/actionSettings';

import { useSetting } from '@/sync/domains/state/storage';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { readArtifactAccessCapabilities, type ArtifactAccessCapabilities } from '@/sync/domains/artifacts/artifactAccessCapabilities';

/** Whose Approval settings the Actions screens edit: the Account's own rows, or one saved profile's overlay of them. */
export type ActionSettingsTarget =
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'profile'; id: string }>;

export const ACCOUNT_ACTION_SETTINGS_TARGET: ActionSettingsTarget =
  Object.freeze({ kind: 'account' });

export type ApprovalProfileCapabilities = ArtifactAccessCapabilities & Readonly<{
  isOwner: boolean;
  canDelete: boolean;
  canCopy: boolean;
}>;

export type ActionSettingsTargetWrite = ActionPolicySetInput | ActionExecuteFailure;

const FORBIDDEN_PROFILE_WRITE: ActionExecuteFailure = { ok: false, errorCode: 'forbidden', error: 'forbidden' };

function readApprovalProfileCapabilities(access: ReadableApprovalProfileV1['access'] | null): ApprovalProfileCapabilities | null {
  if (access === null) return null;
  const isOwner = access === 'owner';
  return { ...readArtifactAccessCapabilities(access), isOwner, canDelete: isOwner, canCopy: true };
}

/**
 * The settings a target's rows show: the Account's own, or the Account with the profile laid over it by the
 * overlay owner the router uses, so a row reads exactly what the profile's Sessions get.
 */
export function useActionSettingsForTarget(
  target: ActionSettingsTarget,
  options?: Readonly<{ demandProfiles?: boolean }>,
): Readonly<{
  account: ActionsSettingsV1;
  profile: ApprovalProfileV1 | null;
  profileRow: ReadableApprovalProfileV1 | null;
  profileCapabilities: ApprovalProfileCapabilities | null;
  profiles: readonly ApprovalProfileV1[];
  profileRows: readonly ReadableApprovalProfileV1[];
  machineApprovalProfiles: Readonly<Record<string, string>>;
  settings: ActionsSettingsV1;
  /**
   * Whether a profile target's own row is known. Until it is, `settings` are only the Account's, so a profile page
   * must not present them as the profile's (QA-B E9); `missing` is a settled catalog without this profile.
   */
  profileStatus: 'ready' | 'loading' | 'unavailable' | 'missing';
  retryProfile: () => Promise<void>;
}> {
  const raw = useSetting('actionsSettingsV1');
  const account = React.useMemo(() => normalizeActionsSettingsV1(raw), [raw]);
  const profileId = target.kind === 'profile' ? target.id : null;
  const { profiles, profileRows, selectionRow: profileRow, machineApprovalProfiles, ready, unavailable, requestCatalog } = useApprovalProfiles(
    profileId, undefined, { demand: target.kind === 'profile' || options?.demandProfiles === true },
  );
  const profile = profileRow?.profile ?? null;
  const profileAccess = profileRow?.access ?? null;
  const profileCapabilities = React.useMemo(() => readApprovalProfileCapabilities(profileAccess), [profileAccess]);
  const settings = React.useMemo(
    () => (profile ? applyApprovalProfileOverlayV1(account, profile) : account),
    [account, profile],
  );
  const profileStatus = target.kind !== 'profile' || profileRow !== null ? 'ready'
    : unavailable ? 'unavailable' : ready ? 'missing' : 'loading';
  return React.useMemo(
    () => ({ account, profile, profileRow, profileCapabilities, profiles, profileRows, machineApprovalProfiles, settings,
      profileStatus, retryProfile: requestCatalog }),
    [account, profile, profileRow, profileCapabilities, profiles, profileRows, machineApprovalProfiles, settings,
      profileStatus, requestCatalog],
  );
}

/** Whether this profile sets the Action itself, or the Action still follows the Account. */
export function approvalProfileSetsAction(
  profile: ApprovalProfileV1 | null | undefined,
  actionId: string,
): boolean {
  return (
    profile?.actions?.[actionId] !== undefined ||
    profile?.approvalWaivedSurfaces?.[actionId] !== undefined
  );
}

/**
 * The write one Settings intent means for a target. The Account takes the intent as it is. A profile takes its own
 * row for that Action, built by the profile owner from the per-surface choice; a profile carries per-surface use and
 * approval only, so placements, tool exposure, per-Machine choices and whole-Action Off return null (the profile
 * screens never offer them).
 */
export function resolveActionSettingsTargetWrite(
  params: Readonly<{
    target: ActionSettingsTarget;
    account: ActionsSettingsV1;
    profileRows: readonly ReadableApprovalProfileV1[];
    input: ActionPolicySetInput;
  }>,
): ActionSettingsTargetWrite | null {
  const { target, account, profileRows, input } = params;
  if (target.kind === 'account') return input;
  if ('profileChange' in input) {
    const change = input.profileChange;
    if (change.kind === 'create' || change.kind === 'machine_default') return input;
    const row = profileRows.find(candidate => candidate.id === change.id);
    if (!row) return null;
    const capabilities = readApprovalProfileCapabilities(row.access);
    return (change.kind === 'delete' ? capabilities?.canDelete : capabilities?.canEdit)
      ? input : FORBIDDEN_PROFILE_WRITE;
  }
  const row = profileRows.find((candidate) => candidate.id === target.id);
  if (!row || ('scope' in input && input.scope !== undefined)) return null;
  if (!readApprovalProfileCapabilities(row.access)?.canEdit) return FORBIDDEN_PROFILE_WRITE;
  const profile = row.profile;
  const actionId = input.actionId as ActionSettingsActionId;
  if ('change' in input) {
    if (
      input.change.kind !== 'audience_enabled' ||
      input.change.audience === 'foreign_session_html'
    )
      return null;
    return {
      profileChange: {
        kind: 'update',
        id: row.id,
        expectedRevision: row.revision,
        profile: toApprovalProfileContentV1(setApprovalProfileActionPolicyV1(
          account,
          profile,
          actionId,
          input.change.audience,
          input.change.enabled ? 'default' : 'off',
        )),
      },
    };
  }
  if (!('audience' in input) || input.audience === 'foreign_session_html')
    return null;
  return {
    profileChange: {
      kind: 'update',
      id: row.id,
      expectedRevision: row.revision,
      profile: toApprovalProfileContentV1(setApprovalProfileActionPolicyV1(
        account,
        profile,
        actionId,
        input.audience,
        input.mode,
      )),
    },
  };
}

/** "Use Account setting": the profile stops naming this Action, so it follows the Account again. */
export function buildApprovalProfileActionResetChange(
  row: ReadableApprovalProfileV1,
  actionId: ActionSettingsActionId,
): ActionSettingsTargetWrite {
  if (!readApprovalProfileCapabilities(row.access)?.canEdit) return FORBIDDEN_PROFILE_WRITE;
  return {
    profileChange: {
      kind: 'update',
      id: row.id,
      expectedRevision: row.revision,
      profile: toApprovalProfileContentV1(resetApprovalProfileActionV1(row.profile, actionId)),
    },
  };
}
