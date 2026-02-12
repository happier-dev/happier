import { execFileSync } from 'child_process';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { registerScmHandlers } from '@/rpc/handlers/scm';

export function createTestRpcManager(params?: { scopePrefix?: string; workingDirectory?: string }) {
    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptionVariant = 'legacy' as const;
    const scopePrefix = params?.scopePrefix ?? 'machine-test';
    const workingDirectory = params?.workingDirectory ?? process.cwd();

    const manager = new RpcHandlerManager({
        scopePrefix,
        encryptionKey,
        encryptionVariant,
        logger: () => undefined,
    });

    registerScmHandlers(manager, workingDirectory);

    async function call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> {
        const encryptedParams = encodeBase64(encrypt(encryptionKey, encryptionVariant, request));
        const rpcRequest: RpcRequest = {
            method: `${scopePrefix}:${method}`,
            params: encryptedParams,
        };
        const encryptedResponse = await manager.handleRequest(rpcRequest);
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedResponse));
        return decrypted as TResponse;
    }

    return { call };
}

export function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

export function runSapling(cwd: string, args: string[]): string {
    return execFileSync('sl', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
