import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { devinNativeHome } from '../agent/connectedAccount.js';
import { DEVIN_NATIVE_FILE, parseDevinNativeCredentials } from './nativeCredentials.js';
import { devinConnectedAccountRuntime as portable } from './runtime.js';

/** Only explicit selected-Machine import reads a native file; Account UI has no filesystem edge. */
export const devinNativeConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...portable,
  authentication: { modes: { ...portable.authentication.modes,
    'native-import': { kind: 'manual', async complete(input, context, options) {
      const failure = () => ({ status: 'unavailable' as const, diagnostic: {
        code: 'devin_native_import_unavailable', severity: 'error' as const,
        message: 'The selected Machine has no supported Devin native credential file to import.',
      } });
      if (input.fields.source !== 'native') return failure();
      const signal = options?.signal ?? context.signal;
      signal.throwIfAborted();
      let native;
      try {
        const root = resolveConfiguredNativeHomePath(devinNativeHome(process.platform), process.env);
        native = parseDevinNativeCredentials(parse(await readFile(join(root, DEVIN_NATIVE_FILE), { encoding: 'utf8', signal })));
      } catch { signal.throwIfAborted(); return failure(); }
      if (!native) return failure();
      const values = { credentialMode: native.mode, nativeGeneration: native.generation,
        [native.mode === 'session' ? 'sessionToken' : 'seatToken']: native.token,
        apiServerUrl: native.apiServerUrl, nativeMetadata: JSON.stringify(native.metadata) };
      for (const [key, value] of Object.entries(values)) await context.attemptCredentials.set(key, value, { signal });
      return { status: 'connected', credentialKind: native.mode === 'session' ? 'oauth' : 'token', displayName: 'Devin', scopes: [] };
    } },
  } },
};
