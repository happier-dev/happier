import type { CommandContext } from '@/cli/commandRegistry';

import { hasFlagValue } from '@/cli/commands/shared/argvFlags';
import { showAuthHelp } from './auth/help';
import { projectSafeAuthError } from './auth/errorDiagnostic';

export async function handleAuthCommand(args: string[], signal?: AbortSignal): Promise<void> {
  args = await (await import('./auth/stdinSecrets')).expandAuthSecretsFromStdin(args);
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'api-tokens':
      await (await import('./auth/apiTokens')).handleAuthApiTokens(args.slice(1), signal);
      return;
    case 'security':
      await (await import('./auth/accountSecurity')).handleAuthSecurityGet(args.slice(1), signal);
      return;
    case 'cli-approvals':
      await (await import('./auth/accountSecurity')).handleAuthCliApprovals(args.slice(1), signal);
      return;
    case 'password':
      await (await import('./auth/accountSecurity')).handleAuthPasswordCommand(args.slice(1), signal);
      return;
    case 'email':
      await (await import('./auth/nativeEmail')).handleAuthEmailNativeCommand(args.slice(1), signal);
      return;
    case 'recovery-key':
      if (args[1] === 'validate') {
        await (await import('./auth/recoveryKey')).handleRecoveryKeyValidation(args.slice(2));
        return;
      }
      await (await import('./auth/nativeEmail')).handleAuthEmailNativeCommand(['recovery-key', ...args.slice(1)], signal);
      return;
    case 'login':
      if (hasFlagValue(args.slice(1), '--email')) {
        await (await import('./auth/nativeEmail')).handleAuthEmailNativeCommand(['login', ...args.slice(1)], signal);
        return;
      }
      await (await import('./auth/login')).handleAuthLogin(args.slice(1), signal);
      return;
    case 'request':
      await (await import('./auth/request')).handleAuthRequest(args.slice(1), signal);
      return;
    case 'approve':
      await (await import('./auth/approve')).handleAuthApprove(args.slice(1), signal);
      return;
    case 'wait':
      await (await import('./auth/wait')).handleAuthWait(args.slice(1), signal);
      return;
    case 'pair-remote':
      await (await import('./auth/pairRemote')).handleAuthPairRemote(args.slice(1), signal);
      return;
    case 'enroll-remote':
      await (await import('./auth/enrollRemote')).handleAuthEnrollRemote(args.slice(1), signal);
      return;
    case 'logout':
      await (await import('./auth/logout')).handleAuthLogout(args.slice(1));
      return;
    case 'status':
      await (await import('./auth/status')).handleAuthStatus(args.slice(1), signal);
      return;
    case 'service':
      await (await import('./auth/service')).handleAuthServiceCommand(args.slice(1), signal);
      return;
    default:
      const { errorFrame } = await import('@happier-dev/cli-common/output');
      console.error(errorFrame('Error:', [`Unknown auth subcommand: ${subcommand}`]));
      showAuthHelp();
      process.exit(1);
  }
}

export async function handleAuthCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAuthCommand(context.args.slice(1), context.signal);
  } catch (error) {
    const { errorFrame } = await import('@happier-dev/cli-common/output');
    const diagnostic = projectSafeAuthError(error);
    console.error(errorFrame('Error:', [diagnostic.message]));
    if (process.env.DEBUG) {
      // Error objects from HTTP clients retain request bodies, response bodies,
      // headers, and config. Project only allowlisted actionable fields at the CLI
      // boundary so pairing and credential material cannot reach diagnostics.
      console.error(diagnostic);
    }
    process.exit(1);
  }
}
