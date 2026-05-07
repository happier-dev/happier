import chalk from 'chalk';

import { reloadConfiguration } from '@/configuration';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import {
  getActiveServerProfile,
  listServerProfiles,
  upsertServerProfileByUrl,
  type ServerProfile,
} from '@/server/serverProfiles';
import { buildMissingLocalRelayError, resolveLocalRelay } from '@/utils/localRelay';
import { getReleaseRingPublicLabel } from '@happier-dev/release-runtime/releaseRings';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';

import {
  argvValue,
  defaultNameFromUrl,
  defaultWebappUrlFromServerUrl,
  normalizeUrlOrThrow,
} from '../server/commandUtilities';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { resolveInstalledDaemonServiceInventoryForCurrentRelay } from '@/daemon/ownership/daemonServiceInventory';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import { handleAuthCommand } from '../auth';
import { handleDaemonCliCommand } from '../daemon';

import { runRelayHostSubcommand } from './host';

type RelaySetJsonResult = Readonly<{
  serverId: string;
  serverUrl: string;
  comparableKey: string;
  changed: boolean;
  used: boolean;
}>;

type RelayInspectTargetJsonResult = Readonly<{
  active: Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    localServerUrl?: string;
    webappUrl: string;
    comparableKey: string;
    lastUsedAt?: number;
  }>;
}>;

function resolveProfileByComparableKey(
  profiles: readonly ServerProfile[],
  comparableKey: string,
): ServerProfile | null {
  for (const profile of profiles) {
    try {
      if (createServerUrlComparableKey(profile.serverUrl) === comparableKey) {
        return profile;
      }
      if (profile.localServerUrl && createServerUrlComparableKey(profile.localServerUrl) === comparableKey) {
        return profile;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function firstPositionalArg(args: readonly string[]): string {
  for (const arg of args) {
    const value = String(arg ?? '').trim();
    if (!value) continue;
    if (value.startsWith('--')) continue;
    return value;
  }
  return '';
}

function summarizeProfile(profile: ServerProfile): RelayInspectTargetJsonResult['active'] {
  return {
    id: profile.id,
    name: profile.name,
    serverUrl: profile.serverUrl,
    ...(profile.localServerUrl ? { localServerUrl: profile.localServerUrl } : {}),
    webappUrl: profile.webappUrl,
    comparableKey: createServerUrlComparableKey(profile.serverUrl),
    ...(typeof profile.lastUsedAt === 'number' ? { lastUsedAt: profile.lastUsedAt } : {}),
  };
}

async function cmdInspectTarget(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const active = await getActiveServerProfile();
  const payload: RelayInspectTargetJsonResult = {
    active: summarizeProfile(active),
  };

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'relay_inspect_target', data: payload });
    return;
  }

  console.log(chalk.bold('Resolved relay target'));
  console.log(chalk.gray(`  ${payload.active.name} (${payload.active.id})`));
  console.log(chalk.gray(`  relay: ${payload.active.serverUrl}`));
  if (payload.active.localServerUrl && payload.active.localServerUrl !== payload.active.serverUrl) {
    console.log(chalk.gray(`  local: ${payload.active.localServerUrl}`));
  }
  console.log(chalk.gray(`  webapp: ${payload.active.webappUrl}`));
}

type CmdSetOptions = Readonly<{
  /**
   * When true, suppress the upsert result line (`✓ Active relay …`, `✓ Saved …`,
   * or `= Relay unchanged …`) and the resolved-local-relay info line. Used by
   * `relay start-daemon` which emits one consolidated line for its whole flow.
   */
  silent?: boolean;
}>;

async function cmdSet(args: string[], options: CmdSetOptions = {}): Promise<void> {
  const resolvedArgs = await resolveLocalRelayArgIfRequested(args, { silent: options.silent });
  const json = wantsJson(resolvedArgs);
  const shouldUse = resolvedArgs.includes('--use');
  const serverUrlRaw = argvValue(resolvedArgs, '--server-url')
    || argvValue(resolvedArgs, '--relay-url')
    || firstPositionalArg(resolvedArgs);
  if (!serverUrlRaw) {
    throw new Error('Usage: happier relay set <relay-url | --local> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>]');
  }

  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, 'relay url');
  const comparableKey = createServerUrlComparableKey(serverUrl);

  const beforeProfiles = await listServerProfiles();
  const beforeActive = await getActiveServerProfile();
  const beforeMatch = resolveProfileByComparableKey(beforeProfiles, comparableKey);
  const beforeMatchId = beforeMatch?.id ?? null;
  const beforeMatchActive = beforeMatchId != null && beforeActive.id === beforeMatchId;

  const nameFromArgs = String(argvValue(resolvedArgs, '--name') ?? '').trim();
  const localServerUrlRaw = String(argvValue(resolvedArgs, '--local-server-url') ?? '').trim();
  const localServerUrl = localServerUrlRaw ? normalizeUrlOrThrow(localServerUrlRaw, 'local relay url') : '';
  const webappUrlRaw = String(argvValue(resolvedArgs, '--webapp-url') ?? '').trim();
  const webappUrl = webappUrlRaw ? normalizeUrlOrThrow(webappUrlRaw, 'webapp url') : defaultWebappUrlFromServerUrl(serverUrl);

  const name = nameFromArgs || (beforeMatch?.name ? beforeMatch.name : defaultNameFromUrl(serverUrl));
  const upserted = await upsertServerProfileByUrl({
    name,
    serverUrl,
    ...(localServerUrl ? { localServerUrl } : {}),
    webappUrl,
    use: shouldUse,
  });
  reloadConfiguration();

  const changed = !beforeMatch ||
    beforeMatch.name !== upserted.name ||
    beforeMatch.serverUrl !== upserted.serverUrl ||
    (beforeMatch.localServerUrl ?? '') !== (upserted.localServerUrl ?? '') ||
    beforeMatch.webappUrl !== upserted.webappUrl;
  const used = shouldUse && !beforeMatchActive;

  const payload: RelaySetJsonResult = {
    serverId: upserted.id,
    serverUrl: upserted.serverUrl,
    comparableKey,
    changed,
    used,
  };

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'relay_set', data: payload });
    return;
  }

  if (options.silent) return;

  if (used) {
    console.log(chalk.green(`✓ Active relay: ${upserted.name} (${upserted.id})`));
  } else if (changed) {
    console.log(chalk.green(`✓ Saved relay: ${upserted.name} (${upserted.id})`));
  } else {
    console.log(chalk.gray(`= Relay unchanged: ${upserted.name} (${upserted.id})`));
  }
  console.log(chalk.gray(`  ${upserted.serverUrl}`));
}

