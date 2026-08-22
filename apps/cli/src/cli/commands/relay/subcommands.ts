import { reloadConfiguration } from '@/configuration';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { definitionList, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import {
  getActiveServerProfile,
  listServerProfiles,
  upsertServerProfileByUrl,
  type ServerProfile,
} from '@/server/serverProfiles';
import { buildMissingLocalRelayError, resolveLocalRelay } from '@/utils/localRelay';
import { resolveInstalledDaemonServiceInventoryForCurrentRelay } from '@/daemon/ownership/daemonServiceInventory';
import { resolveDaemonServiceCliRuntimeFromEnv, runDaemonServiceCliCommand } from '@/daemon/service/cli';
import { getReleaseRingPublicLabel } from '@happier-dev/release-runtime/releaseRings';

import {
  argvValue,
  defaultNameFromUrl,
  defaultWebappUrlFromServerUrl,
  isInteractiveTerminal,
  normalizeUrlOrThrow,
} from '../server/commandUtilities';
import { runServerSelectionBackgroundServiceFollowUp } from '../backgroundServiceFollowUp';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { runRelayHostSubcommand } from './host';
import { runRelayAccessSubcommand } from './access';
import { handleAuthCommand } from '../auth';
import { handleDaemonCliCommand } from '../daemon';

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
    await printJsonEnvelope({ ok: true, kind: 'relay_inspect_target', data: payload });
    return;
  }

  console.log(sectionTitle('Resolved relay target'));
  console.log(definitionList([
    { label: 'Name', value: `${payload.active.name} (${payload.active.id})` },
    { label: 'Server', value: payload.active.serverUrl },
    ...(payload.active.localServerUrl && payload.active.localServerUrl !== payload.active.serverUrl
      ? [{ label: 'Local', value: payload.active.localServerUrl }]
      : []),
    { label: 'Webapp', value: payload.active.webappUrl },
  ], { indent: '  ' }));
}

type CmdSetOptions = Readonly<{ silent?: boolean }>;

type RelayProfileEnvKey =
  | 'HAPPIER_ACTIVE_SERVER_ID'
  | 'HAPPIER_PUBLIC_SERVER_URL'
  | 'HAPPIER_LOCAL_SERVER_URL'
  | 'HAPPIER_SERVER_URL'
  | 'HAPPIER_WEBAPP_URL';

const RELAY_PROFILE_ENV_KEYS: readonly RelayProfileEnvKey[] = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
];

function parseLocalChannelFlag(args: readonly string[]): Readonly<{ channel: 'stable' | 'preview' | 'dev' | null; rest: string[] }> {
  const rest: string[] = [];
  let channel: 'stable' | 'preview' | 'dev' | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === '--local-channel') {
      const value = String(args[index + 1] ?? '').trim().toLowerCase();
      if (value !== 'stable' && value !== 'preview' && value !== 'dev') {
        throw new Error('Invalid --local-channel value (expected stable|preview|dev)');
      }
      channel = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--local-channel=')) {
      const value = arg.slice('--local-channel='.length).trim().toLowerCase();
      if (value !== 'stable' && value !== 'preview' && value !== 'dev') {
        throw new Error('Invalid --local-channel value (expected stable|preview|dev)');
      }
      channel = value;
      continue;
    }
    rest.push(arg);
  }
  return { channel, rest };
}

function inferCurrentLocalRelayChannel(): 'stable' | 'preview' | 'dev' {
  return getReleaseRingPublicLabel(resolveManagedCliReleaseChannelSync({
    processEnv: process.env,
    argv: process.argv,
    argv0: process.argv0,
    execPath: process.execPath,
  }).ringId);
}

function applyRelayProfileEnv(profile: ServerProfile): () => void {
  const previous = new Map<RelayProfileEnvKey, string | undefined>();
  for (const key of RELAY_PROFILE_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  process.env.HAPPIER_ACTIVE_SERVER_ID = profile.id;
  process.env.HAPPIER_PUBLIC_SERVER_URL = profile.serverUrl;
  process.env.HAPPIER_SERVER_URL = profile.localServerUrl ?? profile.serverUrl;
  process.env.HAPPIER_WEBAPP_URL = profile.webappUrl;
  if (profile.localServerUrl) {
    process.env.HAPPIER_LOCAL_SERVER_URL = profile.localServerUrl;
  } else {
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
  }
  reloadConfiguration();

  return () => {
    for (const key of RELAY_PROFILE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    reloadConfiguration();
  };
}

async function withRelayProfileEnv<T>(profile: ServerProfile, run: () => Promise<T>): Promise<T> {
  const restore = applyRelayProfileEnv(profile);
  try {
    return await run();
  } finally {
    restore();
  }
}

async function redirectConsoleLogToStderr<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalStdoutWrite = process.stdout.write;
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
    process.stderr.write(text);
    if (typeof encoding === 'function') {
      encoding(null);
    } else if (typeof callback === 'function') {
      callback(null);
    }
    return true;
  }) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalLog;
  }
}

