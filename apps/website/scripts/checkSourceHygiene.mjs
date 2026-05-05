import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(websiteRoot, 'src');
const forbiddenPackageLockfiles = ['pnpm-lock.yaml', 'yarn.lock'];
const forbiddenGeneratedArtifacts = [
    'public/.DS_Store',
    'public/images/.DS_Store',
    'public/images/demo/.DS_Store',
    'public/casts/claude-patio.v3.bak.cast',
    'public/casts/codex-atlas.v3.bak.cast',
    'public/casts/opencode-prism.v3.bak.cast',
    'scripts/__pycache__',
];
const requiredPublicAssets = [
    'happier-release.pub',
    'install',
    'install.sh',
    'install.ps1',
    'install-preview',
    'install-preview.sh',
    'install-preview.ps1',
    'install-dev',
    'install-dev.sh',
    'install-dev.ps1',
    'install-server',
    'install-server.sh',
];

function collectJavaScriptShadows(directory) {
    const results = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectJavaScriptShadows(fullPath));
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const stem = fullPath.slice(0, -'.js'.length);
        if (fs.existsSync(`${stem}.ts`) || fs.existsSync(`${stem}.tsx`)) {
            results.push(path.relative(websiteRoot, fullPath));
        }
    }
    return results.sort();
}

function collectPublicAssetReferences(directory) {
    const results = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectPublicAssetReferences(fullPath));
            continue;
        }
        if (!entry.isFile() || !/\.(ts|tsx|js|jsx|css|mdx?)$/.test(entry.name)) continue;

        const source = fs.readFileSync(fullPath, 'utf8');
        for (const match of source.matchAll(/['"]\/((?:casts|images|videos)\/[^'"]+)['"]/g)) {
            results.push(match[1]);
        }
    }
    return [...new Set(results)].sort();
}

const shadows = collectJavaScriptShadows(sourceRoot);
const viteConfigShadow = fs.existsSync(path.join(websiteRoot, 'vite.config.js'));
const packageLockfiles = forbiddenPackageLockfiles.filter((fileName) =>
    fs.existsSync(path.join(websiteRoot, fileName)),
);
const generatedArtifacts = forbiddenGeneratedArtifacts.filter((artifactPath) =>
    fs.existsSync(path.join(websiteRoot, artifactPath)),
);
const missingPublicAssets = requiredPublicAssets.filter(
    (assetPath) => !fs.existsSync(path.join(websiteRoot, 'public', assetPath)),
);
const missingScenarioAssets = collectPublicAssetReferences(sourceRoot).filter(
    (assetPath) => !fs.existsSync(path.join(websiteRoot, 'public', assetPath)),
);

if (
    shadows.length > 0 ||
    viteConfigShadow ||
    packageLockfiles.length > 0 ||
    generatedArtifacts.length > 0 ||
    missingPublicAssets.length > 0 ||
    missingScenarioAssets.length > 0
) {
    for (const shadow of shadows) {
        console.error(`[website-source-hygiene] remove generated JS shadow: ${shadow}`);
    }
    if (viteConfigShadow) {
        console.error('[website-source-hygiene] remove generated JS shadow: vite.config.js');
    }
    for (const lockfile of packageLockfiles) {
        console.error(`[website-source-hygiene] remove package-local lockfile: ${lockfile}`);
    }
    for (const artifactPath of generatedArtifacts) {
        console.error(`[website-source-hygiene] remove generated artifact: ${artifactPath}`);
    }
    for (const assetPath of missingPublicAssets) {
        console.error(`[website-source-hygiene] restore public release asset: public/${assetPath}`);
    }
    for (const assetPath of missingScenarioAssets) {
        console.error(`[website-source-hygiene] restore or remove missing public asset reference: public/${assetPath}`);
    }
    process.exit(1);
}
