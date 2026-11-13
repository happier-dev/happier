import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    listenAddressCoversEndpoint,
    parseServerStartupReceipt,
    readApiStartupIdentityFromReadyPayload,
    SERVER_STARTUP_RECEIPT_NONCE_ENV,
    SERVER_STARTUP_RECEIPT_PATH_ENV,
    waitForServerStartupReceipt,
} from './serverStartupReceipt.js';

const api = { instanceId: 'instance-1', address: '0.0.0.0', port: 53944 };

describe('server startup receipt contract', () => {
    let root: string;
    let receiptPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-startup-receipt-contract-'));
        receiptPath = join(root, 'startup.json');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('keeps the released environment names that servers and installers already exchange', () => {
        expect(SERVER_STARTUP_RECEIPT_PATH_ENV).toBe('HAPPIER_SERVER_STARTUP_RECEIPT_PATH');
        expect(SERVER_STARTUP_RECEIPT_NONCE_ENV).toBe('HAPPIER_SERVER_STARTUP_RECEIPT_NONCE');
    });

    it('parses generic and API receipts and rejects malformed evidence', () => {
        expect(parseServerStartupReceipt({ nonce: 'n', pid: 12 })).toEqual({ nonce: 'n', pid: 12 });
        expect(parseServerStartupReceipt({ nonce: 'n', pid: 12, api })).toEqual({ nonce: 'n', pid: 12, api });
        for (const malformed of [
            null,
            'text',
            {},
            { nonce: '', pid: 12 },
            { nonce: 'n', pid: 0 },
            { nonce: 'n', pid: 1.5 },
            { nonce: 'n', pid: 12, api: 'x' },
            { nonce: 'n', pid: 12, api: { ...api, instanceId: '' } },
            { nonce: 'n', pid: 12, api: { ...api, port: 0 } },
            { nonce: 'n', pid: 12, api: { ...api, address: '' } },
        ]) {
            expect(parseServerStartupReceipt(malformed)).toBeNull();
        }
    });

    it('reads only a well-formed API identity from a readiness payload', () => {
        expect(readApiStartupIdentityFromReadyPayload({ status: 'ok', apiStartupIdentity: { instanceId: 'abc' } }))
            .toEqual({ instanceId: 'abc' });
        for (const payload of [null, {}, { apiStartupIdentity: 'abc' }, { apiStartupIdentity: { instanceId: '' } }]) {
            expect(readApiStartupIdentityFromReadyPayload(payload)).toBeNull();
        }
    });

    it('accepts only listen addresses that really serve the probed endpoint', () => {
        const endpoint = { host: '127.0.0.1', port: 53944 };
        expect(listenAddressCoversEndpoint({ ...api, address: '0.0.0.0' }, endpoint)).toBe(true);
        expect(listenAddressCoversEndpoint({ ...api, address: '::' }, endpoint)).toBe(true);
        expect(listenAddressCoversEndpoint({ ...api, address: '127.0.0.1' }, endpoint)).toBe(true);
        expect(listenAddressCoversEndpoint({ ...api, address: '127.0.0.1' }, { host: 'localhost', port: 53944 })).toBe(true);
        expect(listenAddressCoversEndpoint({ ...api, address: '192.168.1.20' }, endpoint)).toBe(false);
        expect(listenAddressCoversEndpoint({ ...api, port: 53945 }, endpoint)).toBe(false);
    });

    it('resolves the exact live receipt and waits past a receipt from another attempt', async () => {
        await writeFile(receiptPath, JSON.stringify({ nonce: 'old', pid: process.pid, api }), 'utf8');
        const waiting = waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: true, timeoutMs: 5_000 });
        await writeFile(receiptPath, JSON.stringify({ nonce: 'current', pid: process.pid, api }), 'utf8');
        await expect(waiting).resolves.toEqual({ nonce: 'current', pid: process.pid, api });
    });

    it('fails when the receipt never matches, the process is dead, or the budget is exhausted', async () => {
        await writeFile(receiptPath, JSON.stringify({ nonce: 'old', pid: process.pid }), 'utf8');
        await expect(waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: false, timeoutMs: 150 }))
            .rejects.toMatchObject({ code: 'timeout' });
        await writeFile(receiptPath, JSON.stringify({ nonce: 'current', pid: 2_147_483_646 }), 'utf8');
        await expect(waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: false, timeoutMs: 150 }))
            .rejects.toMatchObject({ code: 'timeout' });
        for (const timeoutMs of [0, -1, Number.NaN]) {
            await expect(waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: false, timeoutMs }))
                .rejects.toMatchObject({ code: 'timeout' });
        }
    });

    it('rejects a generic worker receipt immediately when API evidence is required', async () => {
        await writeFile(receiptPath, JSON.stringify({ nonce: 'current', pid: process.pid }), 'utf8');
        await expect(waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: true, timeoutMs: 60_000 }))
            .rejects.toMatchObject({ code: 'missing_api' });
        await expect(waitForServerStartupReceipt({ path: receiptPath, nonce: 'current', requireApi: false, timeoutMs: 1_000 }))
            .resolves.toEqual({ nonce: 'current', pid: process.pid });
    });

    it('stops promptly on cancellation', async () => {
        const controller = new AbortController();
        const waiting = waitForServerStartupReceipt({
            path: receiptPath,
            nonce: 'current',
            requireApi: true,
            timeoutMs: 60_000,
            signal: controller.signal,
        });
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    });
});
