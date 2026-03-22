import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

import type { McpCommandDeps } from '../deps';
import { readRepeatedFlagValues } from '../argv';

export async function cmdMcpServersDetect(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const providers = readRepeatedFlagValues(argv, '--provider');
  const directory = readFlagValue(argv, '--dir');
  const detected = await deps.detectProviderMcpServers({
    directory: directory ?? null,
    providers,
  });

  if (opts.json) {
    printJsonEnvelope({
      ok: true,
      kind: 'mcp_servers_detect',
      data: {
        servers: detected.servers,
        ...(detected.warnings.length > 0 ? { warnings: detected.warnings } : {}),
      },
    });
    return;
  }

  console.log(chalk.gray(`Detected MCP servers: ${detected.servers.length}`));
  for (const server of detected.servers) {
    console.log(`- ${server.provider}:${server.name} (${server.transport})`);
  }
}

