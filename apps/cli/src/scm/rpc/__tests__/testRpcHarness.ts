import { execFileSync } from 'child_process';
import { randomBytes } from 'node:crypto';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { ScmBackendRegistry } from '@/scm/registry';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';

/** Real registered Git runtime for RPC tests outside a running daemon's plugin activation. */
export function createTestGitRpcManager(params: { workingDirectory: string }) {
    return createTestRpcManager({ ...params, registry: createTestGitScmBackendRegistry() });
}

export function createTestGitScmBackendRegistry() {
    const registration = createGitScmBackendRuntimeRegistration();
    const runtime = registration.runtime!;
    const backend = createRegisteredScmBackendAdapter({
        definition: { id: registration.id, kind: 'git' },
        qualifiedId: `happier.scm.backend.git:${registration.id}`,
        executableDefinition: { repoModes: runtime.repoModes, capabilities: runtime.capabilities, commands: runtime.commands },
        registration,
        hostingProviderRuntimeServices: { resolveScmHostingProviderRegistry: async () => createScmHostingProviderRegistry({ providers: [] }) },
    });
    return createScmBackendRegistry([backend]);
}

export function createTestRpcManager(params?: { scopePrefix?: string; workingDirectory?: string; registry?: ScmBackendRegistry }) {
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

    registerScmHandlers(manager, workingDirectory, { registry: params?.registry });

    const content: SocketRpcContent = { mode: 'e2ee', cipher: {
        encryptRaw: async (value) => encodeBase64(encrypt(encryptionKey, encryptionVariant, value)),
        decryptRaw: async (value) => decrypt(encryptionKey, encryptionVariant, decodeBase64(value)),
    } };

    async function call<TResponse, TRequest>(method: string, request: TRequest, authorization?: SocketRpcAuthorizationContext): Promise<TResponse> {
        const callId = randomBytes(16).toString('hex');
        const prefixedMethod = `${scopePrefix}:${method}`;
        const encryptedParams = await socketRpcCodec.encodeParams(content, request, { method: prefixedMethod, callId });
        const rpcRequest: RpcRequest = {
            method: prefixedMethod,
            params: encryptedParams,
            // Genuine transport boundary fixture, outside the encrypted caller payload.
            ...(authorization ? { authorization } : {}),
        };
        const encryptedResponse = await manager.handleRequest(rpcRequest);
        const decrypted = await socketRpcCodec.decodeResult(content, { ok: true, result: encryptedResponse }, callId);
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