function parseLocalChannelFlag(args: readonly string[]): Readonly<{ channel: 'stable' | 'preview' | 'dev' | null; rest: string[] }> {
  const rest: string[] = [];
  let channel: 'stable' | 'preview' | 'dev' | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] ?? '');
    if (a === '--local-channel') {
      const value = String(args[i + 1] ?? '').trim().toLowerCase();
      if (value !== 'stable' && value !== 'preview' && value !== 'dev') {
        throw new Error('Invalid --local-channel value (expected stable|preview|dev)');
      }
      channel = value;
      i += 1;
      continue;
    }
    if (a.startsWith('--local-channel=')) {
      const value = a.slice('--local-channel='.length).trim().toLowerCase();
      if (value !== 'stable' && value !== 'preview' && value !== 'dev') {
        throw new Error('Invalid --local-channel value (expected stable|preview|dev)');
      }
      channel = value;
      continue;
    }
    rest.push(a);
  }
  return { channel, rest };
}

/**
 * Strip `--local` (and `--local-channel <c>`), resolve the local relay URL,
 * and insert it as the positional arg. Prints an informational line telling
 * the user which channel's relay we picked — critical when the current CLI's
 * inferred channel doesn't match the only installed relay, so the user sees
 * exactly what they're activating.
 */
async function resolveLocalRelayArgIfRequested(
  args: readonly string[],
  options: Readonly<{ silent?: boolean }> = {},
): Promise<string[]> {
  if (!args.includes('--local') && !args.some((a) => a === '--local-channel' || a.startsWith('--local-channel='))) {
    return [...args];
  }
  const { channel, rest } = parseLocalChannelFlag(args);
  const filtered = rest.filter((a) => a !== '--local');
  const match = await resolveLocalRelay({ channel });
  if (!match) {
    const targetChannel = channel
      ?? getReleaseRingPublicLabel(resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId);
    throw new Error(await buildMissingLocalRelayError(targetChannel));
  }
  // Surface the resolved channel so the user sees exactly which local relay
  // is being activated — the current CLI channel is not always obvious from
  // the invocation (e.g. running `node apps/cli/bin/happier.mjs` directly).
  // Callers running a multi-step flow (e.g. relay start-daemon) can suppress
  // this and print their own consolidated line.
  if (!options.silent) {
    console.log(chalk.gray(`  (local relay on ${match.channel} channel: ${match.url})`));
  }
  filtered.unshift(match.url);
  return filtered;
}

