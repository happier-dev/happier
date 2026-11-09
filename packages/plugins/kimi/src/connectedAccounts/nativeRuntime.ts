import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { resolveKimiStore } from '../agent/externalSessions/source.js';
import { parseKimiNodeCredentials, resolveKimiNodeCredentialReference, serializeKimiSelectedConfig } from './nativeCredentials.js';
import { createKimiConnectedAccountRuntime, materializeKimiCredentials, resolveKimiInstallId } from './runtime.js';

async function readNative(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const home = await resolveKimiStore({ kind: 'kimiCodeHome' });
  const { parse } = await import('smol-toml');
  const config = parse(await readFile(join(home.root, 'config.toml'), { encoding: 'utf8', signal }));
  const reference = resolveKimiNodeCredentialReference(config);
  const tokens = parseKimiNodeCredentials(JSON.parse(await readFile(join(home.root, reference.credentialFile), { encoding: 'utf8', signal })));
  const credentials: Record<string, string> = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    expiresAtMs: String(tokens.expiresAtMs), credentialKind: 'oauth', apiBase: reference.baseUrl, apiKind: 'code',
    nativeConfig: JSON.stringify(serializeKimiSelectedConfig(config)),
    ...(reference.oauthHost ? { oauthHost: reference.oauthHost } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}), ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
    ...(tokens.expiresIn === undefined ? {} : { expiresIn: String(tokens.expiresIn) }),
  };
  return { credentials, reader: { async get(key: string) { return credentials[key] ?? null; } } };
}
/** Only the daemon graph can read native files. Import is an explicit attempt, never a refresh fallback. */
export function createKimiNativeConnectedAccountRuntime(): ConnectedAccountRuntime {
  const portable = createKimiConnectedAccountRuntime();
  return { ...portable,
    authentication: { modes: { ...portable.authentication.modes,
      'native-import': { kind: 'manual', async complete(input, context, options) {
        if (input.fields.source !== 'native') return { status: 'rejected', diagnostic: { code: 'kimi_native_source_unsupported', severity: 'error', message: 'Select the native Kimi login source.' } };
        const signal = options?.signal ?? context.signal;
        try {
          const native = await readNative(signal);
          native.credentials.deviceId = await resolveKimiInstallId(context);
          for (const [key, value] of Object.entries(native.credentials)) await context.attemptCredentials.set(key, value, { signal });
          return { status: 'connected', credentialKind: 'oauth', displayName: 'Kimi Code', scopes: native.credentials.scope?.split(/\s+/).filter(Boolean) ?? [] };
        } catch (error) {
          signal.throwIfAborted();
          return { status: 'unavailable', diagnostic: { code: 'kimi_native_credentials_unavailable', severity: 'error', message: 'Native Node Kimi credentials are unavailable or unsupported. Connect with a device code instead.' } };
        }
      } },
    } },
    async materializeNative(request, context, options) {
      const native = await readNative(options?.signal ?? context.signal);
      native.credentials.deviceId = await resolveKimiInstallId(context);
      return materializeKimiCredentials(request, { ...context, credentials: native.reader }, native.credentials.apiBase, options);
    },
  };
}
