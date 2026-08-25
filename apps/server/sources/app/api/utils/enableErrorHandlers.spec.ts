import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from "zod";
import { applyEnvValues, snapshotEnv, restoreEnv } from "../testkit/env";
import { enableErrorHandlers } from './enableErrorHandlers';

describe('enableErrorHandlers', () => {
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
                body: z.object({ value: z.string().min(1) }).strict(),
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
