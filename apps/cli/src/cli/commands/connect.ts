import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import type { CloudConnectTarget, CloudConnectTargetStatus } from '@/cloud/connectTypes';
import { AGENTS } from '@/backends/catalog';
import { promptInput } from '@/terminal/prompts/promptInput';
import { buildConnectedServiceCredentialRecord, sealConnectedServiceCredentialCiphertext, type ConnectedServiceId } from '@happier-dev/protocol';

import type { CommandContext } from '@/cli/commandRegistry';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { githubConnectedAccountTarget } from '@/daemon/connectedServices/github/githubConnectedAccountTarget';
import { parseConnectArgs, type ConnectParsedOptions } from './connect/parseConnectArgs';
import { resolveConnectAuthIntent } from './connect/resolveConnectAuthIntent';
import { resolveConnectTargetServiceIds } from './connect/resolveConnectTargetServiceIds';

/**
 * Handle connect subcommand.
 *
 * Implements connect subcommands for storing Connected Services credentials (v2):
 * - connect codex: Store OpenAI Codex subscription OAuth (openai-codex) or OpenAI API key (openai)
 * - connect claude: Store Claude subscription auth (claude-subscription) or Anthropic API key (anthropic)
 * - connect gemini: Store Gemini OAuth (gemini)
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const { includeExperimental, subcommand, options } = parseConnectArgs(args);

    const allTargets = await loadConnectTargets({ includeExperimental: true });
    const visibleTargets = includeExperimental ? allTargets : allTargets.filter((t) => t.status === 'wired');

    const targetById = new Map<string, CloudConnectTarget>(allTargets.map((t) => [t.id, t] as const));
    const visibleTargetById = new Map<string, CloudConnectTarget>(visibleTargets.map((t) => [t.id, t] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp(visibleTargets, { includeExperimental });
        return;
    }

    const normalized = subcommand.toLowerCase();
    if (normalized === 'status') {
      await handleConnectStatus(visibleTargets);
      return;
    }

    const visibleTarget = visibleTargetById.get(normalized);
    if (!visibleTarget) {
      const hiddenTarget = targetById.get(normalized);
      if (hiddenTarget && hiddenTarget.status === 'experimental' && !includeExperimental) {
        console.error(chalk.yellow(`Connect target '${hiddenTarget.id}' is experimental and not enabled by default.`));
        console.error(chalk.gray(`Run: happier connect --all ${hiddenTarget.id}`));
        process.exit(1);
      }
      console.error(chalk.red(`Unknown connect target: ${subcommand}`));
      showConnectHelp(visibleTargets, { includeExperimental });
      process.exit(1);
    }

    await handleConnectVendor(visibleTarget, options);
}

async function loadConnectTargets(params: Readonly<{ includeExperimental: boolean }>): Promise<CloudConnectTarget[]> {
  const targets: CloudConnectTarget[] = [githubConnectedAccountTarget];
  for (const entry of Object.values(AGENTS)) {
    if (!entry.getCloudConnectTarget) continue;
    targets.push(await entry.getCloudConnectTarget());
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return params.includeExperimental ? targets : targets.filter((t) => t.status === 'wired');
}

function showConnectHelp(targets: ReadonlyArray<CloudConnectTarget>, opts: Readonly<{ includeExperimental: boolean }>): void {
    const targetLines = targets.length > 0
      ? targets.map((t) => formatTargetLine(t)).join('\n')
      : '  (no connect targets registered)';
    console.log(`
${chalk.bold('happier connect')} - Connect AI vendor subscriptions and API keys to Happier cloud

${chalk.bold('Usage:')}
${targetLines}
  happier connect status       Show connection status for all vendors
  happier connect help         Show this help message
  happier connect --all ...    Include experimental providers
  happier connect <target> --profile <id>      Store under a specific profile (default: default)
  happier connect <target> --paste             Headless mode: paste redirect URL
  happier connect <target> --device            Use device-code auth (Codex)
  happier connect codex --api-key              Store an OpenAI API key
  happier connect claude --api-key             Store an Anthropic API key (not Claude subscription)
  happier connect claude --setup-token         Store a Claude setup-token (default for claude)
  happier connect claude --oauth               Store Claude subscription OAuth (advanced)
  happier connect github --token               Store a GitHub access token
  happier connect <target> --no-open           Do not attempt to open a browser
  happier connect <target> --timeout <seconds> Override OAuth timeout

${chalk.bold('Description:')}
  The connect command allows you to securely store your connected-service credentials
  in Happier cloud. This enables you to use these services through Happier
  without exposing credentials locally.

${chalk.bold('Examples:')}
  happier connect ${targets[0]?.id ?? 'gemini'}
  happier connect status

${chalk.bold('Notes:')} 
  • You must be authenticated with Happier first (run 'happier auth login')
  • Credentials are encrypted and stored securely in Happier cloud
  • You can manage your stored keys at app.happier.dev
  ${opts.includeExperimental ? '' : '• Some providers are experimental; use --all to show them'}
`);
}

function formatTargetLine(target: CloudConnectTarget): string {
  const statusSuffix = target.status === 'wired' ? '' : chalk.gray(' (experimental)');
  return `  happier connect ${target.id.padEnd(12)} ${target.vendorDisplayName}${statusSuffix}`;
}

async function handleConnectVendor(target: CloudConnectTarget, options: ConnectParsedOptions): Promise<void> {
    console.log(chalk.bold(`\n🔌 Connecting ${target.vendorDisplayName} to Happier cloud\n`));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happier'));
        console.log(chalk.gray('  Please run "happier auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    const now = Date.now();
    let postConnectPayload: unknown | null = null;

    const record = await (async () => {
      const authIntent = resolveConnectAuthIntent({ targetId: target.id, options });
      const serviceId: ConnectedServiceId = authIntent.serviceId;
      if (authIntent.kind === 'token') {
        const promptLabel =
          authIntent.tokenKind === 'setup-token'
            ? 'Paste Claude setup-token (from `claude setup-token`): '
            : authIntent.tokenKind === 'access-token'
              ? 'Paste GitHub access token: '
              : serviceId === 'openai'
                ? 'Paste OpenAI API key: '
                : 'Paste Anthropic API key: ';
        const token = (await promptInput(promptLabel)).trim();
        if (!token) {
          throw new Error(
            authIntent.tokenKind === 'setup-token'
              ? 'Missing setup-token'
              : authIntent.tokenKind === 'access-token'
                ? 'Missing access token'
                : 'Missing API key',
          );
        }
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'token',
          token: { token, providerAccountId: null, providerEmail: null },
        });
      }

      const oauth = await target.authenticate({
        paste: options.paste,
        device: options.device,
        noOpen: options.noOpen,
        timeoutSeconds: options.timeoutSeconds ?? undefined,
      });
      postConnectPayload = oauth;

      return buildConnectedAccountOauthCredentialRecord({
        now,
        serviceId,
        profileId: options.profileId,
        payload: oauth,
      });
    })();

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material:
        credentials.encryption.type === 'legacy'
          ? { type: 'legacy', secret: credentials.encryption.secret }
          : { type: 'dataKey', machineKey: credentials.encryption.machineKey },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    console.log(`🚀 Registering ${target.displayName} credential with relay (${record.serviceId}/${options.profileId})`);
    await api.registerConnectedServiceCredentialSealed({
      serviceId: record.serviceId,
      profileId: options.profileId,
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
      metadata: {
        kind: record.kind,
        providerEmail:
          record.kind === 'oauth' ? record.oauth.providerEmail ?? null : record.token.providerEmail ?? null,
        providerAccountId:
          record.kind === 'oauth' ? record.oauth.providerAccountId ?? null : record.token.providerAccountId ?? null,
        expiresAt: record.expiresAt,
      },
    });

    console.log(`✅ ${target.displayName} credential registered with relay`);
    if (postConnectPayload !== null) {
      target.postConnect?.(postConnectPayload);
    }
    process.exit(0);
}

/**
 * Show connection status for all vendors
 */
