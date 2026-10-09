import { parentPort, workerData } from 'node:worker_threads';
import { createModalProvisionerRoles } from './roles.js';
import type { ModalScopedRequest } from './scopedSdk.js';

if (!parentPort) throw new Error('Modal SDK worker requires its private parent channel');
const port = parentPort;
const request = workerData as ModalScopedRequest;
const cancellation = new AbortController();
port.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'cancel') cancellation.abort();
});
if (request.aborted) cancellation.abort();

// Vendor evaluation occurs only inside the exact selected profile environment.
const { ModalClient } = await import('modal');
const client = new ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET,
  environment: process.env.MODAL_ENVIRONMENT, logLevel: 'error' });
try {
  if (client.version() !== '0.11.0' || client.profile.serverUrl !== process.env.MODAL_SERVER_URL
    || client.profile.tokenId !== process.env.MODAL_TOKEN_ID || client.profile.tokenSecret !== process.env.MODAL_TOKEN_SECRET
    || client.environmentName() !== (process.env.MODAL_ENVIRONMENT ?? '')) {
    throw Object.assign(new Error('Modal selected SDK profile mismatch'), { code: 'modal_profile_mismatch' });
  }
  const roles = createModalProvisionerRoles(client, request.observedAt, cancellation.signal);
  const value = await roles[request.role](request.input);
  port.postMessage({ ok: true, value });
} catch (error) {
  // Native diagnostics can contain credentials or enrollment output.
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^(?:modal_[a-z_]+|invalid_request)$/.test(error.code) ? error.code : 'modal_native_unavailable';
  port.postMessage({ ok: false, code });
} finally {
  client.close();
  port.close();
}
