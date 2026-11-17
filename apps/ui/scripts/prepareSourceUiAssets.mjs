import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInputIdentity } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspacePackages } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
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

/** Every source asset record is written here, so the locale store it names
 * learns about it whatever storage root or HOME this process runs under. */
async function writeSourceUiAssetsRecord(path, record) {
    await writeChanged(path, `${JSON.stringify(record)}\n`);
    const { registerLocaleReferences } = await import('./prepareLocaleAssets.mjs');
    await registerLocaleReferences(path, record.assetPaths ?? []);
}

/** Publish references only after the containing owner admits their asset files. */
export async function publishSourceUiAssets({ recordPath, outputPath = recordPath }) {
    const prepared = readSourceUiAssetsRecord(recordPath);
    if (!prepared) throw new Error(`Missing prepared UI assets: ${recordPath}`);
    let localeMap;
    for (const { candidatePath, outputPath: publicationPath } of prepared.publications) {
        const contents = await readFile(candidatePath, 'utf8');
        await writeChanged(publicationPath, contents);
        if (publicationPath.endsWith(normalize(SOURCE_UI_ASSET_OUTPUT_PATHS.locales))) localeMap = publicationPath;
    }
    if (localeMap) {
        const { retireLocaleBundles } = await import('./prepareLocaleAssets.mjs');
        await retireLocaleBundles({ uiPackageDir: resolve(dirname(localeMap), '../..') });
    }
    // A published record has no pending candidates. Keep the record shape
    // readable after in-place publication without retaining compiler scratch.
    const published = { ...prepared, publications: [] };
    await writeSourceUiAssetsRecord(outputPath, published);
    return published;
}

/** The existing UI compiler subprocess owns both source-driven asset families. */
export async function prepareSourceUiAssets(options) {
    const { openLocalePreparation } = await import('./prepareLocaleAssets.mjs');
    // Locale bundles stay retained by this preparation until its record names them.
    const preparation = await openLocalePreparation(resolve(options.uiPackageDir, '.expo/hstack/locales'));
    try { return await prepareSourceUiAssetsWith({ ...options, preparation }); }
    finally { await preparation.close(); }
}

/** The git-ignored worker bundles and worklet core, from their own source compilers,
 * selected by the same task policy as installation. */
async function readSourceWorkerSpecs() {
    const { resolveUiPostinstallTasks } = await import('../tools/resolveUiPostinstallTasks.mjs');
    const tasks = resolveUiPostinstallTasks({ env: process.env });
    const web = tasks.includes('vendor-password-kdf-worker');
    // The compiler module joins the bundler's own input list (its metafile).
    const tool = path => [fileURLToPath(new URL(path, import.meta.url)), fileURLToPath(new URL('../tools/sourceAsset.mjs', import.meta.url))];
    const worker = (build, modulePath) => async ({ uiPackageDir, outputPath }) => {
        const built = await build({ uiDirectory: uiPackageDir, outputFile: outputPath });
        return { outputPath, assetPaths: [], inputPaths: [...tool(modulePath), ...built.inputPaths] };
    };
    // One compiler emits both atmosphere targets beside the candidate.
    const atmosphere = async ({ uiPackageDir, outputPath }) => {
        const { buildAtmosphereRenderers } = await import('../tools/atmosphere/buildAtmosphereRenderers.mjs');
        const built = await buildAtmosphereRenderers({ uiDirectory: uiPackageDir, outputDirectory: dirname(outputPath), web });
        return { outputPath, assetPaths: [], inputPaths: [...tool('../tools/atmosphere/buildAtmosphereRenderers.mjs'), ...built.inputPaths] };
    };
    const specs = [];
    if (tasks.includes('prepare-atmosphere-renderers')) {
        specs.push({ generate: atmosphere, source: SOURCE_UI_ASSET_OUTPUT_PATHS.atmosphereWorklet, candidate: 'backdropWorkletCore.generated.js' });
        if (web) specs.push({ generate: atmosphere, source: SOURCE_UI_ASSET_OUTPUT_PATHS.atmosphereWorker, candidate: 'happier-atmosphere-worker.js' });
    }
    if (web) {
        const { buildPasswordKdfWorker } = await import('../tools/password/buildPasswordKdfWorker.mjs');
        specs.push({ generate: worker(buildPasswordKdfWorker, '../tools/password/buildPasswordKdfWorker.mjs'), source: SOURCE_UI_ASSET_OUTPUT_PATHS.passwordKdfWorker, candidate: 'happier-password-kdf-worker.js' });
    }
    if (tasks.includes('vendor-crypto-worker')) {
        const { buildCryptoWorker } = await import('../tools/crypto/buildCryptoWorker.mjs');
        specs.push({ generate: worker(buildCryptoWorker, '../tools/crypto/buildCryptoWorker.mjs'), source: SOURCE_UI_ASSET_OUTPUT_PATHS.cryptoWorker, candidate: 'happier-crypto-worker.js' });
    }
    return specs;
}

