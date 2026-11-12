import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sourcePluginUiBuildOptions } from '../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { getStacksStorageRoot } from '../../stack/scripts/utils/paths/paths.mjs';
import { SOURCE_UI_ASSET_RECORD_FILENAME, SOURCE_UI_ASSET_OUTPUT_PATHS } from './sourceUiAssetPaths.mjs';

async function writeChanged(path, contents) {
    if (await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; }) === contents) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, path);
}

function referencedBundles(contents, outputPath) {
    return [...contents.matchAll(/require\(("(?:[^"\\]|\\.)*\.locale\.bundle")\)/gu)]
        .map(match => resolve(dirname(outputPath), JSON.parse(match[1])));
}

async function entries(path) {
    return readdir(path, { withFileTypes: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [];
    });
}

// These are the source asset record owners: standalone Expo/source admission,
// managed Expo (including staged readiness candidates), and explicit inventories.
// Finite exports compile inside their own captured UI tree, not this store.
async function retainedSourceAssets(uiPackageDir) {
    const retained = new Set();
    const readRecord = async path => {
        const contents = await readFile(path, 'utf8').catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        });
        if (contents) for (const path of JSON.parse(contents).assetPaths ?? []) retained.add(path);
    };
    const visit = async directory => {
        for (const entry of await entries(directory)) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.name === SOURCE_UI_ASSET_RECORD_FILENAME) await readRecord(path);
        }
    };
    await visit(resolve(uiPackageDir, '.expo/hstack'));
    await readRecord(resolve(uiPackageDir, 'sources/sync/domains/plugins/availability', SOURCE_UI_ASSET_RECORD_FILENAME));
    const inventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    if (inventory) await readRecord(resolve(dirname(inventory), SOURCE_UI_ASSET_RECORD_FILENAME));
    const storage = getStacksStorageRoot();
    for (const stack of await entries(storage)) {
        if (stack.isDirectory()) await visit(join(storage, stack.name, 'expo-dev'));
    }
    return retained;
}

/** Publish once, retaining current/previous maps and every published or staged
 * source record. A readiness record may outlive several direct preparations. */
export async function publishLocaleAssets({ outputPath, contents }) {
    const current = await readFile(outputPath, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
    });
    const assets = referencedBundles(contents, outputPath);
    if (!assets.length) { await writeChanged(outputPath, contents); return; }
    const directory = dirname(assets[0]);
    const previousPath = join(directory, 'previous-generation.json');
    const retained = await retainedSourceAssets(resolve(dirname(outputPath), '../..'));
    if (current !== contents) {
        await writeChanged(previousPath, JSON.stringify(referencedBundles(current, outputPath)));
    }
    await writeChanged(outputPath, contents);
    const previous = JSON.parse(await readFile(previousPath, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '[]';
    }));
    for (const path of [...assets, ...previous]) retained.add(path);
    for (const name of await entries(directory)) {
        const path = join(directory, name.name);
        if (name.isFile() && /^[a-f0-9]{64}\.locale\.bundle$/u.test(name.name) && !retained.has(path)) {
            await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }
}

/** Compile copy at the existing UI preparation boundary; Metro only registers its asset IDs. */
export async function prepareLocaleAssets({ uiPackageDir,
    outputDirectory = resolve(uiPackageDir, '.expo/hstack/locales'),
    outputPath = resolve(uiPackageDir, SOURCE_UI_ASSET_OUTPUT_PATHS.locales),
    publicationPath = outputPath,
} = {}) {
    const repoRoot = resolve(uiPackageDir, '../..');
    const languagePath = resolve(uiPackageDir, 'sources/text/_all.ts');
    const { SUPPORTED_LANGUAGE_CODES } = await import(pathToFileURL(languagePath).href);
    const sourceOptions = await sourcePluginUiBuildOptions({ repoRoot });
    const inputPaths = new Set([fileURLToPath(import.meta.url), fileURLToPath(new URL('./sourceUiAssetPaths.mjs', import.meta.url)), languagePath]);
    const assets = [];
    const assetPaths = [];
    for (const language of SUPPORTED_LANGUAGE_CODES.filter(language => language !== 'en')) {
        const host = language === 'zh-Hans' ? 'zhHans' : language === 'zh-Hant' ? 'zhHant' : language;
        const result = await build({
            stdin: { contents: `import { ${host} } from './translations/${language}';\nimport { BUNDLED_PLUGIN_TRANSLATIONS } from './bundledPluginTranslations/${language}.generated';\nexport const bundle = { host: ${host}, plugins: BUNDLED_PLUGIN_TRANSLATIONS };`,
                loader: 'ts', resolveDir: resolve(uiPackageDir, 'sources/text') },
            absWorkingDir: uiPackageDir, bundle: true, platform: 'browser', format: 'cjs',
            target: ['es2020'], minify: true, charset: 'utf8', write: false, metafile: true,
            plugins: [{ name: 'authored-workspace-source', setup(builder) {
                builder.onResolve({ filter: /^@happier-dev\// }, args => {
                    const path = sourceOptions.resolveSourceImport(args.path);
                    return path ? { path } : undefined;
                });
            } }],
        });
        for (const input of Object.keys(result.metafile.inputs)) {
            if (input !== '<stdin>') inputPaths.add(resolve(uiPackageDir, input));
        }
        const source = result.outputFiles[0].text;
        const digest = createHash('sha256').update(source).digest('hex');
        const assetPath = join(outputDirectory, `${digest}.locale.bundle`);
        await writeChanged(assetPath, source);
        assetPaths.push(assetPath);
        let specifier = relative(dirname(publicationPath), assetPath).replaceAll('\\', '/');
        if (!specifier.startsWith('.')) specifier = `./${specifier}`;
        assets.push(`    ${JSON.stringify(language)}: require(${JSON.stringify(specifier)}),`);
    }
    const contents = `// Generated by prepareLocaleAssets.mjs.\nexport const LOCALE_ASSETS = {\n${assets.join('\n')}\n};\n`;
    if (outputPath === publicationPath) await publishLocaleAssets({ outputPath, contents });
    else await writeChanged(outputPath, contents);
    return { outputPath, assetPaths, inputPaths: [...inputPaths] };
}
