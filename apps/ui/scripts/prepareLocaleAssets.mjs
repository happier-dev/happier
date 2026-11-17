import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sourcePluginUiBuildOptions } from '../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { getStacksStorageRoot } from '../../stack/scripts/utils/paths/paths.mjs';
import { withJsonOwnerFileLock } from '../../stack/scripts/utils/proc/jsonOwnerFileLock.mjs';
import { isPidAlive } from '../../stack/scripts/utils/proc/pids.mjs';
import { SOURCE_UI_ASSET_OUTPUT_PATHS, SOURCE_UI_ASSET_RECORD_FILENAME } from './sourceUiAssetPaths.mjs';

async function writeChanged(path, contents) {
    if (await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; }) === contents) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, path);
}

// Retention (owner ruling 2026-11-15, growth fixes) keeps every bundle that the
// published map, a source asset record (published or staged) or a live
// preparation names. LOCALE-BUNDLES-1112 Incident 2: concurrent publishers each
// deleted bundles the other had written but not yet published. A preparation
// therefore names each bundle under the store lock before writing it, and
// retirement reads every reference under the same lock. Metro's block list skips
// `.tmp.` entries, so this bookkeeping never reaches a graph.
//
// The store is shared by every process using this checkout, whatever its HOME,
// Stack storage root or execution host (P03-LOCALE-FIX, 2026-11-17: a
// preparation under another storage root retired the bundles repo-dev's record
// named). Records therefore register their names in the store itself, and only
// the host that wrote a reference judges whether its record or process is gone.
const PREPARATIONS = '.tmp.locale-preparations';
const REFERENCES = '.tmp.locale-references';
const HOST = hostname();
const BUNDLE_NAME = /^[a-f0-9]{64}\.locale\.bundle$/u;
const withLocaleStore = (directory, action) =>
    withJsonOwnerFileLock(action, { lockPath: join(directory, '.tmp.locale-retention.lock'), errorLabel: 'locale bundle store' });

async function entries(path) {
    return readdir(path, { withFileTypes: true }).catch(error => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return [];
    });
}

