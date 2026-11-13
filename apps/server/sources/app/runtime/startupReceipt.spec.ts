import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApiStartupIdentityHolder, writeStartupReceiptFromEnvironment } from './startupReceipt';

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

    it('records the API listen identity only when API evidence is supplied', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-server-startup-receipt-'));
        try {
            const receiptPath = join(root, 'startup.json');
            const env = {
                HAPPIER_SERVER_STARTUP_RECEIPT_PATH: receiptPath,
                HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'activation-nonce-1',
            };
            const api = { instanceId: 'instance-1', address: '0.0.0.0', port: 53944 };
            await expect(writeStartupReceiptFromEnvironment(env, { api })).resolves.toBe(true);
            await expect(readFile(receiptPath, 'utf8').then(JSON.parse)).resolves.toEqual({
                nonce: 'activation-nonce-1',
                pid: process.pid,
                api,
            });
            // A role that never started the API keeps the generic receipt.
            await expect(writeStartupReceiptFromEnvironment(env, { api: null })).resolves.toBe(true);
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

describe('createApiStartupIdentityHolder', () => {
    const armedEnv = {
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: join(tmpdir(), 'startup.json'),
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'activation-nonce-1',
    };
    const address = { address: '0.0.0.0', family: 'IPv4', port: 53944 };

    it('holds nothing until the API has listened, then a server-generated identity with the bound endpoint', () => {
        const holder = createApiStartupIdentityHolder(armedEnv);
        expect(holder.read()).toBeNull();
        holder.record(address);
        const identity = holder.read();
        expect(identity).toMatchObject({ address: '0.0.0.0', port: 53944 });
        expect(identity?.instanceId).toMatch(/^[0-9a-f-]{36}$/);
        expect(identity?.instanceId).not.toBe(armedEnv.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE);
    });

    it('stays inert unless the launcher armed a receipt, so ordinary servers expose nothing', () => {
        for (const env of [{}, { HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'n' }, { ...armedEnv, HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'relative.json' }]) {
            const holder = createApiStartupIdentityHolder(env);
            holder.record(address);
            expect(holder.read()).toBeNull();
        }
    });

    it('is local to one holder and ignores a listener without a TCP address', () => {
        const first = createApiStartupIdentityHolder(armedEnv);
        const second = createApiStartupIdentityHolder(armedEnv);
        first.record(address);
        expect(second.read()).toBeNull();
        second.record('pipe-name');
        second.record(null);
        expect(second.read()).toBeNull();
    });
});
