import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeLocalExtensionPackageFixture } from './localPackageFixture';

describe('localPackageFixture', () => {
    it('normalizes schemaVersion 1 manifests to schemaVersion 2 on disk', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-'));

        try {
            await writeLocalExtensionPackageFixture({
                pluginRoot,
                daemonModuleContents: [
                    'export async function recordHookInvocation() {',
                    '  return "ok";',
                    '}',
                    '',
                ].join('\n'),
                manifest: {
                    schemaVersion: 1,
                    id: 'acme.local.v1-input',
                    version: '1.0.0',
                    displayName: 'Acme Local V1 Input',
                    description: 'Legacy-shape input that must be written as V2',
                    engines: { happier: '^0.2.0' },
                    targets: { daemon: { entry: './daemon.mjs' } },
                    contributions: {
                        hooks: [
                            {
                                hookApiVersion: 1,
                                id: 'backend.terminalRuntime.bindTranscript',
                                category: 'integration',
                                scope: 'backend',
                                executionKind: 'integrate',
                                handler: {
                                    target: 'plugin',
                                    exportName: 'recordHookInvocation',
                                },
                            },
                        ],
                    },
                },
            });

            const onDisk = JSON.parse(
                await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
            ) as Record<string, unknown>;

            expect(onDisk.schemaVersion).toBe(2);
            expect(onDisk.runtime).toEqual(
                expect.objectContaining({
                    apiVersion: 1,
                }),
            );
            expect(onDisk.contributions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: 'hook',
                        id: 'backend.terminalRuntime.bindTranscript',
                    }),
                ]),
            );
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
