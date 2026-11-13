import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  SERVER_STARTUP_RECEIPT_NONCE_ENV,
  SERVER_STARTUP_RECEIPT_PATH_ENV,
} from '@happier-dev/cli-common/firstPartyRuntime/serverStartupReceipt';

import { killProcessTree } from '../proc/proc.mjs';
import { proveSpawnedServerOwnership, trackSpawnedServerProcess } from './listener_ownership.mjs';
import { resolveServerShutdownGraceMs } from './shutdown_grace.mjs';

const API_LISTENING_SERVER_ROLES = new Set(['all', 'api']);

/**
 * One spawn's private receipt location and nonce. `env` goes only to that spawn. The directory
 * outlives the proof until no write can follow, because the server recreates it when writing its
 * receipt: removing it earlier would let a late write land where nothing cleans it up.
 */
export async function createServerStartupAttempt(
  { stackBaseDir, env = process.env, signal } = {},
  { trackSpawnedImpl = trackSpawnedServerProcess } = {},
) {
  const role = String(env?.SERVER_ROLE ?? '').trim();
  if (role && !API_LISTENING_SERVER_ROLES.has(role)) {
    const error = new Error(`[local] server ownership cannot be proven for SERVER_ROLE=${role}: the role has no API listener`);
    error.code = 'ESERVERROLEUNPROVABLE';
    throw error;
  }

  const directory = resolve(stackBaseDir ?? tmpdir(), 'runtime-receipts', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const path = join(directory, 'startup.json');

  let spawned = null;
  const stopTracking = async () => {
    spawned?.close();
    await spawned?.identity;
  };
  const dispose = async ({ report = console.error } = {}) => {
    await stopTracking();
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      report(`[local] could not remove server startup attempt ${directory}: ${error?.message ?? error}`);
    });
  };
  const keep = async (reason, report) => {
    await stopTracking();
    report(`[local] keeping server startup attempt ${directory}: ${reason}`);
  };

  return {
    nonce,
    path,
    env: {
      [SERVER_STARTUP_RECEIPT_PATH_ENV]: path,
      [SERVER_STARTUP_RECEIPT_NONCE_ENV]: nonce,
    },
    trackSpawned(child, options = {}) {
      spawned = trackSpawnedImpl(child, { ...options, signal });
      return spawned;
    },
    /** `wait` gets the attempt's lifetime, so shutdown ends it even if the child stays alive. */
    whileAwaitingReadiness(wait) {
      return spawned.observationScope.excludeFromBudget(() => wait(spawned.signal));
    },
    /** The identity captured at spawn, or an inconclusive answer within the caller's cleanup budget. */
    async spawnIdentity({ timeoutMs }) {
      let timer;
      const timedOut = new Promise((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout({ status: 'inconclusive', reason: 'process-identity-timeout' }),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([spawned?.identity ?? timedOut, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose,
    /** After a successful proof. A server that has not written a receipt yet still might. */
    async settleSuccess(ownership, { report = console.error } = {}) {
      if (ownership?.receiptSettled) {
        await dispose({ report });
        return;
      }
      await keep('the server has not written a receipt and still could', report);
    },
    async settleFailure({ terminated, report = console.error }) {
      if (terminated) {
        await dispose({ report });
        return;
      }
      await keep('termination of the server was not confirmed', report);
    },
  };
}

/**
 * Termination of a server that failed its startup proof, confirmed or not. It uses the shutdown
 * grace because the Windows tree kill is cut off at that grace, and the default is close to how
 * long `taskkill` takes.
 */
export async function terminateServerStartupChild(child, { env = process.env, boundary } = {}) {
  const graceMs = resolveServerShutdownGraceMs(env);
  return (await killProcessTree(child, 'SIGKILL', { graceMs, boundary }))?.ok === true;
}

/**
 * The start lifecycle for a server whose ownership must be proven before it is recorded. Only a
 * failure before the proof terminates the server: a later recording failure leaves the proven
 * server running.
 */
export async function startServerWithOwnershipProof(
  {
    stackBaseDir,
    env,
    endpoint,
    exactProcess = false,
    signal,
    spawnServer,
    waitForReady,
    recordOwnership,
    terminateServer = (child) => terminateServerStartupChild(child, { env }),
  },
  {
    proveImpl = proveSpawnedServerOwnership,
    ownershipBoundary = {},
    report,
  } = {},
) {
  const attempt = await createServerStartupAttempt({ stackBaseDir, env, signal });
  let child = null;
  let proof;
  try {
    child = await spawnServer({ ...env, ...attempt.env });
    const spawned = attempt.trackSpawned(child, ownershipBoundary);
    await attempt.whileAwaitingReadiness((readinessSignal) => waitForReady(child, { signal: readinessSignal }));
    proof = await proveImpl({ endpoint, spawned, attempt, exactProcess }, ownershipBoundary);
  } catch (error) {
    const terminated = child
      ? await Promise.resolve().then(() => terminateServer(child)).catch(() => false)
      : true;
    await attempt.settleFailure({ terminated, ...(report ? { report } : {}) });
    throw error;
  }
  try {
    return await recordOwnership({ child, proof });
  } finally {
    await attempt.settleSuccess(proof, report ? { report } : {});
  }
}
