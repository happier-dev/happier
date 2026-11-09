import { writeFile } from 'node:fs/promises';

const WRAPPER_CREATED = '2026-11-06T20:00:00.0000000Z';
const SERVER_CREATED = '2026-11-06T20:00:01.0000000Z';

export const TEST_SERVER_INSTANCE_ID = 'instance-1';

/** What a real server does once started: writes the armed receipt. The receipt reader needs a live PID. */
export async function writeArmedServerReceipt(env, { port, pid = process.pid, instanceId = TEST_SERVER_INSTANCE_ID }) {
  await writeFile(env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH, JSON.stringify({
    nonce: env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE,
    pid,
    api: { instanceId, address: '0.0.0.0', port: Number(port) },
  }));
}

/**
 * The OS and network answers of a Windows host for a server behind `wrapperPid`. Only these system
 * boundaries are replaced: spawn sites run the real capture, proof and cleanup above them.
 */
export function createWindowsOwnershipBoundary({
  wrapperPid,
  serverPid = process.pid,
  readyInstanceId = TEST_SERVER_INSTANCE_ID,
}) {
  return {
    platform: 'win32',
    fetchReadyIdentityImpl: async () => ({ status: 'identity', instanceId: readyInstanceId }),
    runCaptureImpl: async (_command, args) => {
      const script = String(args.at(-1));
      if (script.includes('$stopPid')) {
        return JSON.stringify([
          { pid: serverPid, parentPid: wrapperPid, creationDate: SERVER_CREATED },
          { pid: wrapperPid, parentPid: 1000, creationDate: WRAPPER_CREATED },
        ]);
      }
      return script.includes(`ProcessId=${wrapperPid}"`) ? WRAPPER_CREATED : SERVER_CREATED;
    },
  };
}

/** A healthy server from before startup identity, with stable process identities. */
export const legacyServerOwnershipBoundary = Object.freeze({
  fetchReadyIdentityImpl: async () => ({ status: 'legacy' }),
  runCaptureImpl: async () => WRAPPER_CREATED,
});

export function expectedLegacyVerifiedInstances({ listenerPid, wrapperPid }) {
  const prefix = process.platform === 'win32' ? 'win32-cim' : `${process.platform}-ps`;
  return {
    serverPid: { pid: listenerPid, fingerprint: `${prefix}:${WRAPPER_CREATED}` },
    serverWrapperPid: { pid: wrapperPid, fingerprint: `${prefix}:${WRAPPER_CREATED}` },
  };
}

export function expectedWindowsVerifiedInstances({ wrapperPid, serverPid = process.pid }) {
  return {
    serverPid: {
      pid: serverPid,
      fingerprint: `win32-cim:${serverPid === wrapperPid ? WRAPPER_CREATED : SERVER_CREATED}`,
      apiInstanceId: TEST_SERVER_INSTANCE_ID,
    },
    serverWrapperPid: {
      pid: wrapperPid,
      fingerprint: `win32-cim:${WRAPPER_CREATED}`,
      ...(serverPid === wrapperPid ? { apiInstanceId: TEST_SERVER_INSTANCE_ID } : {}),
    },
  };
}
