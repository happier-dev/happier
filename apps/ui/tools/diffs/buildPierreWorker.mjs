import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readUtf8(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function stripSourceMapComment(contents) {
    return contents.replace(/\n?\/\/# sourceMappingURL=.*?\n?$/m, '\n');
}

function writeIfChanged(filePath, contents) {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (existing === contents) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
    return true;
}

function copyFile(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { force: true });
}

function resolveWorkerDistDir({ repoRootDir, expoAppDir }) {
    const candidates = [
        path.resolve(expoAppDir, 'node_modules', '@pierre', 'diffs', 'dist', 'worker'),
        path.resolve(repoRootDir, 'node_modules', '@pierre', 'diffs', 'dist', 'worker'),
    ];
    return candidates.find((p) => fs.existsSync(path.resolve(p, 'worker-portable.js'))) ?? null;
}

export function buildPierreWorkerAssets({ repoRootDir, expoAppDir }) {
    const workerDistDir = resolveWorkerDistDir({ repoRootDir, expoAppDir });
    if (!workerDistDir) {
        throw new Error('Pierre worker dist directory not found (expected worker-portable.js).');
    }

    const portableWorkerPath = path.resolve(workerDistDir, 'worker-portable.js');
    const rawWorker = readUtf8(portableWorkerPath);

    const wasmImportMatch = rawWorker.match(/import\(\s*["']\.\/(wasm-[^"']+\.js)["']\s*\)/);
    if (!wasmImportMatch) {
        throw new Error('Could not find wasm import in pierre worker-portable.js');
    }
    const wasmSourceFileName = wasmImportMatch[1];
    const wasmSourcePath = path.resolve(workerDistDir, wasmSourceFileName);
    if (!fs.existsSync(wasmSourcePath)) {
        throw new Error(`Pierre wasm helper not found at ${wasmSourcePath}`);
    }

    const outWorkerPath = path.resolve(expoAppDir, 'public', 'pierre-diff-worker.js');
    const outWasmPath = path.resolve(expoAppDir, 'public', 'pierre-diff-worker-wasm.js');

    const rewrittenWorker = stripSourceMapComment(rawWorker).replace(
        wasmImportMatch[0],
        'import("./pierre-diff-worker-wasm.js")',
    );

    const wroteWorker = writeIfChanged(outWorkerPath, rewrittenWorker);
    copyFile(wasmSourcePath, outWasmPath);

    return {
        workerDistDir,
        wasmSourceFileName,
        wroteWorker,
        outWorkerPath,
        outWasmPath,
    };
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
    const expoAppDir = path.resolve(toolsDir, '..', '..');

    function findRepoRoot(startDir) {
        let dir = startDir;
        for (let i = 0; i < 8; i++) {
            if (fs.existsSync(path.resolve(dir, 'package.json')) && fs.existsSync(path.resolve(dir, 'yarn.lock'))) {
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return path.resolve(startDir, '..');
    }

    const repoRootDir = findRepoRoot(expoAppDir);
    const result = buildPierreWorkerAssets({ repoRootDir, expoAppDir });
    // eslint-disable-next-line no-console
    console.log(`[pierre] worker assets ready: ${path.relative(expoAppDir, result.outWorkerPath)}`);
}
