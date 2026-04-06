import type { SystemTaskJsonObject } from './spec.js';

export const TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND = 'secureAccess.tailscale.v1' as const;

export const TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS = [
  'tailscale.detect',
  'tailscale.install',
  'tailscale.login',
  'tailscale.serveEnable',
  'tailscale.verifyUrl',
] as const;

export type TailscaleSecureAccessSystemTaskStepId = (typeof TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS)[number];
export type TailscaleSecureAccessInstallPolicy = 'skip' | 'installIfMissing';
export type TailscaleSecureAccessLoginPolicy = 'skip' | 'interactive';
export type TailscaleSecureAccessMode = 'normalUser' | 'managedAdmin';
export type TailscaleSecureAccessProviderId = 'tailscaleServe' | 'tailscaleFunnel';
export type TailscaleSecureAccessSshConnectionConfig = SystemTaskJsonObject & Readonly<{
  target: string;
  auth: 'agent' | 'keyfile' | 'password';
  port?: number;
  identityFile?: string;
  password?: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  trustedHostKey?: string;
}>;
export type TailscaleSecureAccessTaskTarget =
  | (SystemTaskJsonObject & Readonly<{ kind: 'local' }>)
  | (SystemTaskJsonObject & Readonly<{
      kind: 'ssh';
      ssh: TailscaleSecureAccessSshConnectionConfig;
    }>);

export type TailscaleSecureAccessTaskParams = Readonly<{
  upstreamUrl: string;
  providerId?: TailscaleSecureAccessProviderId;
  servePath?: string;
  installPolicy?: TailscaleSecureAccessInstallPolicy;
  loginPolicy?: TailscaleSecureAccessLoginPolicy;
  mode?: TailscaleSecureAccessMode;
  target?: TailscaleSecureAccessTaskTarget;
}>;

export type TailscaleSecureAccessTaskSpec = Readonly<{
  kind: typeof TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND;
  params: SystemTaskJsonObject & Readonly<{
    upstreamUrl: string;
    providerId: TailscaleSecureAccessProviderId;
    servePath: string;
    installPolicy: TailscaleSecureAccessInstallPolicy;
    loginPolicy: TailscaleSecureAccessLoginPolicy;
    mode: TailscaleSecureAccessMode;
    target: TailscaleSecureAccessTaskTarget;
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
      providerId: params.providerId === 'tailscaleFunnel' ? 'tailscaleFunnel' : 'tailscaleServe',
      servePath: String(params.servePath ?? '/').trim() || '/',
      installPolicy: params.installPolicy ?? 'skip',
      loginPolicy: params.loginPolicy ?? 'interactive',
      mode: params.mode ?? 'normalUser',
      target: normalizeTailscaleSecureAccessTaskTarget(params.target),
    },
  };
}

function normalizeTailscaleSecureAccessTaskTarget(
  target: TailscaleSecureAccessTaskTarget | undefined,
): TailscaleSecureAccessTaskTarget {
  if (target?.kind !== 'ssh') {
    return { kind: 'local' };
  }

  return {
    kind: 'ssh',
    ssh: {
      target: String(target.ssh.target ?? '').trim(),
      auth: target.ssh.auth,
      ...(typeof target.ssh.port === 'number' && Number.isFinite(target.ssh.port)
        ? { port: Math.trunc(target.ssh.port) }
        : {}),
      ...(typeof target.ssh.identityFile === 'string' && target.ssh.identityFile.trim()
        ? { identityFile: target.ssh.identityFile.trim() }
        : {}),
      ...(typeof target.ssh.password === 'string' && target.ssh.password.length > 0
        ? { password: target.ssh.password }
        : {}),
      ...(typeof target.ssh.sshConfigFile === 'string' && target.ssh.sshConfigFile.trim()
        ? { sshConfigFile: target.ssh.sshConfigFile.trim() }
        : {}),
      ...(typeof target.ssh.knownHostsPath === 'string' && target.ssh.knownHostsPath.trim()
        ? { knownHostsPath: target.ssh.knownHostsPath.trim() }
        : {}),
      ...(typeof target.ssh.trustedHostKey === 'string' && target.ssh.trustedHostKey.trim()
        ? { trustedHostKey: target.ssh.trustedHostKey.trim() }
        : {}),
    },
  };
}
