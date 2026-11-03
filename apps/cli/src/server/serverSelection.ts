import { reloadConfiguration, configuration } from '@/configuration';
import { deriveServerIdFromUrl } from '@/server/serverId';
import { getServerProfile, upsertServerProfileByUrl, useServerProfile } from '@/server/serverProfiles';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveDefaultWebappUrl } from '@happier-dev/cli-common/happierCloud';
import { assertOrganizationPolicyEndpointAllowed } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] ?? '');
    if (a === name) {
      const next = String(args[i + 1] ?? '');
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      i += 1;
      continue;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(`${name}=`.length);
      if (!v) throw new Error(`Missing value for ${name}`);
      value = v;
      continue;
    }
    rest.push(a);
  }

  return { value, rest };
}

function takeFlagBool(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== name);
  return { present: rest.length !== args.length, rest };
}

function normalizeUrlOrThrow(raw: string, label: string): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`Missing ${label}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid ${label} protocol: ${url.protocol} (expected http/https)`);
  }
  return url.toString().replace(/\/+$/, '');
}

function deriveProfileNameFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const host = url.hostname.toLowerCase();
  const port = url.port ? `-${url.port}` : '';
  return `${host}${port}`;
}

function deriveDefaultWebappUrl(serverUrl: string): string {
  return resolveDefaultWebappUrl(serverUrl);
}

function takePrefixFlagValue(args: string[], name: string): { value: string | null; consumed: number } {
  const a0 = String(args[0] ?? '');
  if (a0 === name) {
    const next = String(args[1] ?? '');
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return { value: next, consumed: 2 };
  }
  if (a0.startsWith(`${name}=`)) {
    const v = a0.slice(`${name}=`.length);
    if (!v) throw new Error(`Missing value for ${name}`);
    return { value: v, consumed: 1 };
  }
  return { value: null, consumed: 0 };
}

function createLegacyPublicServerUrlFlagError(): Error {
  return new Error(
    [
      'Legacy flag --public-server-url is no longer supported.',
      'Use --local-server-url to specify the local/loopback API URL while keeping --server-url as the canonical URL.',
      '',
      'Example:',
      '  happier --server-url https://stack.example.test --local-server-url http://127.0.0.1:53545 ...',
    ].join('\n'),
  );
}

function hasLegacyPublicServerUrlFlag(args: string[]): boolean {
  return args.some((a) => a === '--public-server-url' || a.startsWith('--public-server-url='));
}

/**
 * Apply prefix-only server selection flags without persisting settings.
 *
 * Supported:
 * - --server <name-or-id>
 * - --server-url <url> [--local-server-url <url>] [--webapp-url <url>]
 *
 * Notes:
 * - Flags are consumed only from the start of the argv list.
 * - Selection is applied via env vars + reloadConfiguration(); settings.json is not modified.
 * - The returned resolved snapshot is safe to retain as trusted invocation provenance.
 */
export type EphemeralResolvedServerSelection = Readonly<
  Omit<ResolvedServerSelection, 'application'>
  & { application: Readonly<{ kind: 'ephemeralEnv' }> }
>;

export type EphemeralServerSelectionResolution = Readonly<{
  rest: string[];
  selection: EphemeralResolvedServerSelection | null;
}>;

