import { parseArgs } from 'node:util';

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
    console.log('happier agy auth login [--pinned] [--method <oauth-personal|oauth-business|gemini-api-key|agent-platform>]');
    return;
  }
  if (action !== 'login') throw new Error('Unknown AGY auth command. Run "happier agy auth --help".');
  const { values } = parseArgs({
    args: context.args.slice(3),
    options: { pinned: { type: 'boolean' }, method: { type: 'string' } },
    strict: true,
  });
  if (values.pinned || values.method !== undefined) {
    await loginToPinnedServer(values.method ?? 'oauth-personal');
    return;
  }

  console.log('Signing in with the Antigravity CLI. Open the login link it prints and paste the authorization code when asked.');
  passthroughProviderCliArgs({ agentId: 'agy', providerArgs: ['acp', '--login'] });
  console.log('Antigravity login completed. You can now start a Happier AGY session.');
}

async function loginToPinnedServer(methodId: string): Promise<void> {
  const [{ authenticateAcpAgent }, { ensureAgyAcpServerForLaunch }] = await Promise.all([
    import('@/agent/acp/authenticateAcpAgent'),
    import('../acp/ensureAgyAcpServerForLaunch'),
  ]);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new DOMException('AGY login cancelled', 'AbortError'));
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const launch = await ensureAgyAcpServerForLaunch();
    console.log('Signing in to the pinned Antigravity ACP server. Follow its browser login link if requested.');
    await authenticateAcpAgent({
      ...launch,
      agentName: 'agy',
      cwd: process.cwd(),
      env: process.env,
      methodId,
      signal: controller.signal,
      onStderr: (text) => { process.stderr.write(text); },
    });
    console.log('Pinned Antigravity ACP login completed. Retry the existing session.');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}
