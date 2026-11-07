import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInputIdentity } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspacePackages } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { readSourcePluginUiBuildInputs, readWorkspaceBuildInputs } from '../../stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { readJsonIfExists } from '../../stack/scripts/utils/fs/json.mjs';
import { dependencyInputsIdentity, resolveDependencyRefreshMarkerPath } from '../../stack/scripts/utils/proc/dependency_refresh.mjs';
import { SOURCE_UI_ASSET_OUTPUT_PATHS, SOURCE_UI_ASSET_RECORD_FILENAME } from './sourceUiAssetPaths.mjs';

export function resolveSourceUiAssetsRecordPath(inventoryPath) {
    return resolve(dirname(inventoryPath), SOURCE_UI_ASSET_RECORD_FILENAME);
}

export function readSourceUiAssetsRecord(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function writeChanged(path, contents) {
    const current = await readFile(path, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    if (current === contents) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, path);
}

/** Publish references only after the containing owner admits their asset files. */
export async function publishSourceUiAssets({ recordPath, outputPath = recordPath }) {
    const prepared = readSourceUiAssetsRecord(recordPath);
    if (!prepared) throw new Error(`Missing prepared UI assets: ${recordPath}`);
    for (const { candidatePath, outputPath: publicationPath } of prepared.publications) {
        await writeChanged(publicationPath, await readFile(candidatePath, 'utf8'));
    }
    const { publications, ...published } = prepared;
    await writeChanged(outputPath, `${JSON.stringify(published)}\n`);
    return published;
}

/** The existing UI compiler subprocess owns both source-driven asset families. */
export async function prepareSourceUiAssets({ uiPackageDir, outputDir, recordPath, retainedRecordPath = recordPath,
    deferPublication = false }) {
    const { prepareLocaleAssets } = await import('./prepareLocaleAssets.mjs');
    const { generateShikiGrammarAssets } = await import('./generateShikiGrammarAssets.mjs');
    const specs = [
        { generate: prepareLocaleAssets, source: SOURCE_UI_ASSET_OUTPUT_PATHS.locales, candidate: 'locales.js' },
        { generate: generateShikiGrammarAssets, source: SOURCE_UI_ASSET_OUTPUT_PATHS.shiki, candidate: 'shiki.js' },
    ];
    const assets = [];
    const publications = [];
    const groups = [];
    const retained = readSourceUiAssetsRecord(retainedRecordPath);
    const repoRoot = resolve(uiPackageDir, '../..');
    const packages = await readWorkspacePackages(repoRoot);
    const compilerInputs = await readSourcePluginUiBuildInputs({ repoDir: repoRoot, compiler: true, packages });
    const packageRoots = new Map([...packages.values()].map(owner => [owner.root, owner]));
    const dependencyMarker = await readJsonIfExists(resolveDependencyRefreshMarkerPath(repoRoot));
    const dependencyIdentity = dependencyMarker && Array.isArray(dependencyMarker.inputs)
        ? dependencyInputsIdentity(dependencyMarker.identity, dependencyMarker.inputs) : dependencyMarker;
    const identity = inputPaths => readBuildInputIdentity({ sourceDir: repoRoot,
        files: inputPaths.map(path => relative(repoRoot, path)), options: [process.version, dependencyIdentity] });
    let compiled = 0;
    for (const { generate, source, candidate } of specs) {
        const publicationPath = resolve(uiPackageDir, source);
        const candidatePath = resolve(outputDir, 'source-assets', candidate);
        const previous = retained?.groups?.find(group => group.outputPath === publicationPath);
        const previousIdentity = previous ? await identity(previous.inputPaths) : undefined;
        let result;
        let reused = false;
        if (previous && previous.fingerprint === previousIdentity && await Promise.all(
            [publicationPath, ...previous.assetPaths].map(path => access(path).then(() => true, () => false)),
        ).then(present => present.every(Boolean))) {
            await writeChanged(candidatePath, await readFile(publicationPath, 'utf8'));
            result = { ...previous, outputPath: candidatePath };
            reused = true;
        } else {
            result = await generate({ uiPackageDir, outputPath: candidatePath, publicationPath });
            compiled += 1;
        }
        const owners = new Set([uiPackageDir]);
        for (const input of result.inputPaths) {
            let parent = dirname(input);
            while (dirname(parent) !== parent && !packageRoots.has(parent)) parent = dirname(parent);
            if (packageRoots.has(parent)) owners.add(parent);
        }
        const inputPaths = reused ? previous.inputPaths : [...new Set([fileURLToPath(import.meta.url), ...result.inputPaths,
            ...compilerInputs.map(path => resolve(repoRoot, path)),
            ...[...owners].flatMap(root => readWorkspaceBuildInputs(root, { sourceRoots: [] })
                .map(path => resolve(root, path)))])];
        const fingerprint = await identity(inputPaths);
        // The existing watcher requests a trailing refresh for edits during a build.
        // Do not certify unchanged reuse when its previously known inputs moved.
        groups.push({ outputPath: publicationPath, inputPaths, assetPaths: result.assetPaths,
            ...(previous && previousIdentity !== await identity(previous.inputPaths) ? {} : { fingerprint }) });
        assets.push(result);
        publications.push({ candidatePath: result.outputPath, outputPath: publicationPath });
    }
    const prepared = {
        inputPaths: [...new Set(groups.flatMap(group => group.inputPaths))],
        assetPaths: assets.flatMap(asset => asset.assetPaths),
        outputPaths: publications.map(publication => publication.outputPath),
        publications,
        groups,
    };
    await writeChanged(recordPath, `${JSON.stringify(prepared)}\n`);
    if (!deferPublication) await publishSourceUiAssets({ recordPath });
    console.log(`[source-ui] phase=source-asset-input-reuse compiled=${compiled} reused=${specs.length - compiled}`);
    return prepared;
}