export async function applyEphemeralServerSelectionFromPrefixArgs(
  argsRaw: string[],
): Promise<EphemeralServerSelectionResolution> {
  const args = [...argsRaw];

  let server: string | null = null;
  let serverUrl: string | null = null;
  let webappUrl: string | null = null;
  let localServerUrl: string | null = null;

  let i = 0;
  while (i < args.length) {
    const slice = args.slice(i);
    const serverFlag = takePrefixFlagValue(slice, '--server');
    if (serverFlag.consumed) {
      server = serverFlag.value;
      i += serverFlag.consumed;
      continue;
    }
    const serverUrlFlag = takePrefixFlagValue(slice, '--server-url');
    if (serverUrlFlag.consumed) {
      serverUrl = serverUrlFlag.value;
      i += serverUrlFlag.consumed;
      continue;
    }
    const webappUrlFlag = takePrefixFlagValue(slice, '--webapp-url');
    if (webappUrlFlag.consumed) {
      webappUrl = webappUrlFlag.value;
      i += webappUrlFlag.consumed;
      continue;
    }
    const localUrlFlag = takePrefixFlagValue(slice, '--local-server-url');
    if (localUrlFlag.consumed) {
      localServerUrl = localUrlFlag.value;
      i += localUrlFlag.consumed;
      continue;
    }
    const a0 = String(slice[0] ?? '');
    if (a0 === '--public-server-url' || a0.startsWith('--public-server-url=')) {
      throw createLegacyPublicServerUrlFlagError();
    }
    break;
  }

  if (!server && !serverUrl && !webappUrl && !localServerUrl) {
    return { rest: argsRaw, selection: null };
  }

  if (server && serverUrl) {
    throw new Error('Cannot use --server and --server-url together');
  }
  if (server && localServerUrl) {
    throw new Error('Cannot use --server and --local-server-url together');
  }
  if (webappUrl && !serverUrl) {
    throw new Error('Cannot use --webapp-url without --server-url');
  }

  const applyEphemeralSelectionEnv = (params: Readonly<{
    serverUrl: string;
    webappUrl: string;
    activeServerId: string;
    localServerUrl?: string | null;
  }>) => {
    applySelectionEnv({
      serverUrl: normalizeUrlOrThrow(params.serverUrl, '--server-url'),
      localServerUrl: params.localServerUrl ? normalizeUrlOrThrow(params.localServerUrl, '--local-server-url') : null,
      webappUrl: normalizeUrlOrThrow(params.webappUrl, '--webapp-url'),
      activeServerId: params.activeServerId,
    });
  };

  if (server) {
    const profile = await getServerProfile(server);
    const selection: EphemeralResolvedServerSelection = {
      homeTarget: await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: profile.id }),
      serverUrl: profile.serverUrl,
      webappUrl: profile.webappUrl,
      activeServerId: profile.id,
      localServerUrl: profile.localServerUrl ?? null,
      application: { kind: 'ephemeralEnv' },
    };
    applyEphemeralSelectionEnv(selection);
    reloadConfiguration();
    return { rest: args.slice(i), selection };
  }

  if (serverUrl) {
    let normalizedWebappUrl: string | null = null;
    if (webappUrl) {
      normalizedWebappUrl = normalizeUrlOrThrow(webappUrl, '--webapp-url');
    } else {
      // Avoid noisy config warnings by defaulting to the server origin.
      normalizedWebappUrl = new URL(normalizeUrlOrThrow(serverUrl, '--server-url')).origin;
    }
    const normalizedServerUrl = normalizeUrlOrThrow(serverUrl, '--server-url');
    const selection: EphemeralResolvedServerSelection = {
      homeTarget: await resolveCliHomeTarget({ kind: 'https_url', url: normalizedServerUrl }),
      serverUrl: normalizedServerUrl,
      webappUrl: normalizedWebappUrl,
      activeServerId: deriveServerIdFromUrl(normalizedServerUrl),
      localServerUrl: localServerUrl ? normalizeUrlOrThrow(localServerUrl, '--local-server-url') : null,
      application: { kind: 'ephemeralEnv' },
    };
    applyEphemeralSelectionEnv(selection);
    reloadConfiguration();
    return { rest: args.slice(i), selection };
  }

  throw new Error('Cannot use --local-server-url without --server-url');
}

/**
 * A server selection resolved from CLI flags, before anything is applied.
 *
 * Resolving is read-only: flags are parsed and validated and the named profile is
 * read, but neither settings nor `process.env` are written. Applying is the separate
 * explicit step below, so dry-run callers (`happier setup plan`) can report the
 * selection a real run would make without changing the machine.
 */
export type ResolvedServerSelection = Readonly<{
  /** Canonical closed Home target resolved before any selection mutation. */
  homeTarget: ResolvedHomeTarget;
  /** Canonical relay URL — what `configuration.serverUrl` becomes once applied. */
  serverUrl: string;
  /** Loopback/LAN API URL when it differs from the canonical URL. */
  localServerUrl: string | null;
  webappUrl: string;
  /** Server id this selection resolves to (derived from the URL for a URL selection). */
  activeServerId: string;
  /** How applying this selection takes effect. */
  application:
    | Readonly<{ kind: 'ephemeralEnv' }>
    | Readonly<{ kind: 'useServerProfile'; selector: string }>
    | Readonly<{ kind: 'upsertServerProfile'; name: string }>;
}>;

export type ServerSelectionResolution = Readonly<{
  /** Remaining args, with the selection flags removed. */
  rest: string[];
  /** `null` when the args carried no server selection. */
  selection: ResolvedServerSelection | null;
}>;