async function handleConnectStatus(targets: ReadonlyArray<CloudConnectTarget>): Promise<void> {
    console.log(chalk.bold('\n🔌 Connection Status\n'));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happier'));
        console.log(chalk.gray('  Please run "happier auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    for (const target of targets) {
      try {
        const serviceIds: ConnectedServiceId[] = resolveConnectTargetServiceIds(target.id);

        if (serviceIds.length === 0) {
          console.log(`  ${chalk.gray('○')}  ${target.vendorDisplayName}: ${chalk.gray('not supported')}`);
          continue;
        }

        const allProfiles = (await Promise.all(serviceIds.map(async (serviceId) => {
          const { profiles } = await api.listConnectedServiceProfiles({ serviceId });
          return profiles;
        }))).flat();

        const connected = allProfiles.filter((p) => p.status === 'connected');
        if (connected.length === 0) {
          const needsReauth = allProfiles.length > 0;
          const label = needsReauth ? 'needs re-auth' : 'not connected';
          const icon = needsReauth ? chalk.yellow('⚠️') : chalk.gray('○');
          const color = needsReauth ? chalk.yellow(label) : chalk.gray(label);
          console.log(`  ${icon}  ${target.vendorDisplayName}: ${color}`);
          continue;
        }

        const primary = connected[0]!;
        const userInfo = primary.providerEmail ? chalk.gray(` (${primary.providerEmail})`) : '';
        console.log(`  ${chalk.green('✓')}  ${target.vendorDisplayName}: ${chalk.green('connected')}${userInfo}`);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error(chalk.gray(`[debug] failed to check ${target.vendorDisplayName} connection:`), error);
        }
        console.log(`  ${chalk.yellow('?')}  ${target.vendorDisplayName}: ${chalk.yellow('unknown (check failed)')}`);
      }
    }

    console.log('');
    console.log(chalk.gray('To connect a vendor, run: happier connect <vendor>'));
    console.log(chalk.gray('Example: happier connect gemini'));
    console.log('');
}

export async function handleConnectCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
