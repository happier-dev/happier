import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { MUSE_NATIVE_HOME } from './declarations.js';
import { parseMuseNativeAuth } from './nativeAuth.js';
import { museAccountConnectedResult, museConnectedAccountRuntime as portableRuntime, stageMuseNativeCredentials } from './museAccountRuntime.js';

/** Only explicit selected-Machine import crosses the native filesystem boundary. */
export const museConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...portableRuntime,
  authentication: { modes: {
    ...portableRuntime.authentication.modes,
    'native-import': {
      kind: 'manual',
      async complete(input, context, options) {
        const failure = (reason: string) => ({ status: 'unavailable' as const, diagnostic: {
          code: 'plugin_connected_account_native_import_unavailable', severity: 'error' as const,
          message: 'The selected Machine has no supported complete Muse native login to import.', details: { reason },
        } });
        if (input.fields.source !== 'native') return failure('unsupported_source');
        const signal = options?.signal ?? context.signal;
        signal.throwIfAborted();
        let root: string;
        try { root = resolveConfiguredNativeHomePath(MUSE_NATIVE_HOME, process.env); }
        catch { return failure('native_root_invalid'); }
        let raw: string;
        try { raw = await readFile(join(root, 'muse', 'auth.json'), { encoding: 'utf8', signal }); } catch {
          signal.throwIfAborted();
          return failure('native_file_unavailable');
        }
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return failure('native_file_invalid'); }
        const parsed = parseMuseNativeAuth(value);
        if (parsed.status !== 'supported') return failure(parsed.status === 'unsupported' ? 'native_schema_unsupported' : 'native_file_invalid');
        await stageMuseNativeCredentials(context.attemptCredentials, parsed.auth.providers.meta, { signal });
        return museAccountConnectedResult(context.attemptCredentials, { signal });
      },
    },
  } },
};

export const museAccountNativeRuntimeDefinition = museConnectedAccountRuntime;
