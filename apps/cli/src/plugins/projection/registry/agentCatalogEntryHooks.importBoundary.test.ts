import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('agentCatalogEntryHooks import boundaries', () => {
    it('does not reach the Protocol root while loading the generated bundled registry', async () => {
        const entrypoint = fileURLToPath(new URL('./sources/generatedBundledPlugins.ts', import.meta.url));
        const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
        const result = await new Promise<Readonly<{ code: number | null; protocolRootTrace: string }>>((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '--eval',
                    `await import(${JSON.stringify(pathToFileURL(entrypoint).href)});`,
                ],
                {
                cwd: repositoryRoot,
                env: {
                    ...process.env,
                    NODE_DEBUG: 'esm',
                    TSX_TSCONFIG_PATH: 'apps/cli/tsconfig.json',
                },
                },
            );
            let protocolRootTrace = '';
            let stderrTail = '';
            child.stderr.on('data', (chunk: Buffer) => {
                const text = `${stderrTail}${chunk.toString('utf8')}`;
                for (const match of text.matchAll(/@happier-dev\/protocol(?=['",\s])/gu)) {
                    if (protocolRootTrace.length >= 4_096) break;
                    const index = match.index ?? 0;
                    protocolRootTrace += `${text.slice(Math.max(0, index - 160), index + match[0].length + 160)}\n`;
                }
                stderrTail = text.slice(-64);
            });
            child.once('error', reject);
            child.once('close', (code) => resolve({ code, protocolRootTrace }));
        });

        expect(result.code).toBe(0);
        expect(result.protocolRootTrace).toBe('');
    });

    it('does not import global daemon/session reachability while projecting provider hooks', async () => {
        const source = await readFile(new URL('./agentCatalogEntryHooks.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/from ['"]@\/daemon\/connectedServices\/stateSharing\/canResumeFromMaterializedState['"]/);
        expect(source).not.toMatch(/from ['"]@\/session\/runtime\/control\/reachability['"]/);
        expect(source).not.toMatch(/from ['"]@\/agent\/acp\/runtime\/definition['"]/);
    });

});
