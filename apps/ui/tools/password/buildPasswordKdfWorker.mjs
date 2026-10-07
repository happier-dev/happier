import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same source producer is used for development, web and Tauri's static assets. */
export async function buildPasswordKdfWorker({ outputFile = resolve(uiDir, 'public/happier-password-kdf-worker.js') } = {}) {
    const result = await build({
        entryPoints: [resolve(uiDir, 'sources/auth/password/passwordKdf.worker.ts')],
        // Postinstall precedes workspace dist on a cold/scriptless checkout.
        // Compile the canonical codec source, not a missing or stale dist copy.
        alias: {
            '@happier-dev/protocol/auth/accountPasswordCredential':
                resolve(uiDir, '../../packages/protocol/src/auth/accountPasswordCredential.ts'),
        },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: ['es2020'],
        minify: true,
        write: false,
    });
    const contents = result.outputFiles[0].text;
    const previous = await readFile(outputFile, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (previous !== contents) {
        await mkdir(dirname(outputFile), { recursive: true });
        await writeFile(outputFile, contents);
    }
    return { outputFile, bytes: result.outputFiles[0].contents.byteLength };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await buildPasswordKdfWorker();
}