async function resolveLocalRelayArgIfRequested(args: readonly string[], options: CmdSetOptions = {}): Promise<string[]> {
  const hasLocalFlag = args.includes('--local') || args.some((arg) => arg === '--local-channel' || arg.startsWith('--local-channel='));
  if (!hasLocalFlag) return [...args];
  const { channel, rest } = parseLocalChannelFlag(args);
  const match = await resolveLocalRelay({ channel });
  if (!match) {
    throw new Error(await buildMissingLocalRelayError(channel ?? inferCurrentLocalRelayChannel()));
  }
  const filtered = rest.filter((arg) => arg !== '--local');
  if (!options.silent && !wantsJson(filtered)) {
    console.log(`  (local relay on ${match.channel} channel: ${match.url})`);
  }
  return [match.url, ...filtered];
}

async function cmdSet(args: string[], options: CmdSetOptions = {}): Promise<void> {
  const resolvedArgs = await resolveLocalRelayArgIfRequested(args, options);
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
    await printJsonEnvelope({ ok: true, kind: 'relay_set', data: payload });
    return;
  }

  if (options.silent) return;

  if (used) {
    console.log(ok(`Active relay: ${upserted.name} (${upserted.id})`));
  } else if (changed) {
    console.log(ok(`Saved relay: ${upserted.name} (${upserted.id})`));
  } else {
    console.log(warn(`Relay unchanged: ${upserted.name} (${upserted.id})`));
  }
  console.log(`  ${upserted.serverUrl}`);

  // Saving a profile changes nothing for a running daemon; activating one does.
  if (used) {
    await runServerSelectionBackgroundServiceFollowUp({
      interactive: isInteractiveTerminal(),
      targetServerUrl: upserted.serverUrl,
    });
  }
}

async function cmdUse(args: string[], options: CmdSetOptions = {}): Promise<void> {
  await cmdSet(args.includes('--use') ? args : [...args, '--use'], options);
}

async function cmdAdd(args: string[]): Promise<void> {
  await cmdSet(args.filter((arg) => arg !== '--use'));
}

async function cmdAuth(args: string[]): Promise<void> {
  const { channel, rest } = parseLocalChannelFlag(args);
  const passThrough = rest.filter((arg) => arg !== '--local');
  const json = wantsJson(passThrough);
  const match = await resolveLocalRelay({ channel });
  if (!match) {
    throw new Error(await buildMissingLocalRelayError(channel ?? inferCurrentLocalRelayChannel()));
  }
  if (!json) {
    console.log(`Using local ${match.channel} relay at ${match.url}`);
  }
  await cmdSet([match.url, '--use'], { silent: true });
  const active = await getActiveServerProfile();
  await withRelayProfileEnv(active, async () => {
    if (json) {
      await redirectConsoleLogToStderr(async () => {
        await handleAuthCommand(['login', ...passThrough]);
      });
      await printJsonEnvelope({
        ok: true,
        kind: 'relay_auth',
        data: {
          channel: match.channel,
          relayUrl: match.url,
          serverId: active.id,
        },
      });
      return;
    }
    await handleAuthCommand(['login', ...passThrough]);
  });
}

async function cmdStartDaemon(args: string[]): Promise<void> {
  const { channel, rest } = parseLocalChannelFlag(args);
  const passThrough = rest.filter((arg) => arg !== '--local');
  const json = wantsJson(passThrough);
  const match = await resolveLocalRelay({ channel });
  if (!match) {
    throw new Error(await buildMissingLocalRelayError(channel ?? inferCurrentLocalRelayChannel()));
  }
  if (!json) {
    console.log(`Using local ${match.channel} relay at ${match.url}`);
  }
  await cmdSet([match.url, '--use'], { silent: true });
  const active = await getActiveServerProfile();
  await withRelayProfileEnv(active, async () => {
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode: 'user', systemUser: '' });
    const installed = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime).catch(() => [] as const);
    if (installed.length > 0) {
      await runDaemonServiceCliCommand({ argv: ['start', ...passThrough], commandPath: 'happier service' });
      return;
    }
    await handleDaemonCliCommand({
      args: ['daemon', 'start', ...passThrough],
      rawArgv: process.argv,
      terminalRuntime: null,
    });
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
    case 'access':
      await runRelayAccessSubcommand(args.slice(1));
      return true;
    default:
      return false;
  }
}
