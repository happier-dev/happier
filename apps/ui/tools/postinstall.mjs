import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import url from 'node:url';
import { resolveUiPostinstallTasks } from './resolveUiPostinstallTasks.mjs';
import { ensureNohoistPeerLinks } from './ensureNohoistPeerLinks.mjs';
import { runCommandBestEffort, runCommandOrExit } from './postinstall/runCommand.mjs';

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

const tasks = resolveUiPostinstallTasks({ env: process.env });
const wants = (id) => tasks.includes(id);

function listPatchFiles(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function resolvePatchTargetPackageName(patchFileName) {
    const raw = patchFileName.endsWith('.patch') ? patchFileName.slice(0, -'.patch'.length) : patchFileName;
    const parts = raw.split('+').filter(Boolean);
    if (parts.length < 2) return '';
    if (parts[0].startsWith('@')) {
        if (parts.length < 3) return '';
        return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
}

function packageExists(nodeModulesDir, packageName) {
    if (!nodeModulesDir || !packageName) return false;
    return fs.existsSync(path.resolve(nodeModulesDir, packageName));
}

function createFilteredPatchDir({ patchDir: inputPatchDir, nodeModulesDir, label }) {
    const patchFiles = listPatchFiles(inputPatchDir);
    if (patchFiles.length === 0) return '';

    const selected = patchFiles.filter((fileName) => {
        const pkgName = resolvePatchTargetPackageName(fileName);
        return packageExists(nodeModulesDir, pkgName);
    });

    if (selected.length === 0) return '';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `happier-ui-patches-${label}-`));
    for (const fileName of selected) {
        fs.copyFileSync(path.resolve(inputPatchDir, fileName), path.resolve(tmpDir, fileName));
    }
    return tmpDir;
}

if (wants('patch-package')) {
    // Note: this repo uses Yarn workspaces, so some dependencies are hoisted to the repo root.
    // patch-package only patches packages present in the current working directory's
    // node_modules, so we run it from the repo root but keep patch files in expo-app/patches.
    if (fs.existsSync(repoRootNodeModulesDir)) {
        const filteredPatchDir = createFilteredPatchDir({ patchDir, nodeModulesDir: repoRootNodeModulesDir, label: 'root' });
        if (filteredPatchDir) {
            runCommandOrExit({
                command: process.execPath,
                args: [patchPackageCliPath, '--patch-dir', path.relative(repoRootDir, filteredPatchDir)],
                options: { cwd: repoRootDir },
            });
        }
    }

    // Some dependencies are not hoisted (e.g. expo-router) and are installed under expo-app/node_modules.
    // Run patch-package again scoped to expo-app to apply those patches.
    if (fs.existsSync(expoAppNodeModulesDir)) {
        const filteredPatchDir = createFilteredPatchDir({ patchDir, nodeModulesDir: expoAppNodeModulesDir, label: 'ui' });
        if (filteredPatchDir) {
            runCommandOrExit({
                command: process.execPath,
                args: [patchPackageCliPath, '--patch-dir', path.relative(expoAppDir, filteredPatchDir)],
                options: { cwd: expoAppDir },
            });
        }
    }
}

