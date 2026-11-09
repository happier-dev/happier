import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { fixtureCommandTimeoutMs, runBoundedFixtureCommand } from './test-support/boundedFixtureCommand.js';
import { copyBuiltSdkArtifact, linkBuiltRuntimeDependencyClosure } from './test-support/sdkArtifactFixture.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const compilerRunner = fileURLToPath(new URL('../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url));

it('resolves every public declaration entry through the SDK bundled closure in external consumers', async () => {
    const manifest: { exports: Record<string, unknown> } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const entries = Object.entries(manifest.exports).filter(([, value]) => (
        value !== null && typeof value === 'object' && 'types' in value
    )).map(([entry]) => entry === '.' ? '@happier-dev/plugin-sdk' : `@happier-dev/plugin-sdk/${entry.slice(2)}`);
    expect(entries).toContain('@happier-dev/plugin-sdk/protocol');
    expect(entries).toContain('@happier-dev/plugin-sdk/scm');
    const root = await mkdtemp(join(tmpdir(), 'happier-sdk-public-declarations-'));
    try {
        await copyBuiltSdkArtifact(join(root, 'node_modules/@happier-dev/plugin-sdk'));
        await linkBuiltRuntimeDependencyClosure(root, packageRoot);
        // This corpus includes daemon/Node entries as well as browser entries.
        // Supply their real host ambient types, not ambient stubs or skipLibCheck.
        // Private Protocol/Agents dependencies live only below the SDK, as in
        // the existing physical-copy fixture. The author cannot import them.
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
        await writeFile(join(root, 'src/consumer.ts'), entries.map((entry, index) => (
            `import type * as Entry${index} from '${entry}';\nexport type PublicEntry${index} = typeof Entry${index};`
        )).join('\n'));
        for (const mode of ['Node16', 'Bundler'] as const) {
            const config = join(root, `tsconfig.${mode}.json`);
            await writeFile(config, JSON.stringify({
                compilerOptions: {
                    target: 'ES2022', module: mode === 'Bundler' ? 'ESNext' : 'Node16',
                    moduleResolution: mode, strict: true, skipLibCheck: false,
                    declaration: true, emitDeclarationOnly: true,
                    rootDir: './src', outDir: `./declarations-${mode}`, lib: ['ES2022', 'DOM'], types: ['node'],
                }, files: ['./src/consumer.ts'],
            }));
            await runBoundedFixtureCommand(`All public SDK declarations (${mode})`, root, [compilerRunner, '-p', config]);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, fixtureCommandTimeoutMs * 2 + 5_000);
