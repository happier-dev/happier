import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { createModalProvisionerRoles } from './roles.js';
import { MODAL_ACCOUNT_PURPOSE, MODAL_ENV_KEYS } from './connectedAccount.js';

export type ModalRole = keyof ReturnType<typeof createModalProvisionerRoles>;
export type ModalScopedRequest = Readonly<{ role: ModalRole; input: unknown; observedAt: number; aborted: boolean }>;

/** Per-invocation vendor isolation: modal@0.11.0 reads config during evaluation
 * and ignores constructor endpoint. A fresh Worker environment is therefore
 * required before import; it never mutates the daemon's environment/profile. */
export async function invokeScopedModalRole(role: ModalRole, input: unknown, context: PluginInvocationContext): Promise<unknown> {
  const binding = await context.services.connectedAccounts.getBinding(MODAL_ACCOUNT_PURPOSE, { signal: context.signal });
  if (!binding) throw Object.assign(new Error('Selected Modal credential unavailable'), { code: 'credential_unavailable' });
  const selected = await context.services.connectedAccounts.materialize(MODAL_ACCOUNT_PURPOSE,
    { kind: 'environment', keys: MODAL_ENV_KEYS }, { signal: context.signal, expectedAccount: binding.account });
  if (selected.kind !== 'environment' || !selected.env.MODAL_TOKEN_ID || !selected.env.MODAL_TOKEN_SECRET || !selected.env.MODAL_SERVER_URL) {
    throw Object.assign(new Error('Selected Modal profile unavailable'), { code: 'credential_unavailable' });
  }
  if (context.signal.aborted) throw Object.assign(new Error('Modal operation cancelled'), { code: 'modal_operation_cancelled' });
  const env: Record<string, string> = {};
  for (const key of MODAL_ENV_KEYS) if (selected.env[key] !== undefined) env[key] = selected.env[key];
  // An uncreated task-owned path suppresses the SDK's ambient ~/.modal.toml.
  env.MODAL_CONFIG_PATH = join(tmpdir(), `happier-modal-config-${randomUUID()}`, 'absent.toml');
  env.MODAL_LOGLEVEL = 'error';
  const request: ModalScopedRequest = { role, input, observedAt: context.invokedAtMs, aborted: false };
  // The host's CJS author loader supplies a package-rooted require; source ESM
  // uses this module's URL. Both follow the package's declared imports map.
  const packageRequire = typeof require === 'function' ? require : createRequire(import.meta.url);
  const worker = new Worker(packageRequire.resolve('#modal-sdk-worker'), { env, workerData: request });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        worker.postMessage({ kind: 'cancel' });
        if (role !== 'acquire') {
          cleanup();
          reject(Object.assign(new Error('Modal operation cancelled with native outcome unconfirmed'), { code: 'modal_operation_cancelled' }));
        }
      };
      context.signal.addEventListener('abort', abort, { once: true });
      const cleanup = () => context.signal.removeEventListener('abort', abort);
      worker.once('message', (result: unknown) => {
        cleanup();
        if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === true && 'value' in result) resolve(result.value);
        else {
          const code = typeof result === 'object' && result !== null && 'code' in result && typeof result.code === 'string'
            && /^(?:modal_[a-z_]+|invalid_request)$/.test(result.code) ? result.code : 'modal_native_unavailable';
          reject(Object.assign(new Error('Modal native operation unavailable'), { code }));
        }
      });
      worker.once('error', () => { cleanup(); reject(Object.assign(new Error('Modal SDK worker unavailable'), { code: 'modal_sdk_unavailable' })); });
      worker.once('exit', () => { cleanup(); reject(Object.assign(new Error('Modal SDK worker ended without a result'), { code: 'modal_outcome_unknown' })); });
      // Only allocation must await late custody. Other cancelled operations
      // dispose this private worker below, without claiming guest termination
      // or undoing a native effect; retained resource inspection stays available.
      if (context.signal.aborted) abort();
    });
  } finally {
    await worker.terminate();
  }
}
