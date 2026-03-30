import chalk from 'chalk';

import { reloadConfiguration } from '@/configuration';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import {
  getActiveServerProfile,
  listServerProfiles,
  upsertServerProfileByUrl,
  type ServerProfile,
} from '@/server/serverProfiles';

import {
  argvValue,
  defaultNameFromUrl,
  defaultWebappUrlFromServerUrl,
  normalizeUrlOrThrow,
} from '../server/commandUtilities';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

type RelayUpsertByUrlJsonResult = Readonly<{
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
  console.log(chalk.gray(`  server: ${payload.active.serverUrl}`));
  if (payload.active.localServerUrl && payload.active.localServerUrl !== payload.active.serverUrl) {
    console.log(chalk.gray(`  local: ${payload.active.localServerUrl}`));
  }
  console.log(chalk.gray(`  webapp: ${payload.active.webappUrl}`));
}

async function cmdUpsertByUrl(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const shouldUse = args.includes('--use');
  const serverUrlRaw = argvValue(args, '--server-url')
    || argvValue(args, '--relay-url')
    || firstPositionalArg(args);
  if (!serverUrlRaw) {
    throw new Error('Usage: happier relay upsert-by-url <relay-url> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>]');
  }

  const serverUrl = normalizeUrlOrThrow(serverUrlRaw, 'relay url');
  const comparableKey = createServerUrlComparableKey(serverUrl);

  const beforeProfiles = await listServerProfiles();
  const beforeActive = await getActiveServerProfile();
  const beforeMatch = resolveProfileByComparableKey(beforeProfiles, comparableKey);
  const beforeMatchId = beforeMatch?.id ?? null;
  const beforeMatchActive = beforeMatchId != null && beforeActive.id === beforeMatchId;

  const nameFromArgs = String(argvValue(args, '--name') ?? '').trim();
  const localServerUrlRaw = String(argvValue(args, '--local-server-url') ?? '').trim();
  const localServerUrl = localServerUrlRaw ? normalizeUrlOrThrow(localServerUrlRaw, 'local relay url') : '';
  const webappUrlRaw = String(argvValue(args, '--webapp-url') ?? '').trim();
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

  const payload: RelayUpsertByUrlJsonResult = {
    serverId: upserted.id,
    serverUrl: upserted.serverUrl,
    comparableKey,
    changed,
    used,
  };

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'relay_upsert_by_url', data: payload });
    return;
  }

  if (used) {
    console.log(chalk.green(`✓ Active relay: ${upserted.name} (${upserted.id})`));
  } else if (changed) {
    console.log(chalk.green(`✓ Saved relay: ${upserted.name} (${upserted.id})`));
  } else {
    console.log(chalk.gray(`= Relay unchanged: ${upserted.name} (${upserted.id})`));
  }
  console.log(chalk.gray(`  ${upserted.serverUrl}`));
}

export async function runRelaySubcommand(subcommand: string, args: string[]): Promise<boolean> {
  switch (subcommand) {
    case 'inspect-target':
      await cmdInspectTarget(args.slice(1));
      return true;
    case 'upsert-by-url':
      await cmdUpsertByUrl(args.slice(1));
      return true;
    default:
      return false;
  }
}
