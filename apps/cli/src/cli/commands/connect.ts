import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import type { CloudConnectTarget, CloudConnectTargetStatus } from '@/cloud/connectTypes';
import { AGENTS } from '@/backends/catalog';
import { promptInput } from '@/terminal/prompts/promptInput';
import { buildConnectedServiceCredentialRecord, sealConnectedServiceCredentialCiphertext, type ConnectedServiceId } from '@happier-dev/protocol';

import type { CommandContext } from '@/cli/commandRegistry';

/**
 * Handle connect subcommand
 * 
 * Implements connect subcommands for storing Connected Services credentials (v2):
 * - connect codex: Store OpenAI Codex subscription OAuth (openai-codex)
 * - connect claude: Store Anthropic Claude subscription OAuth or setup-token (anthropic)
 * - connect gemini: Store Gemini OAuth (gemini)
 * - connect help: Show help for connect command
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

type ConnectParsedOptions = Readonly<{
  profileId: string;
  paste: boolean;
  noOpen: boolean;
  timeoutSeconds: number | null;
  setupToken: boolean;
}>;

function parseConnectArgs(args: ReadonlyArray<string>): Readonly<{
  includeExperimental: boolean;
  subcommand: string | null;
  options: ConnectParsedOptions;
}> {
  const includeExperimental = args.includes('--all') || args.includes('--experimental');
  const paste = args.includes('--paste');
  const noOpen = args.includes('--no-open');
  const setupToken = args.includes('--setup-token') || args.includes('--setup_token');

  const profileFlagIdx = args.findIndex((a) => a === '--profile');
  const profileId = profileFlagIdx !== -1 ? String(args[profileFlagIdx + 1] ?? '').trim() : '';

  const timeoutFlagIdx = args.findIndex((a) => a === '--timeout');
  const timeoutRaw = timeoutFlagIdx !== -1 ? String(args[timeoutFlagIdx + 1] ?? '').trim() : '';
  const timeoutSeconds = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutSecondsValue = Number.isFinite(timeoutSeconds) ? Math.max(1, Math.trunc(timeoutSeconds)) : null;

  const knownFlags = new Set([
    '--all',
    '--experimental',
    '--paste',
    '--no-open',
    '--setup-token',
    '--setup_token',
    '--profile',
    '--timeout',
  ]);
  const valuesConsumedByFlags = new Set<number>([
    profileFlagIdx !== -1 ? profileFlagIdx + 1 : -1,
    timeoutFlagIdx !== -1 ? timeoutFlagIdx + 1 : -1,
  ]);

  const positional = args
    .filter((_a, idx) => !valuesConsumedByFlags.has(idx))
    .filter((a) => !knownFlags.has(a))
    .filter((a) => !a.startsWith('--'));

  const subcommand = positional[0] ?? null;
  return {
    includeExperimental,
    subcommand,
    options: {
      profileId: profileId || 'default',
      paste,
      noOpen,
      timeoutSeconds: timeoutSecondsValue,
      setupToken,
    },
  };
}

async function loadConnectTargets(params: Readonly<{ includeExperimental: boolean }>): Promise<CloudConnectTarget[]> {
  const targets: CloudConnectTarget[] = [];
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
${chalk.bold('happier connect')} - Connect AI vendor API keys to Happier cloud

${chalk.bold('Usage:')}
${targetLines}
  happier connect status       Show connection status for all vendors
  happier connect help         Show this help message
  happier connect --all ...    Include experimental providers
  happier connect <target> --profile <id>      Store under a specific profile (default: default)
  happier connect <target> --paste             Headless mode: paste redirect URL
  happier connect <target> --no-open           Do not attempt to open a browser
  happier connect <target> --timeout <seconds> Override OAuth timeout
  happier connect claude --setup-token         Paste a Claude setup-token instead of OAuth

${chalk.bold('Description:')}
  The connect command allows you to securely store your AI vendor API keys
  in Happier cloud. This enables you to use these services through Happier
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  happier connect ${targets[0]?.id ?? 'gemini'}
  happier connect status

${chalk.bold('Notes:')} 
  • You must be authenticated with Happier first (run 'happier auth login')
  • API keys are encrypted and stored securely in Happier cloud
  • You can manage your stored keys at app.happier.dev
  ${opts.includeExperimental ? '' : '• Some providers are experimental; use --all to show them'}
`);
}

function formatTargetLine(target: CloudConnectTarget): string {
  const statusSuffix = target.status === 'wired' ? '' : chalk.gray(' (experimental)');
  return `  happier connect ${target.id.padEnd(12)} ${target.vendorDisplayName}${statusSuffix}`;
}

function resolveConnectedServiceIdForTarget(targetId: string): ConnectedServiceId | null {
  if (targetId === 'codex') return 'openai-codex';
  if (targetId === 'claude') return 'anthropic';
  if (targetId === 'gemini') return 'gemini';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

    const serviceId = resolveConnectedServiceIdForTarget(target.id);
    if (!serviceId) {
      console.error(chalk.red(`Connect target '${target.id}' does not support connected services yet.`));
      process.exit(1);
    }

    const now = Date.now();
    let postConnectPayload: unknown | null = null;

    const record = await (async () => {
      if (target.id === 'claude' && options.setupToken) {
        const token = (await promptInput('Paste Claude setup-token: ')).trim();
        if (!token) throw new Error('Missing setup-token');
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
        noOpen: options.noOpen,
        timeoutSeconds: options.timeoutSeconds ?? undefined,
      });
      postConnectPayload = oauth;

      if (target.id === 'codex') {
        const t = isRecord(oauth) ? oauth : {};
        const expiresAt = (() => {
          const explicit = t.expires_at;
          if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
          const expiresIn = t.expires_in;
          if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
            return now + Math.trunc(expiresIn) * 1000;
          }
          return null;
        })();
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'oauth',
          expiresAt,
          oauth: {
            accessToken: String(t.access_token ?? ''),
            refreshToken: String(t.refresh_token ?? ''),
            idToken: typeof t.id_token === 'string' ? t.id_token : null,
            scope: null,
            tokenType: null,
            providerAccountId: typeof t.account_id === 'string' ? t.account_id : null,
            providerEmail: null,
          },
        });
      }

      if (target.id === 'claude') {
        const t = isRecord(oauth) ? oauth : {};
        const raw = isRecord(t.raw) ? t.raw : null;
        const account = raw && isRecord(raw.account) ? raw.account : null;
        const email = account?.email_address;
        const accountId = account?.uuid;
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'oauth',
          expiresAt: typeof t.expires === 'number' ? t.expires : null,
          oauth: {
            accessToken: String(t.token ?? ''),
            refreshToken: String(t.refresh_token ?? ''),
            idToken: null,
            scope: raw && typeof raw.scope === 'string' ? raw.scope : null,
            tokenType: raw && typeof raw.token_type === 'string' ? raw.token_type : null,
            providerAccountId: typeof accountId === 'string' ? accountId : null,
            providerEmail: typeof email === 'string' ? email : null,
          },
        });
      }

      if (target.id === 'gemini') {
        const t = isRecord(oauth) ? oauth : {};
        const expiresAt = typeof t.expires_in === 'number' ? now + t.expires_in * 1000 : null;
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'oauth',
          expiresAt,
          oauth: {
            accessToken: String(t.access_token ?? ''),
            refreshToken: String(t.refresh_token ?? ''),
            idToken: typeof t.id_token === 'string' ? t.id_token : null,
            scope: typeof t.scope === 'string' ? t.scope : null,
            tokenType: typeof t.token_type === 'string' ? t.token_type : null,
            providerAccountId: null,
            providerEmail: null,
          },
        });
      }

      throw new Error(`Unsupported connect target: ${target.id}`);
    })();

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material:
        credentials.encryption.type === 'legacy'
          ? { type: 'legacy', secret: credentials.encryption.secret }
          : { type: 'dataKey', machineKey: credentials.encryption.machineKey },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    console.log(`🚀 Registering ${target.displayName} credential with server (${serviceId}/${options.profileId})`);
    await api.registerConnectedServiceCredentialSealed({
      serviceId,
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

    console.log(`✅ ${target.displayName} credential registered with server`);
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
        const serviceId = resolveConnectedServiceIdForTarget(target.id);
        if (!serviceId) {
          console.log(`  ${chalk.gray('○')}  ${target.vendorDisplayName}: ${chalk.gray('not supported')}`);
          continue;
        }

        const { profiles } = await api.listConnectedServiceProfiles({ serviceId });
        const connected = profiles.filter((p) => p.status === 'connected');
        if (connected.length === 0) {
          const needsReauth = profiles.length > 0;
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
