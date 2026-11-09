import fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { symlink } from 'node:fs/promises';
import { createWorkspaceSourceResolver, readWorkspacePackages, SOURCE_CONDITION } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';

import { registerApiRoutes } from './api';
import type { Fastify } from './types';
import { enableSchemaValidation } from './utils/enableSchemaValidation';
import { resolveApiRateLimitPluginOptions } from './utils/apiRateLimitPolicy';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerAuthEmailApplicationLinkTarget } from '@/app/auth/email/resolveAuthEmailDelivery';

describe('API startup', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-api-boot-', initAuth: true, initEncrypt: true });
    }, 120_000);
    afterAll(async () => {
        registerAuthEmailApplicationLinkTarget(null);
        if (harness) await harness.close();
    });
    it('readies every production route with its response schemas available', async () => {
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        await app.register(fastifyRateLimit, resolveApiRateLimitPluginOptions(process.env));
        app.decorate('authenticate', async () => {});
        enableSchemaValidation(app);
        app.addHook('onRoute', route => {
            for (const [status, schema] of Object.entries(route.schema?.response ?? {})) {
                expect(schema, `${route.method} ${route.url} response ${status}`).toBeDefined();
            }
        });
        try {
            registerApiRoutes(app as unknown as Fastify);
            await app.ready();
        } finally {
            await app.close();
        }
    });

    it('readies the native source bundle through the startup import graph', async () => {
        const projectDir = fileURLToPath(new URL('../../../', import.meta.url));
        const repoDir = resolve(projectDir, '../..');
        const outdir = join(harness.baseDir, 'bundle');
        await symlink(join(repoDir, 'node_modules'), join(harness.baseDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        await build({
            absWorkingDir: projectDir, outdir, bundle: true, splitting: true,
            platform: 'node', format: 'esm', target: 'node20',
            outExtension: { '.js': '.mjs' }, conditions: [SOURCE_CONDITION],
            tsconfig: join(projectDir, 'tsconfig.json'), logLevel: 'silent',
            // Match the source runtime's generated-client boundary: Prisma's
            // native support stays at its existing package-owned location.
            plugins: [{ name: 'server-generated-clients', setup(builder) {
                builder.onResolve({ filter: /generated\/(?:sqlite|mysql)-client/ }, args => ({
                    path: pathToFileURL(resolve(args.resolveDir, args.path)).href, external: true,
                }));
            } }, createWorkspaceSourceResolver({
                workspacePackages: await readWorkspacePackages(repoDir),
                requireFromProject: createRequire(join(projectDir, 'package.json')),
            })],
            stdin: { resolveDir: projectDir, sourcefile: 'api-boot-probe.ts', loader: 'ts', contents: `
                import './sources/configureZodLocale';
                import { runLightServerMain } from './sources/flavors/light/main';
                import fastify from 'fastify';
                import rateLimit from '@fastify/rate-limit';
                await runLightServerMain(['--probe-runtime-import']);
                const { registerApiRoutes } = await import('./sources/app/api/api');
                const { enableSchemaValidation } = await import('./sources/app/api/utils/enableSchemaValidation');
                const { resolveApiRateLimitPluginOptions } = await import('./sources/app/api/utils/apiRateLimitPolicy');
                const { initDbSqlite, shutdownDbClient } = await import('./sources/storage/db');
                await initDbSqlite();
                const app = fastify({ logger: false });
                app.decorate('authenticate', async () => {});
                enableSchemaValidation(app);
                app.addHook('onRoute', route => {
                    for (const [status, schema] of Object.entries(route.schema?.response ?? {})) {
                        if (schema === undefined) throw new Error(route.method + ' ' + route.url + ' response ' + status + ' is undefined');
                    }
                });
                try {
                    await app.register(rateLimit, resolveApiRateLimitPluginOptions(process.env));
                    registerApiRoutes(app);
                    await app.ready();
                } finally {
                    await app.close();
                    await shutdownDbClient();
                }
            ` },
        });
        const probe = spawnSync(process.execPath, [join(outdir, 'stdin.mjs')], {
            cwd: projectDir, env: process.env, encoding: 'utf8',
        });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr || probe.stdout).toBe(0);
    });
});
