import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type {
    LocalServicePreviewResourceV1,
    LocalServicePreviewTargetV1,
} from '@happier-dev/protocol';

import { createHostedWebStaticAssetPreviewResource } from '../hostedWeb';
import {
    resolveHostedWebStaticAssetRequest,
    type HostedWebStaticAssetResolveInput,
} from './resolve';

export type HostedWebStaticAssetServerVerifyResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type HostedWebStaticAssetServerHandle = Readonly<{
    baseUrl: string;
    endpoint: LocalServicePreviewTargetV1;
    previewResource: Omit<LocalServicePreviewResourceV1, 'browserTarget'>;
    previewRegistration: unknown;
    stop(): Promise<void>;
}>;

export type StartHostedWebStaticAssetServerInput =
    Omit<HostedWebStaticAssetResolveInput, 'requestPath'> & Readonly<{
        host?: string;
        verifyArtifact: (input: Readonly<{
            files: readonly Readonly<{
                relativePath: string;
                bytes: Uint8Array;
            }>[];
            digest: string;
        }>) => HostedWebStaticAssetServerVerifyResult | Promise<HostedWebStaticAssetServerVerifyResult>;
        preview: Readonly<{
            pluginId: string;
            contributionId: string;
            sessionId: string;
            machineId: string;
            title: string;
        }>;
        registerPreview?: (
            resource: Omit<LocalServicePreviewResourceV1, 'browserTarget'>,
        ) => unknown | Promise<unknown>;
        unregisterPreview?: (
            previewId: string,
        ) => unknown | Promise<unknown>;
    }>;

function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized === '[::1]'
        || /^127(?:\.|$)/u.test(normalized);
}

function listen(server: Server, host: string): Promise<LocalServicePreviewTargetV1> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.off('error', reject);
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Hosted-web static asset server did not bind a TCP address'));
                return;
            }
            resolve(Object.freeze({
                scheme: 'http' as const,
                host,
                port: address.port,
            }));
        });
    });
}

function stopServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function sendFailure(response: ServerResponse, status: number, code: string): void {
    if (response.headersSent) {
        response.destroy();
        return;
    }
    response.statusCode = status;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Happier-Static-Asset-Error', code);
    response.end();
}

function requestPath(request: IncomingMessage): string {
    try {
        return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
        return '/';
    }
}

function normalizeArtifactPath(path: string): string {
    return posix.normalize(path.trim().replace(/^\/+/u, ''));
}

function requestPathForDeclaredFile(input: Readonly<{
    assetRootId: string;
    entryPath: string;
    relativePath: string;
}>): string {
    const assetRootId = normalizeArtifactPath(input.assetRootId).replace(/\/+$/u, '');
    const entryPath = normalizeArtifactPath(input.entryPath);
    const relativePath = normalizeArtifactPath(input.relativePath);
    if (relativePath === entryPath) return '/';
    const prefix = `${assetRootId}/`;
    if (relativePath.startsWith(prefix)) {
        return `/${relativePath.slice(prefix.length)}`;
    }
    return `/${relativePath}`;
}

async function readVerifiedArtifactFiles(
    input: StartHostedWebStaticAssetServerInput,
): Promise<readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[]> {
    const files: Readonly<{ relativePath: string; bytes: Uint8Array }>[] = [];
    for (const relativePath of input.files) {
        const resolved = await resolveHostedWebStaticAssetRequest({
            ...input,
            sourceMaps: {
                enabled: true,
                allowedDigests: new Set([input.digest]),
            },
            requestPath: requestPathForDeclaredFile({
                assetRootId: input.assetRootId,
                entryPath: input.entryPath,
                relativePath,
            }),
        });
        if (!resolved.ok) {
            throw new Error(`Hosted-web static asset verification could not resolve '${relativePath}'`);
        }
        files.push(Object.freeze({
            relativePath: resolved.relativePath,
            bytes: await readFile(resolved.filePath),
        }));
    }

    const verification = await input.verifyArtifact({
        files,
        digest: input.digest,
    });
    if (!verification.ok) {
        throw new Error(`Hosted-web static asset verification failed: ${verification.reasonCode}`);
    }
    return Object.freeze(files);
}

export async function startHostedWebStaticAssetServer(
    input: StartHostedWebStaticAssetServerInput,
): Promise<HostedWebStaticAssetServerHandle> {
    const host = input.host ?? '127.0.0.1';
    if (!isLoopbackHost(host)) {
        throw new Error(`Hosted-web static asset server must bind loopback only, received '${host}'`);
    }
    const verifiedArtifactFiles = await readVerifiedArtifactFiles(input);
    const verifiedBytesByRelativePath = new Map(
        verifiedArtifactFiles.map((file) => [file.relativePath, file.bytes] as const),
    );

    const server = createServer(async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendFailure(response, 405, 'method_not_allowed');
            return;
        }

        try {
            const resolved = await resolveHostedWebStaticAssetRequest({
                ...input,
                requestPath: requestPath(request),
            });
            if (!resolved.ok) {
                sendFailure(response, resolved.status, resolved.code);
                return;
            }

            const bytes = verifiedBytesByRelativePath.get(resolved.relativePath);
            if (!bytes) {
                sendFailure(response, 500, 'static_asset_not_verified');
                return;
            }
            response.statusCode = 200;
            response.setHeader('Content-Type', resolved.contentType);
            for (const [name, value] of Object.entries(resolved.headers)) {
                response.setHeader(name, value);
            }
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            response.end(bytes);
        } catch {
            sendFailure(response, 500, 'static_asset_server_error');
        }
    });
    server.once('clientError', (_error, socket) => {
        if (!socket.writable) {
            return;
        }
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    server.unref();

    const endpoint = await listen(server, host);
    const previewResource = createHostedWebStaticAssetPreviewResource({
        ...input.preview,
        endpoint,
    });
    let previewRegistration: unknown = null;
    try {
        previewRegistration = input.registerPreview
            ? await input.registerPreview(previewResource)
            : null;
    } catch (error) {
        await stopServer(server).catch(() => undefined);
        throw error;
    }
    let stopPromise: Promise<void> | null = null;
    const stopOnce = async (): Promise<void> => {
        let unregisterError: unknown = null;
        try {
            if (input.unregisterPreview) {
                await input.unregisterPreview(previewResource.previewId);
            }
        } catch (error) {
            unregisterError = error;
        }

        await stopServer(server);
        if (unregisterError) {
            throw unregisterError;
        }
    };

    return Object.freeze({
        baseUrl: `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`,
        endpoint,
        previewResource,
        previewRegistration,
        stop: async () => {
            stopPromise ??= stopOnce();
            await stopPromise;
        },
    });
}