if (wants('verify-react-native-enriched-markdown-web-streaming-patch')) {
    const packageDirs = [
        path.resolve(repoRootNodeModulesDir, 'react-native-enriched-markdown'),
        path.resolve(expoAppNodeModulesDir, 'react-native-enriched-markdown'),
    ].filter((packageDir) => fs.existsSync(packageDir));

    if (packageDirs.length === 0) {
        console.error('Could not find react-native-enriched-markdown under repo or UI node_modules.');
        process.exit(1);
    }

    const unpatchedPaths = [];
    for (const packageDir of packageDirs) {
        const enrichedMarkdownTextPath = path.resolve(packageDir, 'lib', 'module', 'web', 'EnrichedMarkdownText.js');
        const streamingRevealPath = path.resolve(packageDir, 'lib', 'module', 'web', 'streamingReveal.js');
        const parseMarkdownPath = path.resolve(packageDir, 'lib', 'module', 'web', 'parseMarkdown.js');
        const iosTailFadeAnimatorPath = path.resolve(packageDir, 'ios', 'utils', 'ENRMTailFadeInAnimator.m');
        const androidTailFadeAnimatorPath = path.resolve(packageDir, 'android', 'src', 'main', 'java', 'com', 'swmansion', 'enriched', 'markdown', 'utils', 'text', 'TailFadeInAnimator.kt');

        if (
            !fs.existsSync(enrichedMarkdownTextPath)
            || !fs.existsSync(streamingRevealPath)
            || !fs.existsSync(parseMarkdownPath)
            || !fs.existsSync(iosTailFadeAnimatorPath)
            || !fs.existsSync(androidTailFadeAnimatorPath)
        ) {
            unpatchedPaths.push(packageDir);
            continue;
        }

        const enrichedMarkdownTextContents = fs.readFileSync(enrichedMarkdownTextPath, 'utf8');
        const streamingRevealContents = fs.readFileSync(streamingRevealPath, 'utf8');
        const parseMarkdownContents = fs.readFileSync(parseMarkdownPath, 'utf8');
        const iosTailFadeAnimatorContents = fs.readFileSync(iosTailFadeAnimatorPath, 'utf8');
        const androidTailFadeAnimatorContents = fs.readFileSync(androidTailFadeAnimatorPath, 'utf8');
        if (
            !enrichedMarkdownTextContents.includes('markStreamingRevealOffsets')
            || !enrichedMarkdownTextContents.includes('streamingAnimation')
            || !enrichedMarkdownTextContents.includes('updateStreamingRevealRanges')
            || !parseMarkdownContents.includes('preloadMarkdownRuntime')
            || !streamingRevealContents.includes('data-happier-enriched-markdown-reveal')
            || !streamingRevealContents.includes('updateStreamingRevealRanges')
            || !iosTailFadeAnimatorContents.includes('ENRMActiveFadeRange')
            || !androidTailFadeAnimatorContents.includes('activeRanges')
        ) {
            unpatchedPaths.push(packageDir);
        }
    }

    if (unpatchedPaths.length > 0) {
        console.error(
            `react-native-enriched-markdown web streaming patch does not appear to be applied to:\n${unpatchedPaths
                .map((p) => `- ${p}`)
                .join('\n')}`,
        );
        process.exit(1);
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
    runCommandOrExit({ command: 'npx', args: ['setup-skia-web', 'public'], options: { cwd: expoAppDir } });
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

// Vendor Pierre diffs worker assets for web/desktop. Metro can't reliably resolve worker-module URLs for ESM workers,
// so we copy Pierre's "portable worker" bundle into `public/` and load it via `new Worker(url, { type: 'module' })`.
if (wants('vendor-pierre-diffs-worker')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'diffs', 'buildPierreWorker.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: Pierre diffs have a runtime fallback when workers cannot be created.
    }
}

// Bundle CodeMirror for the native CodeMirror WebView editor. We embed the resulting bundle as a JS string to avoid
// runtime CDN imports (offline + deterministic). Kept best-effort: the editor has a runtime CDN fallback when empty.
if (wants('vendor-codemirror-webview-bundle')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'codemirror', 'buildCodeMirrorWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: CodeMirror editor has a runtime fallback when the embedded bundle is missing.
    }
}

// Bundle Xterm for the native terminal WebView. We embed the resulting bundle as a JS string to avoid
// runtime CDN imports (offline + deterministic). Kept best-effort: the terminal can still render an
// error state when the embedded bundle is missing.
if (wants('vendor-xterm-webview-bundle')) {
    try {
        runCommandBestEffort({
            command: process.execPath,
            args: [path.resolve(expoAppDir, 'tools', 'xterm', 'buildXtermWebViewBundle.mjs')],
            options: { cwd: expoAppDir },
        });
    } catch (e) {
        // Best-effort: Xterm is optional and should not break installs.
    }
}
