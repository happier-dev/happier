import * as React from 'react';
import {
  resetApprovalProfileActionV1,
  setApprovalProfileActionPolicyV1,
} from '@happier-dev/protocol/actions/actionAudiencePolicy';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
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

/** Whose Approval settings the Actions screens edit: the Account's own rows, or one saved profile's overlay of them. */
export type ActionSettingsTarget =
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'profile'; id: string }>;

export const ACCOUNT_ACTION_SETTINGS_TARGET: ActionSettingsTarget =
  Object.freeze({ kind: 'account' });

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
  profiles: readonly ApprovalProfileV1[];
  profileRows: readonly ReadableApprovalProfileV1[];
  machineApprovalProfiles: Readonly<Record<string, string>>;
  settings: ActionsSettingsV1;
}> {
  const raw = useSetting('actionsSettingsV1');
  const account = React.useMemo(() => normalizeActionsSettingsV1(raw), [raw]);
  const profileId = target.kind === 'profile' ? target.id : null;
  const { profiles, profileRows, selectionRow: profileRow, machineApprovalProfiles } = useApprovalProfiles(
    profileId, undefined, { demand: target.kind === 'profile' || options?.demandProfiles === true },
  );
  const profile = profileRow?.profile ?? null;
  const settings = React.useMemo(
    () => (profile ? applyApprovalProfileOverlayV1(account, profile) : account),
    [account, profile],
  );
  return React.useMemo(
    () => ({ account, profile, profileRow, profiles, profileRows, machineApprovalProfiles, settings }),
    [account, profile, profileRow, profiles, profileRows, machineApprovalProfiles, settings],
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
): ActionPolicySetInput | null {
  const { target, account, profileRows, input } = params;
  if (target.kind === 'account' || 'profileChange' in input) return input;
  const row = profileRows.find((candidate) => candidate.id === target.id);
  if (!row || ('scope' in input && input.scope !== undefined)) return null;
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
): ActionPolicySetInput {
  return {
    profileChange: {
      kind: 'update',
      id: row.id,
      expectedRevision: row.revision,
      profile: toApprovalProfileContentV1(resetApprovalProfileActionV1(row.profile, actionId)),
    },
  };
}
