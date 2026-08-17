export type DevClientIdentity = Readonly<{
  profile: 'internaldev' | 'publicdev';
  appEnv: 'internaldev' | 'publicdev';
  iosAppName: string;
  iosBundleId: string;
  androidPackage: string;
  scheme: string;
  easBuildProfile: string;
}>;

export type StackReleaseIdentity = Readonly<{
  iosAppName: string;
  iosBundleId: string;
  scheme: string;
}>;

export function sanitizeBundleIdSegment(raw: unknown): string;
export function sanitizeUrlScheme(raw: unknown): string;
export function stackSlugForMobileIds(stackName: unknown): string;
export function defaultDevClientIdentity(options?: Readonly<{
  user?: string | null;
  profile?: string | null;
}>): DevClientIdentity;
export function defaultStackReleaseIdentity(options: Readonly<{
  stackName: string;
  user?: string | null;
  appName?: string | null;
}>): StackReleaseIdentity;