async function prepareSourceUiAssetsWith({ uiPackageDir, outputDir, recordPath, retainedRecordPath = recordPath,
    deferPublication = false, preparation }) {
    const { prepareLocaleAssets } = await import('./prepareLocaleAssets.mjs');
    const { generateShikiGrammarAssets } = await import('./generateShikiGrammarAssets.mjs');
    const specs = [
        { generate: prepareLocaleAssets, source: SOURCE_UI_ASSET_OUTPUT_PATHS.locales, candidate: 'locales.js' },
        { generate: generateShikiGrammarAssets, source: SOURCE_UI_ASSET_OUTPUT_PATHS.shiki, candidate: 'shiki.js' },
        ...await readSourceWorkerSpecs(),
    ];
    const assets = [];
    const publications = [];
    const groups = [];
    const retained = readSourceUiAssetsRecord(retainedRecordPath);
    const repoRoot = resolve(uiPackageDir, '../..');
    const packages = await readWorkspacePackages(repoRoot);
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
        const exists = path => access(path).then(() => true, () => false);
        // A finite export recaptures its project each time; its retained candidate
        // is the same verified output when the publication is not there yet.
        const reusable = previous && previous.fingerprint === previousIdentity
            && await Promise.all(previous.assetPaths.map(exists)).then(present => present.every(Boolean))
            ? (await exists(publicationPath) ? publicationPath : await exists(candidatePath) ? candidatePath : null) : null;
        if (reusable) {
            if (reusable !== candidatePath) await writeChanged(candidatePath, await readFile(reusable, 'utf8'));
            result = { ...previous, outputPath: candidatePath };
            reused = true;
        } else {
            result = await generate({ uiPackageDir, outputPath: candidatePath, publicationPath, preparation });
            compiled += 1;
        }
        const owners = new Set([uiPackageDir]);
        for (const input of result.inputPaths) {
            let parent = dirname(input);
            while (dirname(parent) !== parent && !packageRoots.has(parent)) parent = dirname(parent);
            if (packageRoots.has(parent)) owners.add(parent);
        }
        // Key each asset by its own compiler's input list, plus the manifests the
        // bundler resolves through in each owning package. Edits outside that
        // closure (other sources, temp tsconfigs, Metro config) keep the asset.
        const inputPaths = reused ? previous.inputPaths : [...new Set([fileURLToPath(import.meta.url), ...result.inputPaths,
            ...[...owners].flatMap(root => ['package.json', 'tsconfig.json'].map(name => resolve(root, name)))])];
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
    await writeSourceUiAssetsRecord(recordPath, prepared);
    if (!deferPublication) await publishSourceUiAssets({ recordPath });
    console.log(`[source-ui] phase=source-asset-input-reuse compiled=${compiled} reused=${specs.length - compiled}`);
    return prepared;
}
