import { readStartedByArg } from '@/cli/readStartedByArg';

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
