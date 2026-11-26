import type { CommandContext } from '@/cli/commandRegistry';
import { passthroughProviderCliArgs } from '@/cli/providerCliPassthrough';
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

  // The machine login is the one Happier sessions use without a connected account: same profile, OS keyring storage.
  const launch = resolveAgyAcpLaunch(process.env);
  const processEnv = { ...process.env };
  for (const key of launch.unsetEnv) delete processEnv[key];
  console.log('Signing in with the Antigravity CLI. Open the login link it prints and paste the authorization code when asked.');
  passthroughProviderCliArgs({ agentId: 'agy', providerArgs: ['acp', ...launch.args, '--login'], processEnv: { ...processEnv, ...launch.env } });
  console.log('Antigravity login completed. You can now start a Happier AGY session.');
}
