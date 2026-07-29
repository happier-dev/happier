import { log } from "@/utils/logging/log";
import { FastifyError, type FastifyReply } from "fastify";
import { Fastify } from "../types";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveUiConfig } from "@/app/api/uiConfig";
import { captureFastifyExceptionForSentry } from "@/app/monitoring/sentry";
import { isServerApiRequestPath } from "./serverApiPath";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";

function sendGlobalErrorResponse(
    reply: FastifyReply,
    statusCode: number,
    payload: Readonly<Record<string, unknown>>,
) {
    return reply
        .code(statusCode)
        .type("application/json; charset=utf-8")
        .serializer((value) => JSON.stringify(value))
        .send(payload);
}

function isFastifyValidationError(error: FastifyError): boolean {
    return Array.isArray((error as FastifyError & { validation?: unknown }).validation);
}

export function enableErrorHandlers(app: Fastify) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        const method = request.method;
        const url = redactPublicShareCapabilityUrl(request.url);
        const errorMessage = redactPublicShareCapabilityUrl(error.message);
        const stack = typeof error.stack === "string"
            ? redactPublicShareCapabilityUrl(error.stack)
            : error.stack;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            userAgent,
            ip,
            statusCode: error.statusCode || 500,
            errorCode: error.code,
            stack
        }, `Unhandled error: ${errorMessage}`);

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            captureFastifyExceptionForSentry(error, request as any);
            // Internal server errors - don't expose details
            return sendGlobalErrorResponse(reply, statusCode, {
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else if (statusCode === 400 && isFastifyValidationError(error)) {
            return sendGlobalErrorResponse(reply, statusCode, {
                error: 'invalid-params',
            });
        } else {
            // Client errors - can expose more details
            return sendGlobalErrorResponse(reply, statusCode, {
                error: error.name || 'Error',
                message: errorMessage || 'An error occurred',
                statusCode
            });
        }
    });

    const ui = resolveUiConfig(process.env);
    const uiDirRaw = ui.dir ?? '';
    const uiMountedAtRoot = ui.mountRoot;

    let cachedIndexHtml: { html: string; mtimeMs: number } | null = null;
    const rootDir = uiDirRaw ? resolve(uiDirRaw) : '';

    async function serveSpaIndex(reply: any): Promise<any> {
        if (!uiDirRaw) {
            reply.header('cache-control', 'no-cache');
            return reply.code(404).send({ error: 'Not found' });
        }

        const indexPath = join(rootDir, 'index.html');
        try {
            const st = await stat(indexPath);
            const mtimeMs = typeof st.mtimeMs === 'number' ? st.mtimeMs : st.mtime.getTime();
            if (!cachedIndexHtml || cachedIndexHtml.mtimeMs !== mtimeMs) {
                cachedIndexHtml = {
                    html: (await readFile(indexPath, 'utf-8')) + '\n<!-- Welcome to Happier Server! -->\n',
                    mtimeMs,
                };
            }
        } catch (err: any) {
            if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
                reply.header('cache-control', 'no-cache');
                return reply.code(404).send({ error: 'Not found' });
            }
            throw err;
        }
        reply.header('content-type', 'text/html; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.send(cachedIndexHtml.html);
    }

    // Catch-all route: in UI-root mode, SPA fallback for unknown GET routes.
    // Otherwise keep strict 404 with extra logging.
    app.setNotFoundHandler(async (request, reply) => {
        const url = request.url || '';

        if (uiDirRaw && uiMountedAtRoot && request.method === 'GET') {
            // Don't SPA-fallback for API and asset paths.
            if (
                isServerApiRequestPath(url) ||
                url.startsWith('/files/') ||
                url === '/files' ||
                url.startsWith('/_expo/') ||
                url.startsWith('/assets/') ||
                url.startsWith('/.well-known/') ||
                url === '/favicon.ico' ||
                url === '/favicon-active.ico' ||
                url === '/canvaskit.wasm' ||
                url === '/metadata.json' ||
                url === '/health' ||
                url.startsWith('/metrics')
            ) {
                // Fall through to 404 logging below
            } else {
                return await serveSpaIndex(reply);
            }
        }

        // Never log full headers (Authorization/cookies/etc).
        const userAgent = request.headers['user-agent'] || 'unknown';
        const contentType = request.headers['content-type'] || 'unknown';
        const hasAuthorization = typeof request.headers.authorization === 'string' && request.headers.authorization.length > 0;
        const safeUrl = redactPublicShareCapabilityUrl(request.url);
        log(
            { module: '404-handler', method: request.method, path: safeUrl, userAgent, contentType, hasAuthorization },
            '404 - Not found'
        );
        return reply.code(404).send({ error: 'Not found', path: safeUrl, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = redactPublicShareCapabilityUrl(request.url);
        const errorMessage = redactPublicShareCapabilityUrl(error.message);
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${errorMessage}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                const errorMessage = redactPublicShareCapabilityUrl(String(error?.message ?? error));
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: redactPublicShareCapabilityUrl(request.url),
                    stack: typeof error?.stack === "string"
                        ? redactPublicShareCapabilityUrl(error.stack)
                        : error?.stack
                }, `Response serialization error: ${errorMessage}`);
                throw error;
            }
        };
    });
}
