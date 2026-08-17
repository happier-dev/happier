import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export const SERVER_STARTUP_RECEIPT_PATH_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_PATH';
export const SERVER_STARTUP_RECEIPT_NONCE_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE';

export async function writeStartupReceiptFromEnvironment(
    env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
    const receiptPath = String(env[SERVER_STARTUP_RECEIPT_PATH_ENV] ?? '').trim();
    const nonce = String(env[SERVER_STARTUP_RECEIPT_NONCE_ENV] ?? '').trim();
    if (!receiptPath || !isAbsolute(receiptPath) || !nonce || nonce.length > 256) {
        return false;
    }

    const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
    await mkdir(dirname(receiptPath), { recursive: true });
    await rm(temporaryPath, { force: true });
    await writeFile(temporaryPath, `${JSON.stringify({ nonce, pid: process.pid })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(temporaryPath, receiptPath);
    return true;
}