async function readJsonFile(path) {
    const contents = await readFile(path, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    return contents ? JSON.parse(contents) : null;
}

/** A preparation's bundles stay retained until its map or record names them. */
export async function openLocalePreparation(directory) {
    const marker = join(directory, PREPARATIONS, `${process.pid}-${randomUUID()}.json`);
    const paths = [];
    return {
        retain: (assetPath, contents) => withLocaleStore(directory, async () => {
            paths.push(assetPath);
            await writeChanged(marker, JSON.stringify({ host: HOST, pid: process.pid, paths }));
            await writeChanged(assetPath, contents);
        }),
        close: () => rm(marker, { force: true }),
    };
}

const referencePath = (directory, recordPath) =>
    join(directory, REFERENCES, `${createHash('sha256').update(recordPath).digest('hex').slice(0, 32)}.json`);

const namesIn = (directory, assetPaths) => (assetPaths ?? [])
    .filter(assetPath => dirname(resolve(assetPath)) === resolve(directory) && BUNDLE_NAME.test(basename(assetPath)))
    .map(assetPath => basename(assetPath));

async function writeReference(directory, recordPath, names) {
    const path = referencePath(directory, recordPath);
    if (names.length === 0) await rm(path, { force: true });
    else await writeChanged(path, JSON.stringify({ host: HOST, recordPath, names: [...new Set(names)].sort() }));
}

/** Register a source asset record's locale bundles in each store it names, so a
 * preparation under any storage root or HOME keeps them while the record exists.
 * Like retirement, a failure is reported and never fails the record's writer. */
export async function registerLocaleReferences(recordPath, assetPaths) {
    const stores = new Set(assetPaths.filter(path => BUNDLE_NAME.test(basename(path))).map(path => dirname(resolve(path))));
    for (const directory of stores) {
        await withLocaleStore(directory, () => writeReference(directory, resolve(recordPath), namesIn(directory, assetPaths)))
            .catch(error => console.error(`[source-ui] phase=locale-reference status=failed reason=${error.code ?? error.message}`));
    }
}

// Source asset records sit beside Plugin UI inventories: the UI-owned ones under
// .expo/hstack, each Stack's Expo inventory, their in-flight compiler stages and
// explicit inventories. Content-addressed names make a basename match exact.
// They are the records this process can see; the store's reference index adds
// every record written or seen under any other storage root or HOME.
async function visibleRecords(uiPackageDir) {
    const records = new Map();
    const read = async path => {
        const record = await readJsonFile(path);
        if (record) records.set(resolve(path), record.assetPaths);
    };
    const inventoryParent = async parent => {
        await read(join(parent, SOURCE_UI_ASSET_RECORD_FILENAME));
        for (const entry of await entries(parent)) {
            if (entry.isDirectory() && entry.name.startsWith('.happier-plugin-ui-stage-')) {
                await read(join(parent, entry.name, 'inputs', SOURCE_UI_ASSET_RECORD_FILENAME));
            }
        }
    };
    const visit = async directory => {
        for (const entry of await entries(directory)) {
            const path = join(directory, entry.name);
            if (entry.isDirectory() && entry.name !== 'locales' && entry.name !== 'artifacts') await visit(path);
            else if (entry.name === SOURCE_UI_ASSET_RECORD_FILENAME) await read(path);
        }
    };
    await visit(resolve(uiPackageDir, '.expo/hstack'));
    await read(resolve(uiPackageDir, 'sources/sync/domains/plugins/availability', SOURCE_UI_ASSET_RECORD_FILENAME));
    const inventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    if (inventory) await inventoryParent(dirname(inventory));
    const storage = getStacksStorageRoot();
    for (const stack of await entries(storage)) {
        if (!stack.isDirectory()) continue;
        for (const instance of await entries(join(storage, stack.name, 'expo-dev'))) {
            if (instance.isDirectory()) await inventoryParent(join(storage, stack.name, 'expo-dev', instance.name, 'plugin-ui'));
        }
    }
    return records;
}

/** Index every visible record, then read the whole index. A host drops only its
 * own references whose record is gone; another host's record path may simply
 * not exist here. */
async function referencedBundleNames(uiPackageDir, directory) {
    for (const [recordPath, assetPaths] of await visibleRecords(uiPackageDir)) {
        const names = namesIn(directory, assetPaths);
        if (names.length > 0) await writeReference(directory, recordPath, names);
    }
    const names = new Set();
    for (const entry of await entries(join(directory, REFERENCES))) {
        const path = join(directory, REFERENCES, entry.name);
        const reference = await readJsonFile(path).catch(() => null);
        let referenced = reference?.names ?? [];
        // Only an absent record (ENOENT) releases its names; an unreadable one keeps them.
        const record = reference?.host === HOST ? await readJsonFile(reference.recordPath).catch(() => undefined) : undefined;
        if (record !== undefined) {
            referenced = record ? namesIn(directory, record.assetPaths) : [];
            await writeReference(directory, reference.recordPath, referenced);
        }
        for (const name of referenced) names.add(name);
    }
    return names;
}

/** Retire bundles no published map, source asset record or live preparation names.
 * Retention is maintenance: a failure is reported and never fails publication. */
export async function retireLocaleBundles({ uiPackageDir, directory = resolve(uiPackageDir, '.expo/hstack/locales') }) {
    return withLocaleStore(directory, async () => {
        const mapPath = resolve(uiPackageDir, SOURCE_UI_ASSET_OUTPUT_PATHS.locales);
        const map = await readFile(mapPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
        const retained = await referencedBundleNames(uiPackageDir, directory);
        for (const match of map.matchAll(/require\(("(?:[^"\\]|\\.)*\.locale\.bundle")\)/gu)) retained.add(basename(JSON.parse(match[1])));
        for (const entry of await entries(join(directory, PREPARATIONS))) {
            const marker = join(directory, PREPARATIONS, entry.name);
            const preparation = await readJsonFile(marker).catch(() => null);
            if (preparation && ((preparation.host ?? HOST) !== HOST || isPidAlive(preparation.pid))) {
                for (const path of preparation.paths) retained.add(basename(path));
            }
            else await rm(marker, { force: true });
        }
        let retired = 0;
        for (const entry of await entries(directory)) {
            if (!entry.isFile() || !BUNDLE_NAME.test(entry.name) || retained.has(entry.name)) continue;
            await unlink(join(directory, entry.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
            retired++;
        }
        return { retained: retained.size, retired };
    }).catch(error => {
        console.error(`[source-ui] phase=locale-retention status=failed reason=${error.code ?? error.message}`);
        return null;
    });
}

/** Compile copy at the existing UI preparation boundary; Metro only registers its asset IDs. */
export async function prepareLocaleAssets(options = {}) {
    if (options.preparation) return await compileLocaleAssets(options);
    const preparation = await openLocalePreparation(options.outputDirectory ?? resolve(options.uiPackageDir, '.expo/hstack/locales'));
    try { return await compileLocaleAssets({ ...options, preparation }); }
    finally { await preparation.close(); }
}

async function compileLocaleAssets({ uiPackageDir,
    outputDirectory = resolve(uiPackageDir, '.expo/hstack/locales'),
    outputPath = resolve(uiPackageDir, SOURCE_UI_ASSET_OUTPUT_PATHS.locales),
    publicationPath = outputPath,
    preparation,
}) {
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
        await preparation.retain(assetPath, source);
        assetPaths.push(assetPath);
        let specifier = relative(dirname(publicationPath), assetPath).replaceAll('\\', '/');
        if (!specifier.startsWith('.')) specifier = `./${specifier}`;
        assets.push(`    ${JSON.stringify(language)}: require(${JSON.stringify(specifier)}),`);
    }
    const contents = `// Generated by prepareLocaleAssets.mjs.\nexport const LOCALE_ASSETS = {\n${assets.join('\n')}\n};\n`;
    await writeChanged(outputPath, contents);
    if (outputPath === publicationPath) await retireLocaleBundles({ uiPackageDir, directory: outputDirectory });
    return { outputPath, assetPaths, inputPaths: [...inputPaths] };
}
