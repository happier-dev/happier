export function applyProfileToProcessEnv(params: Readonly<{
  profileId: string;
  envOverlayExpanded: Record<string, string>;
}>): ReadonlyArray<string> {
  process.env.HAPPIER_SESSION_PROFILE_ID = params.profileId;

  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(params.envOverlayExpanded)) {
    if (typeof value !== 'string') continue;
    process.env[key] = value;
    appliedKeys.push(key);
  }

  return appliedKeys;
}

