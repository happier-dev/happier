/** Existing list/publish and Artifact sharing Actions retain their incumbent ids. */
export const PROFILE_ACTION_IDS_V1 = [
  'launch_profiles.read', 'launch_profiles.search', 'launch_profiles.select',
  'launch_profiles.create', 'launch_profiles.edit', 'launch_profiles.save',
  'launch_profiles.duplicate', 'launch_profiles.enabled.set', 'launch_profiles.favorite.set',
  'launch_profiles.delete', 'launch_profiles.secrets.select', 'launch_profiles.legacy.preview',
  'launch_profiles.legacy.convert', 'launch_profiles.legacy.resolve_conflict', 'launch_profiles.draft.discard',
] as const;
export type ProfileActionIdV1 = typeof PROFILE_ACTION_IDS_V1[number];

export function isProfileActionIdV1(value: string): value is ProfileActionIdV1 {
  return (PROFILE_ACTION_IDS_V1 as readonly string[]).includes(value);
}
