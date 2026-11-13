import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

import {
    SERVER_STARTUP_RECEIPT_NONCE_ENV,
    SERVER_STARTUP_RECEIPT_PATH_ENV,
    type ServerApiStartupIdentity,
} from '@happier-dev/cli-common/firstPartyRuntime/serverStartupReceipt';

type StartupReceiptEnvironment = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

function readArmedReceipt(env: StartupReceiptEnvironment): Readonly<{ receiptPath: string; nonce: string }> | null {
    const receiptPath = String(env[SERVER_STARTUP_RECEIPT_PATH_ENV] ?? '').trim();
    const nonce = String(env[SERVER_STARTUP_RECEIPT_NONCE_ENV] ?? '').trim();
    if (!receiptPath || !isAbsolute(receiptPath) || !nonce || nonce.length > 256) {
        return null;
    }
    return { receiptPath, nonce };
}

export type ApiStartupIdentityHolder = Readonly<{
    record: (address: AddressInfo | string | null) => void;
    read: () => ServerApiStartupIdentity | null;
}>;

/**
 * Identity of one API instance, generated here after it has listened and never taken from the
 * launcher. It stays with the API that created it, so a metrics or worker `/ready` in the same
 * process cannot expose it. Ordinary servers are not armed and hold nothing.
 */
export function createApiStartupIdentityHolder(env: StartupReceiptEnvironment): ApiStartupIdentityHolder {
    const armed = readArmedReceipt(env) !== null;
    let identity: ServerApiStartupIdentity | null = null;
    return {
        record(address) {
            if (!armed || !address || typeof address === 'string') return;
            identity = { instanceId: randomUUID(), address: address.address, port: address.port };
        },
        read: () => identity,
    };
}

export async function writeStartupReceiptFromEnvironment(
    env: StartupReceiptEnvironment,
    { api = null }: Readonly<{ api?: ServerApiStartupIdentity | null }> = {},
): Promise<boolean> {
    const armed = readArmedReceipt(env);
    if (!armed) return false;

    const temporaryPath = `${armed.receiptPath}.${process.pid}.tmp`;
    await mkdir(dirname(armed.receiptPath), { recursive: true });
    await rm(temporaryPath, { force: true });
    await writeFile(temporaryPath, `${JSON.stringify({ nonce: armed.nonce, pid: process.pid, ...(api ? { api } : {}) })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(temporaryPath, armed.receiptPath);
    return true;
}
