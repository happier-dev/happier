import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';
import { ensureNohoistPeerLinks } from './ensureNohoistPeerLinks.mjs';

// Yarn workspaces can execute this script via a symlinked path (e.g. repoRoot/node_modules/happy/...).
// Resolve symlinks so repoRootDir/expoAppDir are computed from the real filesystem location.
const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
const expoAppDir = path.resolve(toolsDir, '..');

function findRepoRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        if (
            fs.existsSync(path.resolve(dir, 'package.json')) &&
            fs.existsSync(path.resolve(dir, 'yarn.lock'))
        ) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: historic layout had the app at repoRoot/expo-app.
    return path.resolve(startDir, '..');
}

const repoRootDir = findRepoRoot(expoAppDir);
const patchDir = path.resolve(expoAppDir, 'patches');
const patchDirFromRepoRoot = path.relative(repoRootDir, patchDir);
const patchDirFromExpoApp = path.relative(expoAppDir, patchDir);
const repoRootNodeModulesDir = path.resolve(repoRootDir, 'node_modules');
const expoAppNodeModulesDir = path.resolve(expoAppDir, 'node_modules');

try {
    ensureNohoistPeerLinks({ repoRootDir, expoAppDir });
} catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
}

const patchPackageCliCandidatePaths = [
    path.resolve(expoAppDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
    path.resolve(repoRootDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
];

const patchPackageCliPath = patchPackageCliCandidatePaths.find((candidatePath) =>
    fs.existsSync(candidatePath),
);

if (!patchPackageCliPath) {
    console.error(
        `Could not find patch-package CLI at:\n${patchPackageCliCandidatePaths
            .map((p) => `- ${p}`)
            .join('\n')}`,
    );
    process.exit(1);
}

function run(command, args, options) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

const tasks = resolveUiPostinstallTasks({ env: process.env });
const wants = (id) => tasks.includes(id);

if (wants('patch-package')) {
    // Note: this repo uses Yarn workspaces, so some dependencies are hoisted to the repo root.
    // patch-package only patches packages present in the current working directory's
    // node_modules, so we run it from the repo root but keep patch files in expo-app/patches.
    if (fs.existsSync(repoRootNodeModulesDir)) {
        run(process.execPath, [patchPackageCliPath, '--patch-dir', patchDirFromRepoRoot], {
            cwd: repoRootDir,
        });
    }

    // Some dependencies are not hoisted (e.g. expo-router) and are installed under expo-app/node_modules.
    // Run patch-package again scoped to expo-app to apply those patches.
    if (fs.existsSync(expoAppNodeModulesDir)) {
        run(process.execPath, [patchPackageCliPath, '--patch-dir', patchDirFromExpoApp], {
            cwd: expoAppDir,
        });
    }
}

if (wants('verify-expo-router-web-modal-patch')) {
    const expoRouterWebModalCandidatePaths = [
        path.resolve(repoRootDir, 'node_modules', 'expo-router', 'build', 'layouts', '_web-modal.js'),
        path.resolve(expoAppDir, 'node_modules', 'expo-router', 'build', 'layouts', '_web-modal.js'),
    ];

    const existingExpoRouterWebModalPaths = expoRouterWebModalCandidatePaths.filter((candidatePath) =>
        fs.existsSync(candidatePath),
    );

    if (existingExpoRouterWebModalPaths.length === 0) {
        console.error(
            `Could not find expo-router _web-modal.js at:\n${expoRouterWebModalCandidatePaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }

    const unpatchedPaths = [];
    for (const filePath of existingExpoRouterWebModalPaths) {
        const contents = fs.readFileSync(filePath, 'utf8');
        if (!contents.includes('ExperimentalModalStack')) {
            unpatchedPaths.push(filePath);
        }
    }

    if (unpatchedPaths.length > 0) {
        console.error(
            `expo-router web modals patch does not appear to be applied to:\n${unpatchedPaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
    }
}

if (wants('setup-skia-web')) {
    run('npx', ['setup-skia-web', 'public'], { cwd: expoAppDir });
}

// Vendor Monaco static assets for web/desktop code editor. Metro can't bundle Monaco workers reliably, so we serve
// the minified `vs/` directory as static files and load via AMD loader at runtime.
if (wants('vendor-monaco')) {
    try {
        const monacoCandidateDirs = [
            path.resolve(expoAppDir, 'node_modules', 'monaco-editor'),
            path.resolve(repoRootDir, 'node_modules', 'monaco-editor'),
        ];
        const monacoDir = monacoCandidateDirs.find((p) => fs.existsSync(p));
        if (monacoDir) {
            const src = path.resolve(monacoDir, 'min', 'vs');
            const dst = path.resolve(expoAppDir, 'public', 'monaco', 'vs');
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.cpSync(src, dst, { recursive: true, force: true });
            }
        }
    } catch (e) {
        // Best-effort: Monaco is an experimental feature and should not break installs.
    }
}

// Vendor Kokoro JS runtime for web. Metro can't bundle kokoro-js reliably (it contains `import.meta` and other
// ESM-only patterns), so we load it as a separate ESM module from `public/` at runtime.
if (wants('vendor-kokoro-web')) {
    try {
        const kokoroCandidateDirs = [
            path.resolve(expoAppDir, 'node_modules', 'kokoro-js'),
            path.resolve(repoRootDir, 'node_modules', 'kokoro-js'),
        ];
        const kokoroDir = kokoroCandidateDirs.find((p) => fs.existsSync(p));
        if (kokoroDir) {
            const src = path.resolve(kokoroDir, 'dist', 'kokoro.web.js');
            const dst = path.resolve(expoAppDir, 'public', 'vendor', 'kokoro', 'kokoro.web.js');
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.cpSync(src, dst, { force: true });
            }
        }

        const ortCandidateDirs = [
            path.resolve(expoAppDir, 'node_modules', 'onnxruntime-web', 'dist'),
            path.resolve(repoRootDir, 'node_modules', 'onnxruntime-web', 'dist'),
        ];
        const ortDistDir = ortCandidateDirs.find((p) => fs.existsSync(p));
        if (ortDistDir) {
            const dstDir = path.resolve(expoAppDir, 'public', 'vendor', 'kokoro', 'onnxruntime-web');
            fs.mkdirSync(dstDir, { recursive: true });
            const files = [
                'ort-wasm-simd-threaded.jsep.mjs',
                'ort-wasm-simd-threaded.jsep.wasm',
                'ort-wasm-simd-threaded.mjs',
                'ort-wasm-simd-threaded.wasm',
            ];
            for (const fileName of files) {
                const src = path.resolve(ortDistDir, fileName);
                const dst = path.resolve(dstDir, fileName);
                if (fs.existsSync(src)) {
                    fs.cpSync(src, dst, { force: true });
                }
            }
        }
    } catch (e) {
        // Best-effort: Kokoro GS is optional and should not break installs.
    }
}