async function cmdUse(args: string[], options: CmdSetOptions = {}): Promise<void> {
  // `relay use <url>` == `relay set <url> --use`
  const withUse = args.includes('--use') ? [...args] : [...args, '--use'];
  await cmdSet(withUse, options);
}

async function cmdAdd(args: string[]): Promise<void> {
  // `relay add <url>` == `relay set <url>` (no --use). Strip any accidental
  // --use so the verb semantics are preserved.
  await cmdSet(args.filter((a) => a !== '--use'));
}

/**
 * Convenience alias: `happier relay start-daemon` == `happier relay use --local`
 * followed by either `happier service start` (when a managing background
 * service already exists for this relay profile) or `happier daemon start`
 * (when no service is installed). We check the service inventory *after*
 * activating the profile so the match uses the newly-active server id.
 *
 * Output: we suppress `cmdUse`'s upsert-result + local-relay info lines and
 * emit one consolidated line covering the whole flow.
 */
/**
 * Convenience alias: `happier relay auth` == `happier relay use --local`
 * followed by `happier auth login`. Ensures the auth flow targets the same
 * local-relay profile that `relay start-daemon` / `service install
 * --local-relay` use, so users don't have to manually `relay use --local`
 * and remember which profile the daemon is pointing at.
 *
 * Extra args (e.g. `--force`, `--no-open`, `--method mobile`) pass through
 * to the underlying auth login handler unchanged.
 */
async function cmdAuth(args: string[]): Promise<void> {
  const { channel: explicitChannel, rest } = parseLocalChannelFlag(args);
  const match = await resolveLocalRelay({ channel: explicitChannel });
  if (!match) {
    const targetChannel = explicitChannel
      ?? getReleaseRingPublicLabel(resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId);
    throw new Error(await buildMissingLocalRelayError(targetChannel));
  }
  console.log(chalk.cyan(`→ Using local ${match.channel} relay at ${match.url}`));

  await cmdUse(['--local', ...rest.filter((a) => a !== '--local')], { silent: true });

  console.log(chalk.gray('  Starting auth login for this profile…'));
  await handleAuthCommand(['login', ...rest.filter((a) => a !== '--local')]);
}

async function cmdStartDaemon(args: string[]): Promise<void> {
  // Pre-resolve the local relay URL so we can emit a clean one-liner BEFORE
  // cmdUse runs its upsert silently. Reusing resolveLocalRelay (same helper
  // cmdUse will use) keeps the resolution policy in one place.
  const { channel: explicitChannel } = parseLocalChannelFlag(args);
  const match = await resolveLocalRelay({ channel: explicitChannel });
  if (!match) {
    const targetChannel = explicitChannel
      ?? getReleaseRingPublicLabel(resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId);
    throw new Error(await buildMissingLocalRelayError(targetChannel));
  }
  console.log(chalk.cyan(`→ Using local ${match.channel} relay at ${match.url}`));

  await cmdUse(['--local', ...args.filter((a) => a !== '--local')], { silent: true });

  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode: 'user', systemUser: '' });
  const installed = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime).catch(() => [] as const);
  if (installed.length > 0) {
    console.log(chalk.gray('  Managed by a background service — starting via `service start`…'));
    await handleDaemonCliCommand({
      args: ['daemon', 'service', 'start'],
      rawArgv: process.argv,
      terminalRuntime: null,
    });
    return;
  }
  console.log(chalk.gray('  Starting daemon…'));
  await handleDaemonCliCommand({
    args: ['daemon', 'start'],
    rawArgv: process.argv,
    terminalRuntime: null,
  });
}

export async function runRelaySubcommand(subcommand: string, args: string[]): Promise<boolean> {
  switch (subcommand) {
    case 'inspect-target':
      await cmdInspectTarget(args.slice(1));
      return true;
    case 'set':
      await cmdSet(args.slice(1));
      return true;
    case 'use':
      await cmdUse(args.slice(1));
      return true;
    case 'add':
      await cmdAdd(args.slice(1));
      return true;
    case 'start-daemon':
      await cmdStartDaemon(args.slice(1));
      return true;
    case 'auth':
      await cmdAuth(args.slice(1));
      return true;
    case 'host':
      await runRelayHostSubcommand(args.slice(1));
      return true;
    default:
      return false;
  }
}
