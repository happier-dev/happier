/**
 * Rewrite component-scope data-module imports to go through useSiteData().
 *
 *   -import { SECURITY_HOPS } from '../data/security';
 *   +import { useSiteData } from '../i18n/siteData';
 *
 *    export function SecurityPage() {
 *   +    const { security: { SECURITY_HOPS } } = useSiteData();
 *
 * WHAT IT DELIBERATELY WILL NOT TOUCH.
 *
 *  - A binding used at MODULE SCOPE. `routes.tsx` builds its JSON-LD from
 *    AGENTS at module level and a hook cannot be called there. Those keep their
 *    static import; route metadata is localised through `Route.i18n` instead.
 *  - A binding that carries NO translatable string. Most of them: DOCS_URL,
 *    GITHUB_REPO_URL, IMAGES, the install commands. Routing a URL through a
 *    translation layer is churn with a downside and no upside, so the set is
 *    filtered against src/i18n/generated/en.json.
 *  - Type-only imports, which have no runtime value to overlay.
 *
 * Edits are computed as byte ranges and applied in reverse, so formatting,
 * comments and the evidence docblocks survive exactly as written. This is a
 * codemod, not a printer.
 *
 * Usage:
 *   node scripts/i18n-lift-data-imports.mjs --dry            # report only
 *   node scripts/i18n-lift-data-imports.mjs --write [files…] # apply
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ts = createRequire(join(ROOT, 'package.json'))('typescript');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const only = argv.filter((a) => !a.startsWith('--'));

/** Exports that actually contain translatable strings, from the catalogue. */
function translatableExports() {
    const catalogue = JSON.parse(readFileSync(join(ROOT, 'src/i18n/generated/en.json'), 'utf8'));
    const map = new Map(); // exportName -> namespace
    for (const id of Object.keys(catalogue)) {
        const [ns, exportName] = id.split('.');
        if (ns && exportName) map.set(exportName, ns);
    }
    return map;
}

/** Is this identifier inside a type annotation, a type query, or a type alias? */
function isInTypePosition(node) {
    for (let n = node.parent; n; n = n.parent) {
        if (ts.isTypeQueryNode(n) || ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n)) return true;
        if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
    }
    return false;
}

function walk(dir, out = []) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { walk(p, out); continue; }
        if (!['.ts', '.tsx'].includes(extname(p)) || p.includes('.test.')) continue;
        out.push(p);
    }
    return out;
}

const TRANSLATABLE = translatableExports();

const files = only.length
    ? only.map((f) => resolve(ROOT, f))
    : ['src/pages', 'src/sections', 'src/components'].flatMap((d) => {
          try { return walk(join(ROOT, d)); } catch { return []; }
      });

let changedFiles = 0;
let changedBindings = 0;

