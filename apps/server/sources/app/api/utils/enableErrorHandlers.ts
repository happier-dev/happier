import { log } from "@/utils/logging/log";
import { FastifyError, type FastifyReply } from "fastify";
import { Fastify } from "../types";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveUiConfig } from "@/app/api/uiConfig";
import { captureFastifyExceptionForSentry } from "@/app/monitoring/sentry";
import { isServerApiRequestPath } from "./serverApiPath";
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol/crypto/publicShareCapabilityUrl';
import { redactHttpRequestUrlForLog } from "@/utils/logging/redactHttpRequestUrlForLog";
import { InactiveAccountError } from "@/app/auth/accountStatus";
import { readSharedQaSchemaMismatchDiagnostic, readPrismaQueryValidationDiagnostic, withPrismaQueryValidationDiagnostic } from '@/storage/prismaErrors';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
export { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { logUnexpectedRequestError } from './logUnexpectedRequestError';

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
        // Fresh sign-in proof adapters map this to account-disabled themselves.
        // An already-issued credential reveals no lifecycle state at effect time.
        if (error instanceof InactiveAccountError) {
            return sendGlobalErrorResponse(reply, 401, { error: "invalid_token" });
        }
        const databaseError = readDatabaseErrorCode(error);
        const correlation = {
            module: 'fastify-error' as const,
            httpRequestId: request.id,
            ...(request.externalActionExecutionRequestId ? { requestId: request.externalActionExecutionRequestId } : {}),
            ...(request.externalActionEffectActionId ? { actionId: request.externalActionEffectActionId } : {}),
        };
        if (databaseError) {
            // Expected storage refusals still need the same safe request
            // correlation as other failures; never retain SQL or HTTP input.
            logUnexpectedRequestError(error, correlation);
            return sendGlobalErrorResponse(reply, 503, { error: databaseError, statusCode: 503 });
        }
        const prismaValidation = readPrismaQueryValidationDiagnostic(error);
        if (prismaValidation) {
            logUnexpectedRequestError(error, correlation);
            captureFastifyExceptionForSentry(withPrismaQueryValidationDiagnostic(error), request);
            return sendGlobalErrorResponse(reply, 500, {
                error: 'Internal Server Error', code: prismaValidation.errorCode,
                message: 'An unexpected error occurred', statusCode: 500,
            });
        }
        const statusCode = error.statusCode || 500;
        const schemaMismatch = readSharedQaSchemaMismatchDiagnostic(error);
        if (statusCode >= 500) {
            logUnexpectedRequestError(error, correlation);
            captureFastifyExceptionForSentry(error, request);
            if (schemaMismatch) {
                return sendGlobalErrorResponse(reply, statusCode, { ...schemaMismatch, statusCode });
            }
            return sendGlobalErrorResponse(reply, statusCode, {
                error: 'Internal Server Error', code: 'internal_error',
                message: 'An unexpected error occurred', statusCode,
            });
        }
        const method = request.method;
        const url = redactHttpRequestUrlForLog(request.url);
        const errorMessage = schemaMismatch?.message ?? redactPublicShareCapabilityUrl(error.message);
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
        if (statusCode === 400 && isFastifyValidationError(error)) {
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
        const safeUrl = redactHttpRequestUrlForLog(request.url);
        log(
            { module: '404-handler', method: request.method, path: safeUrl, userAgent, contentType, hasAuthorization },
            '404 - Not found'
        );
        return reply.code(404).send({ error: 'Not found', path: safeUrl, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        // The global owner emits one content-free diagnostic for unexpected failures.
        if ((error.statusCode || 500) >= 500) return;
        const method = request.method;
        const url = redactHttpRequestUrlForLog(request.url);
        const errorMessage = readSharedQaSchemaMismatchDiagnostic(error)?.message
            ?? redactPublicShareCapabilityUrl(error.message);
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

    // Fastify forwards response serialization failures to this same global handler.
}
