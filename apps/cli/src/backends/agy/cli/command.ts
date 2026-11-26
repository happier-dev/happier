import type { CommandContext } from '@/cli/commandRegistry';
import { passthroughProviderCliArgs } from '@/cli/providerCliPassthrough';
import { stripInheritedConnectedServiceEnvironment } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resolveAgyAcpLaunch } from '../acp/agyAcpLaunch';

export async function handleAgyCliCommand(context: CommandContext): Promise<void> {
  if (context.args[1] !== 'auth') {
    const { handleCatalogDefinedAcpCliCommand } = await import('@/agent/acp/catalog/handleCatalogDefinedAcpCliCommand');
    await handleCatalogDefinedAcpCliCommand('agy', context);
    return;
  }

  const action = context.args[2];
  if (!action || ['help', '--help', '-h'].includes(action) || context.args.includes('--help')) {
    console.log('happier agy auth login');
    return;
  }
  if (action !== 'login' || context.args.length > 3) throw new Error('Unknown AGY auth command. Run "happier agy auth --help".');

  // Login is always the machine login, even from a connected-account session's shell: drop that
  // session's selection and materialized profile, then use the machine launch (OS keyring storage).
  const processEnv: NodeJS.ProcessEnv = stripInheritedConnectedServiceEnvironment(process.env);
  const launch = resolveAgyAcpLaunch(processEnv);
  for (const key of launch.unsetEnv) delete processEnv[key];
  console.log('Signing in with the Antigravity CLI. Open the login link it prints and paste the authorization code when asked.');
  passthroughProviderCliArgs({ agentId: 'agy', providerArgs: ['acp', ...launch.args, '--login'], processEnv: { ...processEnv, ...launch.env } });
  console.log('Antigravity login completed. You can now start a Happier AGY session.');
}
