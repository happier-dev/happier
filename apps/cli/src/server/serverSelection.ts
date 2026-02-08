import { reloadConfiguration, configuration } from '@/configuration';
import { addServerProfile, getServerProfile, useServerProfile } from '@/server/serverProfiles';

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
  if (serverUrl.replace(/\/+$/, '') === 'https://api.happier.dev') {
    return 'https://app.happier.dev';
  }
  return new URL(serverUrl).origin;
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

/**
 * Apply prefix-only server selection flags without persisting settings.
 *
 * Supported:
 * - --server <name-or-id>
 * - --server-url <url> [--webapp-url <url>] [--public-server-url <url>]
 *
 * Notes:
 * - Flags are consumed only from the start of the argv list.
 * - Selection is applied via env vars + reloadConfiguration(); settings.json is not modified.
 */
export async function applyEphemeralServerSelectionFromPrefixArgs(argsRaw: string[]): Promise<string[]> {
  const args = [...argsRaw];

  let server: string | null = null;
  let serverUrl: string | null = null;
  let webappUrl: string | null = null;
  let publicServerUrl: string | null = null;

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
    const publicUrlFlag = takePrefixFlagValue(slice, '--public-server-url');
    if (publicUrlFlag.consumed) {
      publicServerUrl = publicUrlFlag.value;
      i += publicUrlFlag.consumed;
      continue;
    }
    break;
  }

  if (!server && !serverUrl && !webappUrl && !publicServerUrl) {
    return argsRaw;
  }

  if (server && serverUrl) {
    throw new Error('Cannot use --server and --server-url together');
  }
  if (webappUrl && !serverUrl) {
    throw new Error('Cannot use --webapp-url without --server-url');
  }

  if (server) {
    const profile = await getServerProfile(server);
    process.env.HAPPIER_SERVER_URL = profile.serverUrl;
    process.env.HAPPIER_WEBAPP_URL = profile.webappUrl;
    if (publicServerUrl) {
      process.env.HAPPIER_PUBLIC_SERVER_URL = normalizeUrlOrThrow(publicServerUrl, '--public-server-url');
    }
    reloadConfiguration();
    return args.slice(i);
  }

  if (serverUrl) {
    const normalizedServerUrl = normalizeUrlOrThrow(serverUrl, '--server-url');
    let normalizedWebappUrl: string | null = null;
    if (webappUrl) {
      normalizedWebappUrl = normalizeUrlOrThrow(webappUrl, '--webapp-url');
    } else {
      // Avoid noisy config warnings by defaulting to the server origin.
      normalizedWebappUrl = new URL(normalizedServerUrl).origin;
    }

    process.env.HAPPIER_SERVER_URL = normalizedServerUrl;
    process.env.HAPPIER_WEBAPP_URL = normalizedWebappUrl;
    if (publicServerUrl) {
      process.env.HAPPIER_PUBLIC_SERVER_URL = normalizeUrlOrThrow(publicServerUrl, '--public-server-url');
    }
    reloadConfiguration();
    return args.slice(i);
  }

  // Only public server url without selection is ambiguous; treat as error.
  throw new Error('Cannot use --public-server-url without --server or --server-url');
}

/**
 * Apply server selection flags and return remaining args (with flags removed).
 *
 * Supported:
 * - --server <name-or-id>
 * - --server-url <url> [--webapp-url <url>] [--persist|--no-persist]
 *
 * Side effects:
 * - May update persisted settings (when --server or --server-url default persist)
 * - May set env vars (when --no-persist)
 * - Always reloads configuration if selection is applied
 */
export async function applyServerSelectionFromArgs(argsRaw: string[]): Promise<string[]> {
  let args = [...argsRaw];

  const server = takeFlagValue(args, '--server');
  args = server.rest;
  const serverUrl = takeFlagValue(args, '--server-url');
  args = serverUrl.rest;
  const webappUrl = takeFlagValue(args, '--webapp-url');
  args = webappUrl.rest;
  const persist = takeFlagBool(args, '--persist');
  args = persist.rest;
  const noPersist = takeFlagBool(args, '--no-persist');
  args = noPersist.rest;

  if (server.value && serverUrl.value) {
    throw new Error('Cannot use --server and --server-url together');
  }

  if (webappUrl.value && !serverUrl.value) {
    throw new Error('Cannot use --webapp-url without --server-url');
  }

  if (persist.present && noPersist.present) {
    throw new Error('Cannot use --persist and --no-persist together');
  }

  const shouldPersist = noPersist.present ? false : persist.present ? true : true;

  if (server.value) {
    if (!shouldPersist) {
      const profile = await getServerProfile(server.value);
      process.env.HAPPIER_SERVER_URL = profile.serverUrl;
      process.env.HAPPIER_WEBAPP_URL = profile.webappUrl;
    } else {
      await useServerProfile(server.value);
    }
    reloadConfiguration();
    return args;
  }

  if (serverUrl.value) {
    const normalizedServerUrl = normalizeUrlOrThrow(serverUrl.value, '--server-url');
    const normalizedWebappUrl = webappUrl.value ? normalizeUrlOrThrow(webappUrl.value, '--webapp-url') : null;
    if (!shouldPersist) {
      process.env.HAPPIER_SERVER_URL = normalizedServerUrl;
      process.env.HAPPIER_WEBAPP_URL = normalizedWebappUrl ?? deriveDefaultWebappUrl(normalizedServerUrl);
      reloadConfiguration();
      return args;
    }

    const name = deriveProfileNameFromServerUrl(normalizedServerUrl);
    await addServerProfile({
      name,
      serverUrl: normalizedServerUrl,
      webappUrl: normalizedWebappUrl ?? deriveDefaultWebappUrl(normalizedServerUrl),
      use: true,
    });
    reloadConfiguration();
    return args;
  }

  return args;
}
