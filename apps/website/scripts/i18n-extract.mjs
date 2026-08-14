/**
 * Mechanically extract every translatable string from the data modules.
 *
 * WHY IT BUNDLES AND IMPORTS RATHER THAN PARSING THE AST.
 * A static walk sees `title: 'Codex cloud runs tasks…'` but not
 * `` `Remote drives Codex. Happier drives ${AGENTS.length} agents.` `` — and the
 * second kind is 36 strings carrying real claims. Bundling with esbuild and
 * importing the result yields the VALUES, so a computed string extracts as the
 * sentence a reader actually sees. The cost is that the modules must be
 * importable in Node, which they are: they are plain data with no browser access.
 *
 * Traversal and ids come from src/i18n/overlay.ts, which is the same module the
 * runtime uses to substitute translations. One walk, two callers — see the
 * docblock there for why that matters.
 *
 * Usage:
 *   node scripts/i18n-extract.mjs            # write catalogue + print report
 *   node scripts/i18n-extract.mjs --check    # fail if the catalogue is stale
 *   node scripts/i18n-extract.mjs --report   # print only, write nothing
 */
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'src/i18n/generated');

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const REPORT_ONLY = args.has('--report');

/**
 * Scratch space for the bundle, INSIDE the project.
 *
 * Not os.tmpdir(): the bundle keeps `react` and the workspace packages external,
 * and Node resolves a bare specifier by walking up from the importing file. From
 * /tmp there is no node_modules to find, so the import fails on `react`. Writing
 * under the project's own node_modules puts the resolver back on familiar ground.
 */
function scratchRoot() {
    const dir = join(ROOT, 'node_modules/.cache');
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Modules whose exported strings are site copy. */
function sourceModules() {
    const dataDir = join(ROOT, 'src/data');
    const data = readdirSync(dataDir)
        .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))
        .map((f) => ({ ns: basename(f, f.endsWith('.tsx') ? '.tsx' : '.ts'), file: join(dataDir, f) }));
    return data;
}

/** Bundle every module behind one entry so a single import gets us all values. */
async function loadModules(modules) {
    const tmp = mkdtempSync(join(scratchRoot(), 'happier-i18n-'));
    try {
        const entry = join(tmp, 'entry.mjs');
        writeFileSync(
            entry,
            modules.map((m, i) => `export * as ns${i} from ${JSON.stringify(m.file)};`).join('\n'),
            'utf8',
        );
        const outfile = join(tmp, 'bundle.mjs');
        await build({
            entryPoints: [entry],
            outfile,
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            jsx: 'automatic',
            packages: 'external',
            logLevel: 'silent',
        });
        const loaded = await import(pathToFileURL(outfile).href);
        return modules.map((m, i) => ({ ...m, exports: loaded[`ns${i}`] ?? {} }));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/** Tokens that must survive translation byte-identical. */
const DNT_PATTERNS = [
    /`[^`]+`/g,                       // inline code spans
    /\bhappier\s+[a-z][\w:-]*/g,      // CLI invocations
    /~\/[\w./-]+/g,                   // home-relative paths
    /\b(?:npm|npx|yarn|brew|curl|iwr|pnpm)\s+[\w@./-]+/g,
];

function dntTokens(value) {
    const found = new Set();
    for (const re of DNT_PATTERNS) for (const m of value.matchAll(re)) found.add(m[0]);
    return [...found];
}

const { walkStrings } = await import(pathToFileURL(join(ROOT, 'src/i18n/overlay.ts')).href).catch(
    async () => {
        // overlay.ts is TypeScript; bundle it the same way as the data modules.
        const tmp = mkdtempSync(join(scratchRoot(), 'happier-i18n-ov-'));
        const outfile = join(tmp, 'overlay.mjs');
        await build({
            entryPoints: [join(ROOT, 'src/i18n/overlay.ts')],
            outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20',
            packages: 'external', logLevel: 'silent',
        });
        const mod = await import(pathToFileURL(outfile).href);
        rmSync(tmp, { recursive: true, force: true });
        return mod;
    },
);

const modules = await loadModules(sourceModules());

const catalogue = {};
const meta = {};
const perNamespace = {};
let dntCount = 0;

for (const m of modules) {
    for (const [exportName, value] of Object.entries(m.exports)) {
        if (typeof value === 'function') continue;
        const visits = walkStrings(value, `${m.ns}.${exportName}`);
        for (const v of visits) {
            if (catalogue[v.id] !== undefined && catalogue[v.id] !== v.value) {
                console.error(`  id collision: ${v.id}`);
            }
            catalogue[v.id] = v.value;
            const dnt = dntTokens(v.value);
            if (dnt.length) { meta[v.id] = { dnt }; dntCount += 1; }
        }
        if (visits.length) {
            perNamespace[m.ns] = (perNamespace[m.ns] ?? 0) + visits.length;
        }
    }
}

const ids = Object.keys(catalogue).sort();
const words = ids.reduce((n, id) => n + catalogue[id].trim().split(/\s+/).length, 0);

console.log('namespace                strings');
for (const [ns, n] of Object.entries(perNamespace).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ns.padEnd(22)} ${String(n).padStart(5)}`);
}
console.log(`  ${'TOTAL'.padEnd(22)} ${String(ids.length).padStart(5)}   ~${words.toLocaleString()} words`);
console.log(`  ${'with code/CLI tokens'.padEnd(22)} ${String(dntCount).padStart(5)}   (must survive verbatim)`);

if (REPORT_ONLY) process.exit(0);

const catalogueJson = `${JSON.stringify(catalogue, null, 2)}\n`;
const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
const catalogueFile = join(OUT_DIR, 'en.json');
const metaFile = join(OUT_DIR, 'dnt.json');

if (CHECK) {
    const stale = [
        [catalogueFile, catalogueJson],
        [metaFile, metaJson],
    ].filter(([f, want]) => !existsSync(f) || readFileSync(f, 'utf8') !== want);
    if (stale.length) {
        console.error(`\nSTALE: ${stale.map(([f]) => basename(f)).join(', ')} — run \`yarn i18n:extract\``);
        process.exit(1);
    }
    console.log('\ncatalogue is current');
    process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(catalogueFile, catalogueJson, 'utf8');
writeFileSync(metaFile, metaJson, 'utf8');
console.log(`\nwrote src/i18n/generated/en.json (${ids.length} ids) and dnt.json (${dntCount})`);
