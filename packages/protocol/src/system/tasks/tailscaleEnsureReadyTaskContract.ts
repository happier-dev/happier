export const TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND = 'tailscale.ensureReady.v1' as const;

export const TAILSCALE_ENSURE_READY_SYSTEM_TASK_STEP_IDS = [
  'tailscale.detect',
  'tailscale.install',
  'tailscale.login',
] as const;

export type TailscaleEnsureReadySystemTaskStepId = (typeof TAILSCALE_ENSURE_READY_SYSTEM_TASK_STEP_IDS)[number];
export type TailscaleEnsureReadyInstallPolicy = 'skip' | 'installIfMissing';
export type TailscaleEnsureReadyLoginPolicy = 'skip' | 'interactive';
export type TailscaleEnsureReadyMode = 'normalUser' | 'managedAdmin';

export type TailscaleEnsureReadyTaskParams = Readonly<{
  installPolicy?: TailscaleEnsureReadyInstallPolicy;
  loginPolicy?: TailscaleEnsureReadyLoginPolicy;
  mode?: TailscaleEnsureReadyMode;
}>;

export type TailscaleEnsureReadyTaskSpec = Readonly<{
  kind: typeof TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND;
  params: Readonly<{
    installPolicy: TailscaleEnsureReadyInstallPolicy;
    loginPolicy: TailscaleEnsureReadyLoginPolicy;
    mode: TailscaleEnsureReadyMode;
  }>;
}>;

export type TailscaleEnsureReadyTaskResult = Readonly<{
  tailscaleInstalled: boolean;
  tailscaleLoggedIn: boolean;
  authUrl: string | null;
}>;

export function createTailscaleEnsureReadyTaskSpec(
  params: TailscaleEnsureReadyTaskParams = {},
): TailscaleEnsureReadyTaskSpec {
  return {
    kind: TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND,
    params: {
      installPolicy: params.installPolicy ?? 'skip',
      loginPolicy: params.loginPolicy ?? 'interactive',
      mode: params.mode ?? 'normalUser',
    },
  };
}
