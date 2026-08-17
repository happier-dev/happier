import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeStartupReceiptFromEnvironment } from './startupReceipt';

describe('writeStartupReceiptFromEnvironment', () => {
    it('atomically records only the private activation nonce and current pid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-server-startup-receipt-'));
        try {
            const receiptPath = join(root, 'startup.json');
            await expect(writeStartupReceiptFromEnvironment({
                HAPPIER_SERVER_STARTUP_RECEIPT_PATH: receiptPath,
                HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'activation-nonce-1',
            })).resolves.toBe(true);

            await expect(readFile(receiptPath, 'utf8').then(JSON.parse)).resolves.toEqual({
                nonce: 'activation-nonce-1',
                pid: process.pid,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does nothing unless both private activation values are valid', async () => {
        await expect(writeStartupReceiptFromEnvironment({})).resolves.toBe(false);
        await expect(writeStartupReceiptFromEnvironment({
            HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'relative.json',
            HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'activation-nonce-1',
        })).resolves.toBe(false);
    });
});
