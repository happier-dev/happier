import { z } from 'zod';
import { BAKED_BUILD_DEFAULT_PROFILE_JSON } from './bakedBuildDefaultProfile.js';

const profileUrl = z.string().trim().url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}).transform((value) => value.replace(/\/+$/u, ''));

/** Shared field schemas for baked defaults and the future organization policy document. */
export const BuildDefaultProfileFields = {
  accountService: z.object({ url: profileUrl, locked: z.boolean().optional() }).strict().optional(),
  home: z.object({ url: profileUrl, webappUrl: profileUrl.optional(), locked: z.boolean().optional() }).strict().optional(),
  personalHome: z.object({ value: z.enum(['auto', 'offer', 'off']), locked: z.boolean().optional() }).strict().optional(),
};
export const BuildDefaultProfileSchema = z.object(BuildDefaultProfileFields).strict();
export type BuildDefaultProfile = Readonly<z.infer<typeof BuildDefaultProfileSchema>>;

export class BuildDefaultProfileError extends Error {
  readonly name = 'BuildDefaultProfileError';
  constructor(readonly path: string, readonly code: string) {
    super(`Invalid build default profile at ${path}: ${code}`);
  }
}

export function resolveBuildDefaultProfile(raw: string | undefined =
  process.env.EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON ?? process.env.HAPPIER_BUILD_DEFAULT_PROFILE_JSON ?? BAKED_BUILD_DEFAULT_PROFILE_JSON,
): BuildDefaultProfile {
  if (!raw?.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new BuildDefaultProfileError('$', 'invalid_json'); }
  const parsed = BuildDefaultProfileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BuildDefaultProfileError(issue.path.join('.') || '$', issue.code);
  }
  return parsed.data;
}

const HAPPIER_CLOUD_ORIGIN = 'https://api.happier.dev';

/** Hosted identity classification is independent of a distributor's selected defaults. */
export function isHappierCloudServerUrl(serverUrl: string): boolean {
  return serverUrl.trim().replace(/\/+$/u, '') === HAPPIER_CLOUD_ORIGIN;
}

/** Retained export for Cloud-specific consumers; custom and unconfigured builds have none. */
export const DEFAULT_HAPPIER_CLOUD_SERVER_URL = isHappierCloudServerUrl(resolveBuildDefaultProfile().home?.url ?? '')
  ? HAPPIER_CLOUD_ORIGIN : '';

/** One owner for the configured Home's separate web client, otherwise the Home's own origin. */
export function resolveDefaultWebappUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/+$/u, '');
  if (!normalized) return '';
  const home = resolveBuildDefaultProfile().home;
  if (home?.url === normalized && home.webappUrl) return home.webappUrl;
  try { return new URL(normalized).origin; }
  catch { return normalized; }
}
