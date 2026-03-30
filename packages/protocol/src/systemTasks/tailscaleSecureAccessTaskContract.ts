export const TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND = 'secureAccess.tailscale.v1' as const;

export const TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS = [
  'detect',
  'install',
  'login',
  'serve enable',
  'verify url',
] as const;

export type TailscaleSecureAccessSystemTaskStepId = (typeof TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS)[number];
export type TailscaleSecureAccessInstallPolicy = 'skip' | 'installIfMissing';
export type TailscaleSecureAccessLoginPolicy = 'skip' | 'interactive';
export type TailscaleSecureAccessMode = 'normalUser' | 'managedAdmin';

export type TailscaleSecureAccessTaskParams = Readonly<{
  upstreamUrl: string;
  servePath?: string;
  installPolicy?: TailscaleSecureAccessInstallPolicy;
  loginPolicy?: TailscaleSecureAccessLoginPolicy;
  mode?: TailscaleSecureAccessMode;
}>;

export type TailscaleSecureAccessTaskSpec = Readonly<{
  kind: typeof TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND;
  params: Readonly<{
    upstreamUrl: string;
    servePath: string;
    installPolicy: TailscaleSecureAccessInstallPolicy;
    loginPolicy: TailscaleSecureAccessLoginPolicy;
    mode: TailscaleSecureAccessMode;
  }>;
}>;

export type TailscaleSecureAccessTaskResult = Readonly<{
  tailscaleInstalled: boolean;
  tailscaleLoggedIn: boolean;
  serveEnabled: boolean;
  shareableHttpsUrl: string | null;
  requiresApproval: Readonly<{ url: string }> | null;
}>;

export function createTailscaleSecureAccessTaskSpec(
  params: TailscaleSecureAccessTaskParams,
): TailscaleSecureAccessTaskSpec {
  return {
    kind: TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
    params: {
      upstreamUrl: String(params.upstreamUrl ?? '').trim(),
      servePath: String(params.servePath ?? '/').trim() || '/',
      installPolicy: params.installPolicy ?? 'skip',
      loginPolicy: params.loginPolicy ?? 'interactive',
      mode: params.mode ?? 'normalUser',
    },
  };
}

