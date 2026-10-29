import { readStartedByArg } from '@/cli/readStartedByArg';

export function shouldAutoStartDaemonAfterAuth(
  params: Readonly<{
    env: NodeJS.ProcessEnv;
    isDaemonProcess: boolean;
    startedBy: 'daemon' | 'terminal';
    callerIntent?: 'standalone' | 'setup-managed';
  }>,
): boolean {
  if (params.callerIntent === 'setup-managed') return false;
  if (params.isDaemonProcess) return false;
  if (params.startedBy === 'daemon') return false;
  const raw = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function shouldEnsureDaemonForInvocation(params: Readonly<{ args: string[] }>): boolean {
  const args = Array.isArray(params.args) ? params.args : [];
  if (args.includes('-h') || args.includes('--help')) return false;
  if (args.includes('-v') || args.includes('--version')) return false;

  const subcommand = args[0];
  const nonSession = new Set([
    'auth',
    'doctor',
    'daemon',
    'notify',
    'connect',
    'logout',
    'attach',
    'capabilities',
    'self',
    'server',
    'session',
    'sessions',
  ]);
  if (subcommand && nonSession.has(subcommand)) return false;

  return true;
}

export function applyDaemonAutostartEnvForInvocation(params: Readonly<{ args: string[]; env: NodeJS.ProcessEnv }>): void {
  if (!shouldEnsureDaemonForInvocation({ args: params.args })) return;
  if (readStartedByArg(params.args).value === 'daemon') return;
  const current = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
  if (current.length > 0) return;
  params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';
}
