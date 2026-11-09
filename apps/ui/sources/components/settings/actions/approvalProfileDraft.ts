import type {
  ApprovalProfileModeV1,
  ApprovalProfileV1,
} from '@happier-dev/protocol/actions';

import { randomUUID } from '@/platform/randomUUID';

/** What the profile editor changes: a name, the default, and the two category overlays. */
export type ApprovalProfileDraft = Readonly<{
  id: string;
  name: string;
  defaultMode: ApprovalProfileModeV1;
  safe: ApprovalProfileModeV1;
  danger: ApprovalProfileModeV1;
  /** Per-Action overrides the editor does not show; kept as they were. */
  actions?: ApprovalProfileV1['actions'];
}>;

export function draftFromApprovalProfile(
  profile: ApprovalProfileV1 | null,
): ApprovalProfileDraft {
  if (!profile)
    return {
      id: `custom:${randomUUID()}`,
      name: '',
      defaultMode: 'ask',
      safe: 'ask',
      danger: 'ask',
    };
  return {
    id: profile.id,
    name: profile.name,
    defaultMode: profile.defaultMode,
    safe: profile.categories?.safe ?? profile.defaultMode,
    danger: profile.categories?.danger ?? profile.defaultMode,
    ...(profile.actions ? { actions: profile.actions } : {}),
  };
}

/** The saved profile, or null while it has no name. An overlay equal to the default is not stored. */
export function approvalProfileFromDraft(
  draft: ApprovalProfileDraft,
): ApprovalProfileV1 | null {
  const name = draft.name.trim();
  if (!name) return null;
  const categories = {
    ...(draft.safe !== draft.defaultMode ? { safe: draft.safe } : {}),
    ...(draft.danger !== draft.defaultMode ? { danger: draft.danger } : {}),
  };
  return {
    id: draft.id,
    name,
    defaultMode: draft.defaultMode,
    ...(draft.actions ? { actions: draft.actions } : {}),
    ...(Object.keys(categories).length > 0 ? { categories } : {}),
  };
}