function applySelectionEnv(selection: Readonly<{
  serverUrl: string;
  localServerUrl: string | null;
  webappUrl: string;
  activeServerId: string;
}>): void {
  assertOrganizationPolicyEndpointAllowed(configuration.organizationPolicy, 'home', selection.serverUrl);
  const local = selection.localServerUrl;
  if (local && local !== selection.serverUrl) {
    process.env.HAPPIER_PUBLIC_SERVER_URL = selection.serverUrl;
    process.env.HAPPIER_LOCAL_SERVER_URL = local;
    process.env.HAPPIER_SERVER_URL = local;
  } else {
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
    process.env.HAPPIER_SERVER_URL = selection.serverUrl;
  }
  process.env.HAPPIER_ACTIVE_SERVER_ID = selection.activeServerId;
  process.env.HAPPIER_WEBAPP_URL = selection.webappUrl;
}

/**
 * Resolve server selection flags without applying them.
 *
 * Supported:
 * - --server <name-or-id>
 * - --server-url <url> [--local-server-url <url>] [--webapp-url <url>] [--persist|--no-persist]
 *
 * Read-only: validates the flags, reads the named profile, and returns what applying
 * the selection would do. Nothing is persisted, no env var is written, and the
 * configuration is not reloaded.
 */
export async function resolveServerSelectionFromArgs(argsRaw: string[]): Promise<ServerSelectionResolution> {
  if (hasLegacyPublicServerUrlFlag(argsRaw)) throw createLegacyPublicServerUrlFlagError();

  let args = [...argsRaw];

  const server = takeFlagValue(args, '--server');
  args = server.rest;
  const serverUrl = takeFlagValue(args, '--server-url');
  args = serverUrl.rest;
  const localServerUrl = takeFlagValue(args, '--local-server-url');
  args = localServerUrl.rest;
  const webappUrl = takeFlagValue(args, '--webapp-url');
  args = webappUrl.rest;
  const persist = takeFlagBool(args, '--persist');
  args = persist.rest;
  const noPersist = takeFlagBool(args, '--no-persist');
  args = noPersist.rest;

  if (server.value && serverUrl.value) {
    throw new Error('Cannot use --server and --server-url together');
  }

  if (server.value && localServerUrl.value) {
    throw new Error('Cannot use --server and --local-server-url together');
  }

  if (webappUrl.value && !serverUrl.value) {
    throw new Error('Cannot use --webapp-url without --server-url');
  }
  if (localServerUrl.value && !serverUrl.value) {
    throw new Error('Cannot use --local-server-url without --server-url');
  }

  if (persist.present && noPersist.present) {
    throw new Error('Cannot use --persist and --no-persist together');
  }

  const shouldPersistProfileSelection = noPersist.present ? false : true;
  const shouldPersistServerUrlSelection = persist.present ? true : false;

  if (server.value) {
    const profile = await getServerProfile(server.value);
    const homeTarget = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: profile.id });
    const local = profile.localServerUrl ? String(profile.localServerUrl).trim() : '';
    return {
      rest: args,
      selection: {
        homeTarget,
        serverUrl: profile.serverUrl,
        localServerUrl: local ? local : null,
        webappUrl: profile.webappUrl,
        activeServerId: profile.id,
        application: shouldPersistProfileSelection
          ? { kind: 'useServerProfile', selector: server.value }
          : { kind: 'ephemeralEnv' },
      },
    };
  }

  if (serverUrl.value) {
    const normalizedServerUrl = normalizeUrlOrThrow(serverUrl.value, '--server-url');
    const normalizedWebappUrl = webappUrl.value ? normalizeUrlOrThrow(webappUrl.value, '--webapp-url') : null;
    const normalizedLocalServerUrl = localServerUrl.value ? normalizeUrlOrThrow(localServerUrl.value, '--local-server-url') : null;
    const homeTarget = await resolveCliHomeTarget({ kind: 'https_url', url: normalizedServerUrl });
    return {
      rest: args,
      selection: {
        homeTarget,
        serverUrl: normalizedServerUrl,
        localServerUrl: normalizedLocalServerUrl,
        webappUrl: normalizedWebappUrl ?? deriveDefaultWebappUrl(normalizedServerUrl),
        activeServerId: deriveServerIdFromUrl(normalizedServerUrl),
        application: shouldPersistServerUrlSelection
          ? { kind: 'upsertServerProfile', name: deriveProfileNameFromServerUrl(normalizedServerUrl) }
          : { kind: 'ephemeralEnv' },
      },
    };
  }

  return { rest: args, selection: null };
}

