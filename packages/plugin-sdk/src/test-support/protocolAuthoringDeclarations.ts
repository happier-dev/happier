import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedFixtureCommand } from './boundedFixtureCommand.js';
import { createDistTypeScriptProjectConfig } from '../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const compilerRunner = fileURLToPath(new URL('../../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url));
let prepared: Promise<string> | undefined;

/** Fresh source declarations, never the old TS5 checker or stale published dist. */
async function declarationRoot(): Promise<string> {
    return prepared ??= (async () => {
        const root = await mkdtemp(join(packageRoot, '.tmp.protocol-authoring-'));
        const config = join(root, 'tsconfig.producer.json');
        await writeFile(config, JSON.stringify(createDistTypeScriptProjectConfig({
            projectPath: join(packageRoot, 'tsconfig.json'),
            // Match dependency declaration preparation; consumers below perform
            // semantic checking, and the package build owns SDK diagnostics.
            compilerOptions: { incremental: false, declarationMap: false, noCheck: true,
                emitDeclarationOnly: true, outDir: join(root, 'dist') },
        })));
        try {
            await runBoundedFixtureCommand('Protocol authoring source declarations', packageRoot, [compilerRunner, '-p', config]);
            return root;
        } catch (error) {
            await rm(root, { recursive: true, force: true });
            throw error;
        }
    })();
}

export async function emittedSourceAuthoringDeclaration(path: string): Promise<string> {
    return readFile(join(await declarationRoot(), 'dist', path), 'utf8');
}

/** Package identity for SDK-only consumers of the freshly emitted source. */
export async function sourceAuthoringDeclarationPackageRoot(): Promise<string> {
    const root = await declarationRoot();
    await writeFile(join(root, 'package.json'), await readFile(join(packageRoot, 'package.json')));
    return root;
}

export async function compileExternalProtocolAuthoringConsumer(source: string, name: string,
    options: Readonly<{ types?: readonly string[] }> = {}): Promise<void> {
    const root = await declarationRoot();
    const consumer = join(root, 'dist', `${name}.ts`);
    await mkdir(dirname(consumer), { recursive: true });
    await writeFile(consumer, source);
    const config = join(root, `tsconfig.${name}.json`);
    await writeFile(config, JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: false,
            target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            lib: ['ES2022', 'DOM'], types: options.types ?? [] },
        files: [consumer],
    }));
    await runBoundedFixtureCommand('External Protocol authoring declaration consumer', packageRoot, [compilerRunner, '-p', config]);
}

export async function disposeSourceAuthoringDeclarations(): Promise<void> {
    if (prepared) {
        const root = await prepared.catch(() => undefined);
        if (root) await rm(root, { recursive: true, force: true });
        prepared = undefined;
    }
}
