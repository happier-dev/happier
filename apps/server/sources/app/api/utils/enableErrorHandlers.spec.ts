import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { describe, expect, it, vi } from 'vitest';
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from "zod/mini";
import { applyEnvValues, snapshotEnv, restoreEnv } from "../testkit/env";
import { enableErrorHandlers } from './enableErrorHandlers';
import { InactiveAccountError } from '@/app/auth/accountStatus';
import { TransactionAcquisitionUnavailableError, TransactionConflictExhaustedError, TransactionDeadlineExceededError } from '@/storage/inTx';

describe('enableErrorHandlers', () => {
    it.each([
        { error: new TransactionAcquisitionUnavailableError(new Error('private database detail')), code: 'database_connection_unavailable' },
        { error: new TransactionDeadlineExceededError(new Error('private database detail'), 'test-request'), code: 'database_transaction_timeout' },
        { error: new TransactionConflictExhaustedError(new Error('private database detail')), code: 'database_transaction_conflict_exhausted' },
    ])('maps terminal $error.name to a safe typed unavailable response', async ({ error, code }) => {
        const app = Fastify({ logger: false });
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(typed as Parameters<typeof enableErrorHandlers>[0]);
        typed.get('/terminal-transaction-error', {
            schema: { response: { 500: z.object({ error: z.literal('Internal Server Error') }) } },
        }, async () => { throw error; });
        try {
            const response = await app.inject({ method: 'GET', url: '/terminal-transaction-error' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: code, statusCode: 503 });
            expect(response.body).not.toContain('private');
        } finally { await app.close(); }
    });
    it.each([
        { name: 'PrismaClientKnownRequestError', code: 'P2028', errorClass: 'PrismaClientKnownRequestError', prismaCode: 'P2028',
            file: '/srv/happier/apps/server/sources/storage/inTx.ts' },
        { name: 'private-name', code: 'private-code', errorClass: 'Error', prismaCode: undefined,
            file: 'C:\\happier\\apps\\server\\sources\\storage\\inTx.ts' },
        { name: 'TypeError', code: 'private-code', errorClass: 'TypeError', prismaCode: undefined,
            file: '/srv/happier/apps/server/sources/app/machines/managed/managedRoutes.ts', serialization: true },
        { name: 'PrismaClientKnownRequestError', code: 'P2024', errorClass: 'PrismaClientKnownRequestError', prismaCode: 'P2024',
            file: '/srv/happier/apps/server/sources/storage/prisma.ts', statusCode: 503 },
        { name: 'TransactionAcquisitionUnavailableError', code: 'P2028', errorClass: 'TransactionAcquisitionUnavailableError', prismaCode: 'P2024',
            file: '/srv/happier/apps/server/sources/storage/inTx.ts', statusCode: 503, acquisitionCause: true },
        { name: 'PrismaClientKnownRequestError', code: 'P2010', errorClass: 'PrismaClientKnownRequestError', prismaCode: 'P2010',
            file: '/srv/happier/apps/server/sources/storage/inTx.ts', sqlState: '57014' },
    ])('logs a correlated safe global diagnostic for $errorClass without exception or request content', async diagnostic => {
        const records: Record<string, unknown>[] = [];
        const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
        const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
        const app = Fastify({ logger: false, genReqId: () => 'qb80-http-request' });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        // Authentication is the boundary: these fields are server-stamped only
        // after execution-proof verification, never copied from the HTTP body.
        app.addHook('preHandler', async request => {
            request.externalActionExecutionRequestId = 'admit-own-action';
            request.externalActionEffectActionId = 'session.attention.set';
        });
        app.post('/v1/machines/managed/controller/report', async (_request, reply) => {
            const failure = Object.assign('acquisitionCause' in diagnostic
                ? new TransactionAcquisitionUnavailableError(Object.assign(new Error('private-driver-message'), { code: 'P2024' }))
                : new Error('private-driver-message'), { name: diagnostic.name, code: diagnostic.code, message: 'private-driver-message',
                ...('sqlState' in diagnostic ? { meta: { code: diagnostic.sqlState, message: 'private-driver-message' } } : {}),
                stack: `${diagnostic.name}: private-driver-message\nSQL private-query\n    at privateFunction (${diagnostic.file}:250:18)\n    at privateFunction (https://private-host/source.js?private-token:1:2)` });
            if ('serialization' in diagnostic) return reply.serializer(() => { throw failure; }).send({ secret: 'private-response' });
            throw failure;
        });
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report?token=private-url',
                headers: { authorization: 'Bearer private-credential', 'user-agent': 'private-agent' },
                payload: { requestId: 'private-unvalidated-id', secret: 'private-input' } });
            expect(response.statusCode).toBe('statusCode' in diagnostic ? diagnostic.statusCode : 500);
            expect(response.json()).toMatchObject('statusCode' in diagnostic
                ? { error: 'database_connection_unavailable' } : { code: 'internal_error' });
            expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'fastify-error',
                httpRequestId: 'qb80-http-request', errorClass: diagnostic.errorClass,
                requestId: 'admit-own-action', actionId: 'session.attention.set',
                ...(diagnostic.prismaCode ? { prismaCode: diagnostic.prismaCode } : {}),
                ...('sqlState' in diagnostic ? { sqlState: diagnostic.sqlState } : {}),
                stackFrames: [{ file: diagnostic.file, line: 250, column: 18 }] })]));
            expect(JSON.stringify(records)).not.toContain('private-');
            expect(response.body).not.toContain('P2028');
        } finally { sink.mockRestore(); await app.close(); }
    });

    it.each(['P2021', 'P2022'])('reports %s as an actionable shared QA schema mismatch', async (code) => {
        const envSnapshot = snapshotEnv();
        applyEnvValues({ HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev-test' });
        const app = Fastify({ logger: false });
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(typed as Parameters<typeof enableErrorHandlers>[0]);
        typed.get('/shared-schema-query', {
            schema: { response: { 500: z.object({ error: z.literal('Internal Server Error') }) } },
        }, async () => {
            // The database is the boundary; the real HTTP handler receives its error unchanged.
            throw Object.assign(new Error('missing schema fixture'), { code });
        });
        try {
            const response = await app.inject({ method: 'GET', url: '/shared-schema-query' });
            expect(response.statusCode).toBe(500);
            expect(response.json()).toMatchObject({ error: 'shared_qa_schema_mismatch', statusCode: 500 });
            expect(response.json().message).toMatch(/QA snapshot.*current shared dev schema.*reload a newer snapshot/i);
        } finally {
            await app.close();
            restoreEnv(envSnapshot);
        }
    });

    it.each([
        { marker: undefined, code: 'P2021' },
        { marker: '   ', code: 'P2022' },
    ])('keeps an ordinary database failure opaque (%j)', async ({ marker, code }) => {
        const envSnapshot = snapshotEnv();
        applyEnvValues({ HAPPIER_STACK_SHARED_DB_SOURCE_STACK: marker });
        const app = Fastify({ logger: false });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.get('/ordinary-db-query', async () => {
            throw Object.assign(new Error('private database detail'), { code });
        });
        try {
            const response = await app.inject({ method: 'GET', url: '/ordinary-db-query' });
            expect(response.statusCode).toBe(500);
            expect(response.json()).toEqual({
                error: 'Internal Server Error',
                code: 'internal_error',
                message: 'An unexpected error occurred',
                statusCode: 500,
            });
        } finally {
            await app.close();
            restoreEnv(envSnapshot);
        }
    });

    it('reports database pool exhaustion as a safe typed unavailable response', async () => {
        const app = Fastify({ logger: false });
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(typed as Parameters<typeof enableErrorHandlers>[0]);
        typed.post('/v1/machines/managed/actions/list', {
            schema: { response: { 500: z.object({ error: z.literal('Internal Server Error') }) } },
        }, async () => {
            // Substitute only the database failure, retaining the real HTTP error owner.
            throw Object.assign(new Error('private connection string and SQL'), { code: 'P2024' });
        });
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_connection_unavailable', statusCode: 503 });
            expect(response.body).not.toContain('private');
        } finally {
            await app.close();
        }
    });

    it('keeps an effect-time Account lifecycle rejection opaque to an issued credential', async () => {
        const app = Fastify();
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.post('/effect-time-admission', async () => { throw new InactiveAccountError(); });
        try {
            const response = await app.inject({ method: 'POST', url: '/effect-time-admission' });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: 'invalid_token' });
        } finally {
            await app.close();
        }
    });

    it('responds 404 when UI index.html is missing (instead of 500)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-ui-missing-'));
        const app = Fastify();
        const envSnapshot = snapshotEnv();
        applyEnvValues({
            HAPPIER_SERVER_UI_DIR: dir,
            HAPPIER_SERVER_UI_PREFIX: '/',
        });

        try {
            enableErrorHandlers(app as any);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close().catch(() => {});
            restoreEnv(envSnapshot);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('does not serve the SPA shell for unknown versioned API routes', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-ui-api-404-'));
        const app = Fastify();
        const envSnapshot = snapshotEnv();
        applyEnvValues({
            HAPPIER_SERVER_UI_DIR: dir,
            HAPPIER_SERVER_UI_PREFIX: '/',
        });

        try {
            await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');
            enableErrorHandlers(app as any);
            await app.ready();

            for (const url of [
                '/v1/unknown-route',
                '/v2/connect/openai-codex/profiles/work/refresh-lease',
                '/v4/connect/qualified/group',
            ]) {
                const res = await app.inject({ method: 'GET', url });
                expect(res.statusCode).toBe(404);
                expect(res.headers['content-type']).toMatch(/application\/json/i);
                expect(res.body).toContain('Not found');
            }
        } finally {
            await app.close().catch(() => {});
            restoreEnv(envSnapshot);
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("bypasses route response serialization for generic 5xx error responses", async () => {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();

        enableErrorHandlers(typed as any);

        typed.get("/schema-narrow-boom", {
            schema: {
                response: {
                    200: z.object({ success: z.literal(true) }),
                    400: z.object({ error: z.literal("invalid-params") }),
                },
            },
        }, async () => {
            throw new Error("boom");
        });

        try {
            const res = await app.inject({ method: "GET", url: "/schema-narrow-boom" });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({
                error: "Internal Server Error",
                code: 'internal_error',
                message: "An unexpected error occurred",
                statusCode: 500,
            });
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("bypasses route response serialization when handling a response serialization error", async () => {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);

        enableErrorHandlers(app as any);

        app.get("/schema-bad-response", {
            schema: {
                response: {
                    400: z.object({ error: z.literal("invalid-params") }),
                },
            },
        }, async (_request, reply) => {
            return reply.code(400).send({ error: "wrong-error-contract" });
        });

        try {
            const res = await app.inject({ method: "GET", url: "/schema-bad-response" });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({
                error: "Internal Server Error",
                code: 'internal_error',
                message: "An unexpected error occurred",
                statusCode: 500,
            });
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("bypasses route response serialization for Fastify validation errors", async () => {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();

        enableErrorHandlers(typed as any);

        typed.post("/schema-validation-error", {
            schema: {
                body: z.strictObject({ value: z.string().check(z.minLength(1)) }),
                response: {
                    400: z.object({ error: z.literal("invalid-params") }),
                    200: z.object({ success: z.literal(true) }),
                },
            },
        }, async () => ({ success: true as const }));

        try {
            const res = await app.inject({
                method: "POST",
                url: "/schema-validation-error",
                headers: { "content-type": "application/json" },
                payload: { value: "" },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ error: "invalid-params" });
        } finally {
            await app.close().catch(() => {});
        }
    });
});
