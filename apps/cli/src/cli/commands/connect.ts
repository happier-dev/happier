import { randomBytes } from 'node:crypto';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import type { CloudConnectTarget, CloudConnectTargetStatus } from '@/cloud/connectTypes';
import { AGENTS } from '@/backends/catalog';
import { promptInput } from '@/terminal/prompts/promptInput';
import { buildConnectedServiceCredentialRecord, sealConnectedServiceCredentialCiphertext, type ConnectedServiceId } from '@happier-dev/protocol';
import { banner, bullets, cmd, dim, errorFrame, gray, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
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
        console.error(warn(`Connect target '${hiddenTarget.id}' is experimental and not enabled by default.`));
        console.error(`  ${dim(`Run: ${cmd(`happier connect --all ${hiddenTarget.id}`)}`)}`);
        process.exit(1);
      }
      console.error(errorFrame('Error:', [`Unknown connect target: ${subcommand}`]));
      showConnectHelp(visibleTargets, { includeExperimental });
      process.exit(1);
    }

    await handleConnectVendor(visibleTarget, options);
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
    console.log([
      `${sectionTitle('happier connect')} - Connect AI vendor subscriptions and API keys to Happier cloud`,
      '',
      sectionTitle('Usage:'),
      targetLines,
      `  ${cmd('happier connect status')}       Show connection status for all vendors`,
      `  ${cmd('happier connect help')}         Show this help message`,
      `  ${cmd('happier connect --all ...')}    Include experimental providers`,
      `  ${cmd('happier connect <target> --profile <id>')}      Store under a specific profile (default: default)`,
      `  ${cmd('happier connect <target> --paste')}             Headless mode: paste redirect URL`,
      `  ${cmd('happier connect <target> --device')}            Use device-code auth (Codex)`,
      `  ${cmd('happier connect codex --api-key')}              Store an OpenAI API key`,
      `  ${cmd('happier connect claude --api-key')}             Store an Anthropic API key (not Claude subscription)`,
      `  ${cmd('happier connect claude --setup-token')}         Store a Claude setup-token (default for claude)`,
      `  ${cmd('happier connect claude --oauth')}               Store Claude subscription OAuth (advanced)`,
      `  ${cmd('happier connect <target> --no-open')}           Do not attempt to open a browser`,
      `  ${cmd('happier connect <target> --timeout <seconds>')} Override OAuth timeout`,
      '',
      sectionTitle('Description:'),
      '  The connect command allows you to securely store your connected-service credentials',
      '  in Happier cloud. This enables you to use these services through Happier',
      '  without exposing credentials locally.',
      '',
      sectionTitle('Examples:'),
      `  ${cmd(`happier connect ${targets[0]?.id ?? 'gemini'}`)}`,
      `  ${cmd('happier connect status')}`,
      '',
      sectionTitle('Notes:'),
      bullets([
        `You must be authenticated with Happier first (run ${cmd('happier auth login')})`,
        'Credentials are encrypted and stored securely in Happier cloud',
        'You can manage your stored keys at app.happier.dev',
        opts.includeExperimental ? null : 'Some providers are experimental; use --all to show them',
      ]),
      '',
    ].join('\n'));
}

function formatTargetLine(target: CloudConnectTarget): string {
  const statusSuffix = target.status === 'wired' ? '' : gray(' (experimental)');
  return `  happier connect ${target.id.padEnd(12)} ${target.vendorDisplayName}${statusSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function handleConnectVendor(target: CloudConnectTarget, options: ConnectParsedOptions): Promise<void> {
    console.log(`\n${banner(`Connecting ${target.vendorDisplayName}`, { subtitle: 'Happier cloud' })}\n`);

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(warn('Not authenticated with Happier'));
        console.log(`  ${dim(`Please run ${cmd('happier auth login')} first`)}`);
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
            : serviceId === 'openai'
              ? 'Paste OpenAI API key: '
              : 'Paste Anthropic API key: ';
        const token = (await promptInput(promptLabel)).trim();
        if (!token) throw new Error(authIntent.tokenKind === 'setup-token' ? 'Missing setup-token' : 'Missing API key');
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
        const expiresAt = (() => {
          const expiresIn = t.expires_in;
          if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
            return now + Math.trunc(expiresIn) * 1000;
          }
          return null;
        })();
        const account = isRecord(t.account) ? t.account : null;
        return buildConnectedServiceCredentialRecord({
          now,
          serviceId,
          profileId: options.profileId,
          kind: 'oauth',
          expiresAt,
          oauth: {
            accessToken: String(t.access_token ?? ''),
            refreshToken: String(t.refresh_token ?? ''),
            idToken: null,
            scope: typeof t.scope === 'string' ? t.scope : null,
            tokenType: typeof t.token_type === 'string' ? t.token_type : null,
            providerAccountId: account && typeof account.uuid === 'string' ? account.uuid : null,
            providerEmail: account && typeof account.email_address === 'string' ? account.email_address : null,
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

    console.log(`🚀 Registering ${target.displayName} credential with server (${record.serviceId}/${options.profileId})`);
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
    console.log(`\n${sectionTitle('Connection status')}\n`);

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(warn('Not authenticated with Happier'));
        console.log(`  ${dim(`Please run ${cmd('happier auth login')} first`)}`);
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    for (const target of targets) {
      try {
        const serviceIds: ConnectedServiceId[] = resolveConnectTargetServiceIds(target.id);

        if (serviceIds.length === 0) {
          console.log(`  ${neutral(`${target.vendorDisplayName}: not supported`)}`);
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
          console.log(`  ${(needsReauth ? warn : neutral)(`${target.vendorDisplayName}: ${label}`)}`);
          continue;
        }

        const primary = connected[0]!;
        const userInfo = primary.providerEmail ? gray(` (${primary.providerEmail})`) : '';
        console.log(`  ${ok(`${target.vendorDisplayName}: connected`)}${userInfo}`);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error(gray(`[debug] failed to check ${target.vendorDisplayName} connection:`), error);
        }
        console.log(`  ${warn(`${target.vendorDisplayName}: unknown (check failed)`)}`);
      }
    }

    console.log('');
    console.log(dim(`To connect a vendor, run: ${cmd('happier connect <vendor>')}`));
    console.log(dim(`Example: ${cmd('happier connect gemini')}`));
    console.log('');
}

export async function handleConnectCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleConnectCommand(context.args.slice(1));
  } catch (error) {
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
