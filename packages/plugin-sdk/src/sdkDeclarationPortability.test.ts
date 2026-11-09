import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, expect, it } from 'vitest';

import { runBoundedFixtureCommand } from './test-support/boundedFixtureCommand.js';
import { disposeSourceAuthoringDeclarations, sourceAuthoringDeclarationPackageRoot } from './test-support/protocolAuthoringDeclarations.js';

afterAll(disposeSourceAuthoringDeclarations);

it('emits an SDK-only plugin declaration without naming transitive Protocol packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-sdk-declaration-'));
    const compiler = fileURLToPath(new URL('../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url));
    try {
        const sdkRoot = await sourceAuthoringDeclarationPackageRoot();
        await mkdir(join(root, 'node_modules', '@happier-dev'), { recursive: true });
        await symlink(sdkRoot, join(root, 'node_modules', '@happier-dev', 'plugin-sdk'), 'junction');
        await writeFile(join(root, 'package.json'), JSON.stringify({
            name: 'sdk-only-declaration-consumer', type: 'module',
            dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        }));
        await writeFile(join(root, 'index.ts'), `
            import { definePlugin, HealthCheckResultV1ProtocolSchema,
                HealthCheckSubjectV1ProtocolSchema } from '@happier-dev/plugin-sdk';
            import {
                defineProtocolArray, defineProtocolJsonValue, defineProtocolObject,
                defineProtocolString,
            } from '@happier-dev/plugin-sdk/protocol';

            export const schema = defineProtocolObject({
                id: defineProtocolString(),
                values: defineProtocolArray(defineProtocolJsonValue()),
                subject: HealthCheckSubjectV1ProtocolSchema,
                result: HealthCheckResultV1ProtocolSchema,
            }, { policy: 'additive-open/preserve' });
            export const jsonSchema = schema.jsonSchema;
            export const parsed = schema.safeParse({});
            export const validationError = parsed.success ? undefined : parsed.error;
            export const plugin = definePlugin({
                id: 'example.portability', version: '1.0.0', displayName: 'Portability',
                actions: { untyped: {
                    title: 'Untyped', execution: { target: 'daemon' },
                    run(input) { return input; },
                }, echo: {
                    title: 'Echo', execution: { target: 'daemon' },
                    inputSchema: schema, resultSchema: schema,
                    run(input) { return input; },
                } },
            });
        `);
        await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                strict: true, declaration: true, emitDeclarationOnly: true,
                skipLibCheck: true, target: 'ES2022', module: 'NodeNext',
                moduleResolution: 'NodeNext', types: [], outDir: './dist',
            }, files: ['./index.ts'],
        }));
        await runBoundedFixtureCommand('SDK-only plugin declaration emit', root,
            [compiler, '--project', join(root, 'tsconfig.json')]);
        const declaration = await readFile(join(root, 'dist', 'index.d.ts'), 'utf8');
        expect(declaration).toContain('@happier-dev/plugin-sdk');
        expect(declaration).not.toMatch(/@happier-dev\/protocol|node_modules|protocolFacade/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 120_000);
