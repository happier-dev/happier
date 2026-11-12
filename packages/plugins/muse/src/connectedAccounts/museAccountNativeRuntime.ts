import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';
import { QuotaFetchError, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { META_API_KEY_ENV_KEY, MUSE_NATIVE_AUTH_FILE_ID, MUSE_NATIVE_HOME } from './declarations.js';
import { openMuseMsp, type MuseMsp } from '../agent/msp.js';
import { parseMuseUsageObservation, readMuseQuotaObservation, readMuseUsageRefreshFailure } from './observations.js';
import { parseMuseNativeAuth } from './nativeAuth.js';
import { museAccountConnectedResult, museConnectedAccountRuntime as portableRuntime, stageMuseNativeCredentials } from './museAccountRuntime.js';

/** Native import and on-demand Account allowance own their isolated filesystem access. */
export const museConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...portableRuntime,
  async quota(context, options) {
    const signal = options?.signal ?? context.signal;
    signal.throwIfAborted();
    if ((await museAccountConnectedResult(context.credentials, { signal })).accessMode !== 'subscription') return readMuseQuotaObservation();
    const material = await portableRuntime.materialize({ kind: 'files', fileIds: [MUSE_NATIVE_AUTH_FILE_ID] }, context, { signal });
    if (material.kind !== 'files') return readMuseQuotaObservation();
    const root = await mkdtemp(join(tmpdir(), 'happier-muse-quota-'));
    const configRoot = join(root, 'config');
    let msp: MuseMsp | undefined;
    try {
      const authPath = join(configRoot, MUSE_NATIVE_AUTH_FILE_ID);
      await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
      await writeFile(authPath, material.files[MUSE_NATIVE_AUTH_FILE_ID]!, { mode: 0o600, signal });
      // On existing quota-owner demand only: measured Muse 1.4.15 cost is ~2.3–2.8s
      // plus one fresh key mint; native initialization also creates local catalogs/traces.
      // Sessions retain their selected key; usage/refresh requires this OAuth-only host.
      msp = await openMuseMsp({ exec: context.services.exec, signal,
        launch: { executable: { kind: 'systemTool', id: 'muse-cli' }, cwd: root,
          env: { HOME: root, [MUSE_NATIVE_HOME.environmentKey]: configRoot,
            XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
            // Muse treats blank as absent; mask any inherited Machine key.
            [META_API_KEY_ENV_KEY]: '' } },
        initialize: { capabilities: { experimentalApi: true } },
      });
      const parsed = parseMuseUsageObservation(await msp.client.request('usage/refresh', {}, { signal }));
      return parsed.status === 'supported' ? parsed.observation : readMuseQuotaObservation();
    } catch (error) {
      signal.throwIfAborted();
      const failure = readMuseUsageRefreshFailure(error);
      if (failure.code === -32080) throw new QuotaFetchError('Muse usage refresh is rate-limited.', {
        status: 429, quotaFetchErrorCode: 'provider_backoff', providerCode: '-32080',
        retryAfterMs: typeof failure.retryAfterMs === 'number' ? failure.retryAfterMs : undefined,
      });
      if (failure.code === -32081 || failure.code === -32082) return readMuseQuotaObservation(failure);
      throw error;
    } finally {
      try { await msp?.dispose(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  },
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