for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    if (!/from '\.{1,2}(?:\/\.\.)*\/data\//.test(text)) continue;

    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    // ---- 1. candidate bindings -------------------------------------------
    const candidates = new Map(); // name -> { ns, importDecl, element }
    for (const st of src.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const spec = st.moduleSpecifier.text;
        if (!/(?:^|\/)data\/[\w-]+$/.test(spec)) continue;
        const clause = st.importClause;
        if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.isTypeOnly) continue;
        for (const el of clause.namedBindings.elements) {
            if (el.isTypeOnly) continue;
            const ns = TRANSLATABLE.get(el.name.text);
            if (!ns) continue; // carries no copy — leave it alone
            candidates.set(el.name.text, { ns, importDecl: st, element: el });
        }
    }
    if (!candidates.size) continue;

    // ---- 2. where is each one referenced? ---------------------------------
    const usage = new Map();
    for (const name of candidates.keys()) usage.set(name, { moduleScope: 0, components: new Set() });

    const componentBodyStart = new Map(); // componentName -> body `{` position

    const visit = (node, component) => {
        let next = component;
        const noteComponent = (name, body) => {
            if (/^[A-Z]/.test(name) && body && ts.isBlock(body)) {
                next = name;
                if (!componentBodyStart.has(name)) componentBodyStart.set(name, body.getStart() + 1);
            }
        };
        if (ts.isFunctionDeclaration(node) && node.name) noteComponent(node.name.text, node.body);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
            noteComponent(node.name.text, node.initializer.body);
        }
        if (ts.isIdentifier(node) && candidates.has(node.text) && !ts.isImportSpecifier(node.parent)) {
            const u = usage.get(node.text);
            // A reference in a TYPE position needs the static import and cannot
            // be satisfied by a destructure: `function HopIcon({ id }: { id:
            // (typeof SECURITY_HOPS)[number]['id'] })` reads the name in the
            // PARAMETER LIST, which is outside the body the destructure goes
            // into. Counting it as module scope keeps the import and skips the
            // file's swap for that binding, which is the conservative answer.
            if (isInTypePosition(node)) u.moduleScope += 1;
            else if (next) u.components.add(next);
            else u.moduleScope += 1;
        }
        ts.forEachChild(node, (c) => visit(c, next));
    };
    visit(src, null);

    // Only swap bindings used exclusively inside components.
    const swap = new Map();
    for (const [name, meta] of candidates) {
        const u = usage.get(name);
        if (u.moduleScope > 0 || u.components.size === 0) continue;
        swap.set(name, { ...meta, components: [...u.components] });
    }
    if (!swap.size) continue;

    // ---- 3. compute edits --------------------------------------------------
    const edits = [];

    // 3a. shrink or delete each data import
    const byDecl = new Map();
    for (const [name, meta] of swap) {
        if (!byDecl.has(meta.importDecl)) byDecl.set(meta.importDecl, []);
        byDecl.get(meta.importDecl).push(name);
    }
    for (const [decl, removed] of byDecl) {
        const elements = decl.importClause.namedBindings.elements;
        const kept = elements.filter((el) => !removed.includes(el.name.text));
        if (kept.length === 0) {
            // Delete from the start of the statement's OWN line to the end of
            // the statement, leaving its trailing newline in place. Not
            // getFullStart(): that reaches back over the preceding newline (so
            // the previous import gets welded onto the next one) and over any
            // comment attached above the import, which would be deleted with it.
            const lineStart = text.lastIndexOf('\n', decl.getStart()) + 1;
            edits.push({ start: lineStart, end: decl.getEnd() + 1, text: '' });
        } else {
            const list = kept.map((el) => el.getText()).join(', ');
            edits.push({
                start: decl.importClause.namedBindings.getStart(),
                end: decl.importClause.namedBindings.getEnd(),
                text: `{ ${list} }`,
            });
        }
    }

    // 3b. add the useSiteData import after the last import statement
    if (!/from '[^']*i18n\/siteData'/.test(text)) {
        const imports = src.statements.filter(ts.isImportDeclaration);
        const last = imports[imports.length - 1];
        const depth = rel.split('/').length - 2; // src/<dir>/<file>
        const prefix = depth > 0 ? '../'.repeat(depth) : './';
        edits.push({
            start: last.getEnd(),
            end: last.getEnd(),
            text: `\nimport { useSiteData } from '${prefix}i18n/siteData';`,
        });
    }

    // 3c. destructure at the top of each component that needs it
    const perComponent = new Map();
    for (const [name, meta] of swap) {
        for (const c of meta.components) {
            if (!perComponent.has(c)) perComponent.set(c, new Map());
            const byNs = perComponent.get(c);
            if (!byNs.has(meta.ns)) byNs.set(meta.ns, []);
            byNs.get(meta.ns).push(name);
        }
    }
    for (const [component, byNs] of perComponent) {
        const at = componentBodyStart.get(component);
        if (at === undefined) continue;
        const parts = [...byNs.entries()]
            .map(([ns, names]) => `${ns}: { ${names.sort().join(', ')} }`)
            .join(', ');
        edits.push({ start: at, end: at, text: `\n    const { ${parts} } = useSiteData();\n` });
    }

    // ---- 4. apply in reverse ----------------------------------------------
    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    changedFiles += 1;
    changedBindings += swap.size;
    console.log(`${WRITE ? 'rewrote' : 'would rewrite'} ${rel}  (${[...swap.keys()].join(', ')})`);
    if (WRITE) writeFileSync(file, out, 'utf8');
}

console.log(
    `\n${WRITE ? 'rewrote' : 'would rewrite'} ${changedBindings} binding(s) across ${changedFiles} file(s)` +
        `${WRITE ? '' : '  — re-run with --write to apply'}`,
);