/**
 * Apply a previously resolved server selection.
 *
 * Side effects:
 * - Updates persisted settings for a profile selection, or for `--server-url --persist`
 * - Sets env vars for an ephemeral selection
 * - Always reloads configuration
 */
export async function applyResolvedServerSelection(selection: ResolvedServerSelection): Promise<void> {
  const application = selection.application;
  switch (application.kind) {
    case 'ephemeralEnv':
      applySelectionEnv(selection);
      break;
    case 'useServerProfile':
      await useServerProfile(application.selector);
      break;
    case 'upsertServerProfile':
      await upsertServerProfileByUrl({
        name: application.name,
        serverUrl: selection.serverUrl,
        ...(selection.localServerUrl && selection.localServerUrl !== selection.serverUrl
          ? { localServerUrl: selection.localServerUrl }
          : {}),
        webappUrl: selection.webappUrl,
        use: true,
      });
      break;
  }
  reloadConfiguration();
}

/**
 * Persist only deterministic target metadata, then select that target for this
 * process without changing the user's focused Home.
 *
 * Entry coordinators use this while authentication/enrollment is still
 * pending. They explicitly focus the returned profile only after that work
 * succeeds. Standalone server-selection commands continue to use
 * `applyResolvedServerSelection` above.
 */
export async function applyResolvedServerSelectionNonFocusing(
  selection: ResolvedServerSelection,
): Promise<Readonly<{ profileId: string | null }>> {
  let profileId: string | null = null;
  const application = selection.application;

  if (application.kind === 'useServerProfile') {
    profileId = (await getServerProfile(application.selector)).id;
  } else if (application.kind === 'upsertServerProfile') {
    profileId = (await upsertServerProfileByUrl({
      name: application.name,
      serverUrl: selection.serverUrl,
      ...(selection.localServerUrl && selection.localServerUrl !== selection.serverUrl
        ? { localServerUrl: selection.localServerUrl }
        : {}),
      webappUrl: selection.webappUrl,
      use: false,
    })).id;
  }

  applySelectionEnv({
    serverUrl: selection.serverUrl,
    localServerUrl: selection.localServerUrl,
    webappUrl: selection.webappUrl,
    activeServerId: profileId ?? selection.activeServerId,
  });
  reloadConfiguration();
  return { profileId };
}

export async function prepareServerSelectionFromArgs(
  argsRaw: string[],
): Promise<Readonly<{ rest: string[]; profileId: string | null }>> {
  const { rest, selection } = await resolveServerSelectionFromArgs(argsRaw);
  if (!selection) return { rest, profileId: null };
  const applied = await applyResolvedServerSelectionNonFocusing(selection);
  return { rest, profileId: applied.profileId };
}

const SERVER_SELECTION_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

/**
 * Runs a finite operation in an existing profile's selection scope without
 * changing the persisted focused Home. The previous process selection is
 * restored even when the operation fails.
 */
export async function runWithServerProfileSelection<T>(
  profileSelector: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>(
    SERVER_SELECTION_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const profile = await getServerProfile(profileSelector);
  applySelectionEnv({
    serverUrl: profile.serverUrl,
    localServerUrl: profile.localServerUrl ?? null,
    webappUrl: profile.webappUrl,
    activeServerId: profile.id,
  });
  reloadConfiguration();
  try {
    return await run();
  } finally {
    for (const key of SERVER_SELECTION_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadConfiguration();
  }
}

/**
 * Apply server selection flags and return remaining args (with flags removed).
 *
 * Supported:
 * - --server <name-or-id>
 * - --server-url <url> [--webapp-url <url>] [--persist|--no-persist]
 *
 * Side effects:
 * - May update persisted settings (when --server is used, or when --server-url is combined with --persist)
 * - May set env vars (when --no-persist is used, or when --server-url is used without --persist)
 * - Always reloads configuration if selection is applied
 */
export async function applyServerSelectionFromArgs(argsRaw: string[]): Promise<string[]> {
  const { rest, selection } = await resolveServerSelectionFromArgs(argsRaw);
  if (selection) await applyResolvedServerSelection(selection);
  return rest;
}
