import { build } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Absolute source files an esbuild result consumed (its metafile inputs). */
export function readBuildInputPaths(...results) {
    return [...new Set(results.flatMap(result => Object.keys(result.metafile?.inputs ?? {})))]
        .filter(path => !path.startsWith('<') && !/^[a-z-]+:/.test(path)).map(path => resolve(path)).sort();
}

/** Source compilation owns its last-green files, independently of installation. */
export async function buildUiSourceAsset({ outputs, retainLastGreen = false, build }) {
    try {
        return await build();
    } catch (error) {
        // OS and publication failures are not source drift.
        if (!retainLastGreen || !Array.isArray(error?.errors) || error.errors.length === 0
            || /EACCES|EPERM|ENOSPC|permission denied/i.test(error.message)) throw error;
        const files = await Promise.all(outputs.map(file => stat(file).catch(failure => {
            if (failure.code === 'ENOENT') return null;
            throw failure;
        })));
        if (!files.every(file => file?.isFile() && file.size > 0)) throw error;
        console.warn(`[ui] source asset refresh failed; retained last-green ${outputs.join(', ')}. ${error.message}`);
        return { retained: true };
    }
}

/** Public workers work in both split and single-bundle Expo, web and Tauri. */
export async function buildUiSourceWorker({ entryPoint, outputFile, alias, retainLastGreen = false }) {
    const built = await buildUiSourceAsset({ outputs: [outputFile], retainLastGreen, build: async () => {
        const result = await build({ entryPoints: [entryPoint], alias, metafile: true,
            bundle: true, platform: 'browser', format: 'iife', target: ['es2020'], minify: true, write: false });
        const contents = result.outputFiles[0].text;
        const previous = await readFile(outputFile, 'utf8').catch(error => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (previous !== contents) {
            await mkdir(dirname(outputFile), { recursive: true });
            await writeFile(outputFile, contents);
        }
        return { outputFile, bytes: result.outputFiles[0].contents.byteLength, inputPaths: readBuildInputPaths(result) };
    } });
    return { outputFile, ...built };
}
