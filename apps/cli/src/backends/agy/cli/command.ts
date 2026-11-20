import type { CommandContext } from '@/cli/commandRegistry';
import { passthroughProviderCliArgs } from '@/cli/providerCliPassthrough';

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
  if (action !== 'login') throw new Error('Unknown AGY auth command. Run "happier agy auth --help".');
  if (context.args.length > 3) throw new Error('"happier agy auth login" takes no options. Run "happier agy auth --help".');

  console.log('Signing in with the Antigravity CLI. Open the login link it prints and paste the authorization code when asked.');
  passthroughProviderCliArgs({ agentId: 'agy', providerArgs: ['acp', '--login'] });
  console.log('Antigravity login completed. You can now start a Happier AGY session.');
}
