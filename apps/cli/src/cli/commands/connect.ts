import { randomBytes } from 'node:crypto';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import {
  isCloudConnectAuthenticateResultV1,
  type CloudAuthCredentialWriteInputV1,
  type CloudAuthCredentialWriteResultV1,
  type CloudConnectAuthenticateResultV1,
  type CloudConnectTarget,
  type CloudConnectTargetStatus,
} from '@/cloud/connectTypes';
import { configuration } from '@/configuration';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  buildConnectedAccountCredentialRecordFromOauthPayload,
  buildConnectedAccountCredentialRecordFromTokenInput,
} from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import {
  CONNECTED_ACCOUNT_DESCRIPTORS,
  ConnectedAccountDescriptorSchema,
  ConnectedServiceCredentialRecordV1Schema,
  requireConnectedAccountDescriptor,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedAccountDescriptor,
  type ConnectedAccountTokenKind,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { banner, bullets, cmd, dim, errorFrame, gray, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { parseConnectArgs, type ConnectParsedOptions } from './connect/parseConnectArgs';
import { resolveConnectAuthIntent } from './connect/resolveConnectAuthIntent';
import { resolveConnectTargetServiceIdsFromRegistry } from './connect/resolveConnectTargetServiceIds';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

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

    const { targets: allTargets, registry } = await loadConnectTargetsWithRegistry({ includeExperimental: true });
    const visibleTargets = includeExperimental ? allTargets : allTargets.filter((t) => t.status === 'wired');

    const targetById = new Map<string, CloudConnectTarget>(allTargets.map((t) => [t.id, t] as const));
    const visibleTargetById = new Map<string, CloudConnectTarget>(visibleTargets.map((t) => [t.id, t] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp(visibleTargets, { includeExperimental });
        return;
    }

    const normalized = subcommand.toLowerCase();
    if (normalized === 'status') {
      await handleConnectStatus(visibleTargets, registry);
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

    await handleConnectVendor(visibleTarget, options, registry);
}

async function loadConnectTargetsWithRegistry(
  params: Readonly<{ includeExperimental: boolean }>,
): Promise<Readonly<{ targets: CloudConnectTarget[]; registry: ResolvedContributionRegistry }>> {
  const targets: CloudConnectTarget[] = [];
  const registry = await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
  const descriptors = resolveConnectDescriptorsFromRegistry(registry);
  for (const entry of Object.values(registry.catalogEntriesById)) {
    if (!entry.getCloudConnectTarget) continue;
    targets.push(await entry.getCloudConnectTarget());
  }
  const targetIds = new Set(targets.map((target) => target.id));
  for (const descriptor of descriptors) {
    for (const mode of descriptor.connectModes) {
      if (targetIds.has(mode.targetId)) continue;
      targets.push(createDescriptorOnlyConnectTarget(descriptor, mode.targetId));
      targetIds.add(mode.targetId);
    }
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return {
    targets: params.includeExperimental ? targets : targets.filter((t) => t.status === 'wired'),
    registry,
  };
}

function resolveConnectDescriptorsFromRegistry(
  registry: Pick<ResolvedContributionRegistry, 'connectedAccountDescriptors'>,
): readonly ConnectedAccountDescriptor[] {
  const descriptorsById = new Map<string, ConnectedAccountDescriptor>();
  for (const descriptor of CONNECTED_ACCOUNT_DESCRIPTORS) {
    descriptorsById.set(descriptor.id, descriptor);
  }
  for (const contribution of registry.connectedAccountDescriptors ?? []) {
    const parsed = ConnectedAccountDescriptorSchema.safeParse(contribution.definition);
    if (!parsed.success) continue;
    descriptorsById.set(parsed.data.id, parsed.data);
  }
  return [...descriptorsById.values()];
}

function createDescriptorOnlyConnectTarget(
  descriptor: ConnectedAccountDescriptor,
  targetId: string,
): CloudConnectTarget {
  return {
    id: targetId,
    displayName: descriptor.id,
    vendorDisplayName: descriptor.id,
    vendorKey: 'scm',
    status: 'wired',
    authenticate: async () => {
      throw new Error(`Connect target '${targetId}' does not support OAuth authentication`);
    },
  };
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
      `  ${cmd('happier connect <target> --device')}            Use device-code auth when available`,
      `  ${cmd('happier connect <target> --api-key')}           Store a provider API key when supported`,
      `  ${cmd('happier connect <target> --setup-token')}       Store a provider setup-token when supported`,
      `  ${cmd('happier connect <target> --token')}             Store a provider token when supported`,
      `  ${cmd('happier connect <target> --oauth')}             Store provider subscription OAuth when supported`,
      `  ${cmd('happier connect <target> --no-open')}           Do not attempt to open a browser`,
      `  ${cmd('happier connect <target> --timeout <seconds>')} Override OAuth timeout`,
      '',
      sectionTitle('Description:'),
      '  The connect command allows you to securely store your connected-service credentials',
      '  in Happier cloud. This enables you to use these services through Happier',
      '  without exposing credentials locally.',
      '',
      sectionTitle('Examples:'),
      `  ${cmd(`happier connect ${targets[0]?.id ?? '<target>'}`)}`,
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

function resolveTokenPromptLabel(tokenKind: ConnectedAccountTokenKind, promptLabelKey: string): string {
  const labels: Readonly<Record<string, string>> = {
    'connectedServices.tokenPrompts.claudeSetupToken': 'Paste Claude setup-token (from `claude setup-token`): ',
    'connectedServices.tokenPrompts.openaiApiKey': 'Paste OpenAI API key: ',
    'connectedServices.tokenPrompts.anthropicApiKey': 'Paste Anthropic API key: ',
    'connectedServices.tokenPrompts.githubPersonalAccessToken': 'Paste GitHub fine-grained personal access token: ',
    'connectedServices.tokenPrompts.bitbucketApiToken': 'Paste Bitbucket API token or app password: ',
    'connectedServices.tokenPrompts.bitbucketEmailOrUsername': 'Paste Bitbucket email or username: ',
  };
  return labels[promptLabelKey]
    ?? (tokenKind === 'personal-access-token'
      ? 'Paste personal access token: '
      : tokenKind === 'setup-token'
        ? 'Paste setup-token: '
        : tokenKind === 'api-token'
          ? 'Paste API token: '
        : 'Paste API key: ');
}

function resolveMissingTokenError(tokenKind: ConnectedAccountTokenKind, missingValueErrorKey: string): string {
  const messages: Readonly<Record<string, string>> = {
    'connectedServices.tokenPrompts.errors.missingSetupToken': 'Missing setup-token',
    'connectedServices.tokenPrompts.errors.missingApiKey': 'Missing API key',
    'connectedServices.tokenPrompts.errors.missingPersonalAccessToken': 'Missing personal access token',
    'connectedServices.tokenPrompts.errors.missingApiToken': 'Missing API token',
    'connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername': 'Missing Bitbucket email or username',
  };
  return messages[missingValueErrorKey]
    ?? (tokenKind === 'personal-access-token'
      ? 'Missing personal access token'
      : tokenKind === 'setup-token'
        ? 'Missing setup-token'
        : tokenKind === 'api-token'
          ? 'Missing API token'
        : 'Missing API key');
}

async function registerConnectedServiceCredentialRecord(params: Readonly<{
  api: ApiClient;
  credentials: NonNullable<Awaited<ReturnType<typeof readCredentials>>>;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<void> {
  if (await params.api.getAccountEncryptionMode() === 'plain') {
    await params.api.registerConnectedServiceCredentialPlain({
      serviceId: params.record.serviceId,
      profileId: params.record.profileId,
      content: { t: 'plain', v: params.record },
    });
    return;
  }

  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    payload: params.record,
    randomBytes: (length) => randomBytes(length),
  });
  await params.api.registerConnectedServiceCredentialSealed({
    serviceId: params.record.serviceId,
    profileId: params.record.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: {
      kind: params.record.kind,
      providerEmail:
        params.record.kind === 'oauth' ? params.record.oauth.providerEmail ?? null : params.record.token.providerEmail ?? null,
      providerAccountId:
        params.record.kind === 'oauth' ? params.record.oauth.providerAccountId ?? null : params.record.token.providerAccountId ?? null,
      expiresAt: params.record.expiresAt,
    },
  });
}

function formatCloudAuthFailure(result: Extract<CloudConnectAuthenticateResultV1, { ok: false }>): string {
  const diagnostic = result.diagnostics?.[0];
  return diagnostic?.message
    ? `Cloud authentication failed (${result.code}): ${diagnostic.message}`
    : `Cloud authentication failed (${result.code})`;
}

function summarizeCloudAuthSuccess(result: Extract<CloudConnectAuthenticateResultV1, { ok: true }>): string {
  return result.credentialRef ?? result.accountRef ?? 'custom authenticator completed';
}

async function handleConnectVendor(
  target: CloudConnectTarget,
  options: ConnectParsedOptions,
  registry: ResolvedContributionRegistry,
): Promise<void> {
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
    let customAuthSuccess: Extract<CloudConnectAuthenticateResultV1, { ok: true }> | null = null;

    const writeCredentialFromCustomAuth = async (
      input: CloudAuthCredentialWriteInputV1,
    ): Promise<CloudAuthCredentialWriteResultV1> => {
      const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(input.record);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'invalid_result',
          diagnostics: [{ code: 'invalid_credential_record' }],
        };
      }
      await registerConnectedServiceCredentialRecord({
        api,
        credentials,
        record: parsed.data,
      });
      return {
        ok: true,
        credentialRef: `${parsed.data.serviceId}/${parsed.data.profileId}`,
      };
    };

    const record = await (async () => {
      const descriptors = resolveConnectDescriptorsFromRegistry(registry);
      const authIntent = resolveConnectAuthIntent({ targetId: target.id, options, descriptors });
      const serviceId: ConnectedServiceId = authIntent.serviceId;
      const descriptor = descriptors.find((candidate) => candidate.id === serviceId)
        ?? requireConnectedAccountDescriptor(serviceId);
      if (authIntent.kind === 'token') {
        if (!descriptor.tokenSetup) {
          throw new Error(`Connected account does not support token setup: ${serviceId}`);
        }
        const promptLabel = resolveTokenPromptLabel(authIntent.tokenKind, descriptor.tokenSetup.promptLabelKey);
        const identity = descriptor.tokenSetup.identity
          ? (await promptInput(resolveTokenPromptLabel(authIntent.tokenKind, descriptor.tokenSetup.identity.promptLabelKey))).trim()
          : null;
        if (descriptor.tokenSetup.identity && !identity) {
          throw new Error(resolveMissingTokenError(authIntent.tokenKind, descriptor.tokenSetup.identity.missingValueErrorKey));
        }
        const token = (await promptSecretInput(promptLabel)).trim();
        if (!token) throw new Error(resolveMissingTokenError(authIntent.tokenKind, descriptor.tokenSetup.missingValueErrorKey));
        return buildConnectedAccountCredentialRecordFromTokenInput({
          now,
          serviceId,
          profileId: options.profileId,
          token,
          providerAccountId: identity,
          providerEmail: identity,
          descriptor,
        });
      }

      const oauth = await target.authenticate({
        paste: options.paste,
        device: options.device,
        noOpen: options.noOpen,
        timeoutSeconds: options.timeoutSeconds ?? undefined,
        serviceId,
        profileId: options.profileId,
        hostServices: {
          credentials: { write: writeCredentialFromCustomAuth },
        },
      });
      if (isCloudConnectAuthenticateResultV1(oauth)) {
        if (!oauth.ok) {
          throw new Error(formatCloudAuthFailure(oauth));
        }
        customAuthSuccess = oauth;
        return null;
      }
      postConnectPayload = oauth;

      return buildConnectedAccountCredentialRecordFromOauthPayload({
        now,
        serviceId,
        profileId: options.profileId,
        payload: oauth,
      });
    })();

    if (record) {
      console.log(`🚀 Registering ${target.displayName} credential with server (${record.serviceId}/${options.profileId})`);
      await registerConnectedServiceCredentialRecord({
        api,
        credentials,
        record,
      });
      console.log(`✅ ${target.displayName} credential registered with server`);
    } else if (customAuthSuccess) {
      console.log(`✅ ${target.displayName} credential handled by custom authenticator (${summarizeCloudAuthSuccess(customAuthSuccess)})`);
    }

    if (postConnectPayload !== null) {
      target.postConnect?.(postConnectPayload);
    }
    process.exit(0);
}

/**
 * Show connection status for all vendors
 */
async function handleConnectStatus(
  targets: ReadonlyArray<CloudConnectTarget>,
  registry: Pick<ResolvedContributionRegistry, 'catalogEntriesById' | 'providerDefinitionsById'>,
): Promise<void> {
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
        const serviceIds: ConnectedServiceId[] = resolveConnectTargetServiceIdsFromRegistry(target.id, registry);

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
    const exampleVendorId = targets[0]?.id ?? '<vendor>';
    console.log(dim(`To connect a vendor, run: ${cmd('happier connect <vendor>')}`));
    console.log(dim(`Example: ${cmd(`happier connect ${exampleVendorId}`)}`));
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
