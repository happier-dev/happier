/**
 * Lift prose out of JSX and into src/data/pageProse.ts.
 *
 *   -<P>Then <code>happier codex</code> in a repository.</P>
 *   +<P>{rich(PAGE_PROSE.codexRemotePage.p3, { 1: (c) => <code>{c}</code> })}</P>
 *
 *   -<Prose heading="Read the encryption code yourself">
 *   +<Prose heading={PAGE_PROSE.securityPage.p14}>
 *
 * WHY pageProse.ts AND NOT A NEW CATALOGUE. It is an ordinary data module, so
 * the extractor already walks it, `siteData.ts` already overlays it, and
 * `applyOverlay` already substitutes it. Page prose becomes the same kind of
 * thing as agent prose instead of a second mechanism with its own extraction,
 * its own ids and its own way of going stale.
 *
 * WHAT BECOMES A SLOT. Every element child of the prose block — `<a>`, `<code>`,
 * `<strong>` — is replaced by `<N>…</N>` in the message, and its opening tag is
 * copied VERBATIM into a slot function so href, className and every other prop
 * survive untouched. The translator moves `<1>` wherever the target language
 * wants it; the props are never in the translated string and cannot be broken by
 * a translation.
 *
 * AN ELEMENT WITH NO TEXT IN IT — an inline `<svg>` chevron, a `<br />`, a
 * `<RollingNumber value={n} />` — becomes an EMPTY slot, `<2></2>`, whose
 * function ignores its children and returns the element verbatim. It has to be
 * in the message rather than left outside it: an arrow that follows the label in
 * English precedes it in Arabic, and a sentence assembled around a fixed icon
 * position cannot be fixed by any translator. rich() calls the slot with an
 * empty child list and renders exactly what was there before.
 *
 * WHAT IT REFUSES. A block containing a JSX expression that is not a plain
 * member access, an ALL_CAPS constant or a string literal — a `.map()`, a
 * ternary, `index + 1`, a call — is left alone AND NOT DESCENDED INTO, and
 * reported. Descending would lift the three `<a>` labels inside a ternary as
 * three separate messages, which is precisely the fragmented-sentence failure
 * this whole mechanism exists to avoid. Those need a person to decide what the
 * message actually is.
 *
 * A CAMEL-CASE BARE IDENTIFIER IS ALSO REFUSED, and the reason is not style.
 * `{managedPath}` and `{attach}` in AgentDetail.tsx hold JSX, not strings;
 * rich() interpolates a value with `String(v)`, so lifting one would ship
 * `[object Object]` to the page. ALL_CAPS is the codebase's convention for an
 * imported scalar constant (`RELEASE_PUBKEY_ID`, `UPCOMING_RELEASE`,
 * `BUILD_YEAR`), and `Values` being `string | number` makes the compiler the
 * backstop if that convention is ever broken.
 *
 * IDS ARE ORDINAL PER PAGE (`securityPage.p0`, `p1`, …). Prose blocks have no
 * natural key, and content-derived ids orphan every translation the moment the
 * English is re-worded — which happens far more often than blocks are reordered.
 * Reordering renumbers; that is the accepted cost and the reason `--check`
 * exists.
 *
 * THE CATALOGUE IS MERGED, NOT REWRITTEN. Everything already in pageProse.ts is
 * read back in and kept, and new ids continue from the highest ordinal that
 * namespace already has. A second run over a partly-lifted site must not
 * renumber the first run's messages, because the translations are keyed on those
 * ids.
 *
 * Usage:
 *   node scripts/i18n-lift-jsx.mjs --dry
 *   node scripts/i18n-lift-jsx.mjs --write [files…]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ts = createRequire(join(ROOT, 'package.json'))('typescript');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const only = argv.filter((a) => !a.startsWith('--'));

/**
 * Tags that are never taken WHOLE, however much text they hold.
 *
 * `<code>happier tools</code>` is a command, not a sentence, and a page that
 * lets a translator at it ships a command nobody can run. They are still SLOTS
 * inside a surrounding sentence — that is the entire point of a slot — so
 * excluding them here removes them as blocks and nothing else. The SVG tags are
 * here because an `<svg>` subtree is geometry: it reaches the message as an
 * opaque slot or not at all.
 */
const BLOCK_EXCLUDE_TAGS = new Set([
    'code', 'pre', 'kbd', 'samp', 'var', 'script', 'style',
    'svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'defs', 'use', 'mask', 'clipPath', 'linearGradient', 'stop',
]);

/**
 * Tags whose refusal must NOT be followed by descent into their children.
 *
 * A refused `<p>` is a whole sentence a person has to look at. Descending into
 * it would lift its `<a>` labels as standalone messages and quietly declare the
 * sentence done. Everything else — a `<div>` wrapper, a `<span>` — is layout,
 * and descending past it is how the text inside a wrapper gets found at all.
 */
const SENTENCE_TAGS = new Set([
    'P', 'p', 'li', 'blockquote', 'figcaption', 'dd', 'dt', 'caption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'td',
]);

/**
 * Attributes that carry a sentence rather than a class name, an id or a URL.
 *
 * An allow-list and not a deny-list: `className` and `style` are the two most
 * common attributes on this site and both are long strings full of words, so
 * anything shaped like "does it look like prose" says yes to both.
 */
const ATTR_NAMES = new Set([
    'heading', 'title', 'standfirst', 'eyebrow', 'alt', 'aria-label',
    'label', 'text', 'caption', 'placeholder',
]);

const PROSE_FILE = join(ROOT, 'src/data/pageProse.ts');

function walk(dir, out = []) {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { walk(p, out); continue; }
        if (extname(p) !== '.tsx' || p.includes('.test.')) continue;
        out.push(p);
    }
    return out;
}

const files = only.length
    ? only.map((f) => resolve(ROOT, f))
    : ['src/pages', 'src/sections', 'src/components'].flatMap((d) => {
          try { return walk(join(ROOT, d)); } catch { return []; }
      });

/**
 * JSX text semantics, not `replace(/\s+/g, ' ')`.
 *
 * JSX does NOT render a text node verbatim. A whitespace run containing a
 * newline is dropped at the start and end of the node, and collapsed to a single
 * space in the middle — which is why
 *
 *     …live on{' '}
 *     <a href="/enterprise">
 *         the self-hosting page for teams
 *     </a>
 *     .
 *
 * renders as `…live on <a>the self-hosting page for teams</a>.` and not with
 * spaces inside the link and before the full stop. Collapsing naively put those
 * spaces into the message and changed 20 prerendered pages.
 *
 * This is Babel's cleanJSXElementLiteralChild, reproduced.
 *
 * It is ALSO why the caller must not pre-filter whitespace-only text nodes. A
 * run of spaces containing a newline collapses to nothing and one that does not
 * collapses to a single space, and `<a>x</a> <a>y</a>` on one line depends on
 * the second case. Feed every text node through here and the distinction is
 * made once, correctly.
 */
/**
 * JSX decodes HTML entities at compile time; the TypeScript AST does not.
 *
 * `node.text` for `happier &lt;agent&gt;` is the literal string `happier
 * &lt;agent&gt;`, but what JSX renders is `happier <agent>`. Copying the raw
 * form into a message means React escapes the ampersand on the way out and the
 * page ships `&amp;lt;agent&amp;gt;` — the entity visible as text. Same for
 * `can&apos;t`. Decode here so the message holds the characters a translator
 * should see, and let React do the escaping once.
 */
const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
    lsquo: '‘', ldquo: '“', rdquo: '”', times: '×',
};

function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
    });
}

function jsxText(rawInput) {
    const raw = decodeEntities(rawInput);
    const lines = raw.split(/\r\n|\n|\r/);
    let lastNonEmpty = 0;
    for (let i = 0; i < lines.length; i += 1) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;

    let out = '';
    for (let i = 0; i < lines.length; i += 1) {
        let line = lines[i].replace(/\t/g, ' ');
        if (i !== 0) line = line.replace(/^ +/, '');
        if (i !== lines.length - 1) line = line.replace(/ +$/, '');
        if (!line) continue;
        if (i !== lastNonEmpty) line += ' ';
        out += line;
    }
    return out;
}

/** `SecurityPage.tsx` → `securityPage` */
const nsFor = (file) => {
    const b = basename(file, '.tsx');
    return b.charAt(0).toLowerCase() + b.slice(1);
};

/** The message with its slot markers and value placeholders removed. */
const proseOf = (message) => message.replace(/<\/?\d+>/g, '').replace(/\{[a-zA-Z][\w]*\}/g, '');

/**
 * Is this string worth a translator's time, and safe to give one?
 *
 * `$` (a shell prompt), `·` (a separator) and `.` (the full stop after an
 * interpolated verb) are text nodes with no language in them. `happier.dev` is a
 * domain: one token, no spaces, punctuated like an address — translating it
 * breaks a link, and there is nothing in it to translate.
 */
function worthLifting(message) {
    const prose = proseOf(message).trim();
    if (!/\p{L}/u.test(prose)) return false;
    if (!/\s/.test(prose) && /[./]/.test(prose)) return false;
    return true;
}

/** Thrown by the message builder; caught per candidate. */
class Refused extends Error {}

// ---------------------------------------------------------------------------

const skipped = [];
let liftedCount = 0;
let touchedFiles = 0;

/**
 * Read the catalogue that is already there.
 *
 * The lift is incremental by construction — prose that has been lifted is no
 * longer in the JSX to find — so a run that rewrote this file from what it found
 * today would delete every message the previous run made and renumber whatever
 * survived. The translations are keyed on those ids.
 */
function readCatalogue() {
    const out = {};
    let text;
    try { text = readFileSync(PROSE_FILE, 'utf8'); } catch { return out; }
    const src = ts.createSourceFile(PROSE_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let root = null;
    const find = (node) => {
        if (root) return;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PAGE_PROSE') {
            let init = node.initializer;
            while (init && ts.isAsExpression(init)) init = init.expression;
            if (init && ts.isObjectLiteralExpression(init)) root = init;
            return;
        }
        ts.forEachChild(node, find);
    };
    find(src);
    if (!root) return out;

    for (const nsProp of root.properties) {
        if (!ts.isPropertyAssignment(nsProp) || !ts.isObjectLiteralExpression(nsProp.initializer)) continue;
        const ns = nsProp.name.getText().replace(/^['"]|['"]$/g, '');
        out[ns] = {};
        for (const entry of nsProp.initializer.properties) {
            if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.initializer)) continue;
            out[ns][entry.name.getText().replace(/^['"]|['"]$/g, '')] = entry.initializer.text;
        }
    }
    return out;
}

const catalogue = readCatalogue();
const before = new Map(Object.entries(catalogue).map(([ns, e]) => [ns, new Set(Object.keys(e))]));

/** Next free `pN` in a namespace, across everything already in the catalogue. */
function nextId(ns) {
    catalogue[ns] ??= {};
    let max = -1;
    for (const id of Object.keys(catalogue[ns])) {
        const m = /^p(\d+)$/.exec(id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `p${max + 1}`;
}

/**
 * The component this node will be rendered by, and therefore the function that
 * has to call `useSiteData()`.
 *
 * PAGE_PROSE COMES FROM THE HOOK, NOT FROM AN IMPORT. `import { PAGE_PROSE }`
 * reaches the English module directly and no overlay is ever applied to it, so
 * the lifted string renders in English in every locale with nothing failing —
 * the exact silent failure src/i18n/siteData.test.ts exists to catch elsewhere.
 * `useSiteData()` returns the modules for the reader's locale.
 *
 * Walking up stops at the nearest UPPERCASE function declaration (or uppercase
 * const holding a function with a block body), which is this codebase's spelling
 * of a component. An arrow inside `.map()` is not one — its parent is a call —
 * so the walk passes straight through it to the component that owns the loop,
 * which is where a hook is allowed to be.
 */
function enclosingComponent(node) {
    let p = node.parent;
    while (p) {
        if (ts.isFunctionDeclaration(p) && p.name && /^[A-Z]/.test(p.name.text) && p.body) return p;
        if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.body && ts.isBlock(p.body)
            && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)
            && /^[A-Z]/.test(p.parent.name.text)) return p;
        p = p.parent;
    }
    return null;
}

for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const ns = nsFor(file);
    const lineOf = (node) => src.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const edits = [];
    /** Component body start → the insertion that gives it PAGE_PROSE. */
    const hooks = new Map();

    function refuse(node, why) {
        skipped.push({ file: rel, line: lineOf(node), why });
    }

    /**
     * Make sure the component around `node` can see PAGE_PROSE, or refuse.
     * Returns false when there is no component to put the hook in — a module
     * level JSX constant, or a concise-body arrow that would have to be
     * rewritten into a block first.
     */
    function ensureProse(node) {
        const fn = enclosingComponent(node);
        if (!fn) return false;
        const at = fn.body.getStart() + 1;
        if (hooks.has(at)) return true;
        if (/pageProse:\s*\{\s*PAGE_PROSE\s*\}/.test(fn.body.getText())) {
            hooks.set(at, null);
            return true;
        }
        const col = src.getLineAndCharacterOfPosition(fn.getStart()).character;
        const indent = ' '.repeat(col + 4);
        hooks.set(at, `\n${indent}const { pageProse: { PAGE_PROSE } } = useSiteData();\n`);
        return true;
    }

    // ---- one message out of one element's children ------------------------

    /**
     * Build the message for `children`, allocating slots and values into `ctx`.
     * Throws Refused for anything a translator could not be handed safely.
     */
    function build(children, ctx) {
        let message = '';
        for (const child of children) {
            if (ts.isJsxText(child)) {
                message += jsxText(child.text);
                continue;
            }
            if (ts.isJsxExpression(child)) {
                if (!child.expression) continue; // a `{/* comment */}` renders nothing
                message += valueOf(child.expression, ctx);
                continue;
            }
            if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
                message += slotFor(child, ctx);
                continue;
            }
            if (ts.isJsxFragment(child)) throw new Refused('fragment child');
            throw new Refused(`child of kind ${ts.SyntaxKind[child.kind]}`);
        }
        return message;
    }

    function valueOf(e, ctx) {
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;

        let name = null;
        if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) name = e.name.text;
        else if (ts.isIdentifier(e) && /^[A-Z][A-Z0-9_]*$/.test(e.text)) name = e.text;

        if (!name) throw new Refused(`expression \`${e.getText().replace(/\s+/g, ' ').slice(0, 48)}\``);

        const source = e.getText();
        const existing = ctx.values.get(name);
        if (existing && existing !== source) {
            // `{agent.name}` and `{item.name}` in one sentence would both be
            // `{name}`, and a translator moving one would move the other.
            throw new Refused(`two different values would both be named {${name}}`);
        }
        ctx.values.set(name, source);
        return `{${name}}`;
    }

    /** True when nothing inside this element is text or an interpolated value. */
    function isOpaque(node) {
        if (ts.isJsxSelfClosingElement(node)) return true;
        let opaque = true;
        const look = (n) => {
            if (!opaque) return;
            if (ts.isJsxText(n) && n.text.trim() !== '') { opaque = false; return; }
            if (ts.isJsxExpression(n) && n.expression) { opaque = false; return; }
            ts.forEachChild(n, look);
        };
        for (const c of node.children ?? []) look(c);
        return opaque;
    }

    function slotFor(node, ctx) {
        ctx.slot += 1;
        const n = ctx.slot;

        if (isOpaque(node)) {
            // The children argument is deliberately unused: there is nothing in
            // the message to put inside this element, and an <svg> given
            // children would render them.
            ctx.slotFns.push(`${n}: () => ${node.getText()}`);
            return `<${n}></${n}>`;
        }

        const open = node.openingElement.getText();
        const tag = node.openingElement.tagName.getText();
        const inner = build(node.children, ctx);
        ctx.slotFns.push(`${n}: (c: ReactNode) => ${open}{c}</${tag}>`);
        return `<${n}>${inner}</${n}>`;
    }

    // ---- the walk ---------------------------------------------------------

    /** A JsxElement with real text of its own is a candidate to be one message. */
    function hasOwnText(node) {
        return node.children.some((c) => ts.isJsxText(c) && c.text.trim() !== '');
    }

    /**
     * `font-mono` is `<code>` wearing a `<div>`.
     *
     * `<div className="mt-1 font-mono text-[12px]">{agent.vendor} · happier
     * {agent.id}</div>` is a command, and the only English in it is the name of
     * the binary you type. Lifting it puts `happier` in front of a translator
     * with nothing to say it must not be translated, and the reward for getting
     * it right is a string that renders identically in every locale.
     */
    function isMonospaced(node) {
        for (const attr of node.openingElement.attributes.properties) {
            if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'className') continue;
            if (attr.initializer && ts.isStringLiteral(attr.initializer)
                && /\bfont-mono\b/.test(attr.initializer.text)) return true;
        }
        return false;
    }

    function tryBlock(node) {
        const tag = node.openingElement.tagName.getText();
        if (BLOCK_EXCLUDE_TAGS.has(tag)) return false;
        if (isMonospaced(node)) return false;
        if (!hasOwnText(node)) return false;

        const ctx = { slot: 0, slotFns: [], values: new Map() };
        let message;
        try {
            message = build(node.children, ctx).trim();
        } catch (err) {
            if (!(err instanceof Refused)) throw err;
            refuse(node, `<${tag}> — ${err.message}`);
            return SENTENCE_TAGS.has(tag); // taken off the table either way
        }
        if (!message || !worthLifting(message)) return false;
        if (!ensureProse(node)) {
            refuse(node, `<${tag}> — no component to hold the hook`);
            return SENTENCE_TAGS.has(tag);
        }

        const id = nextId(ns);
        catalogue[ns][id] = message;
        liftedCount += 1;

        const args = [`PAGE_PROSE.${ns}.${id}`];
        if (ctx.slotFns.length) args.push(`{ ${ctx.slotFns.join(', ')} }`);
        else if (ctx.values.size) args.push('undefined');
        if (ctx.values.size) {
            args.push(`{ ${[...ctx.values].map(([k, v]) => (k === v ? k : `${k}: ${v}`)).join(', ')} }`);
        }

        // Only the CHILDREN are replaced. Rewriting the whole element would
        // swallow any attribute on its opening tag that is being lifted too.
        edits.push({
            start: node.openingElement.getEnd(),
            end: node.closingElement.getStart(),
            text: `{rich(${args.join(', ')})}`,
        });
        return true;
    }

    function tryAttribute(attr) {
        if (!ts.isJsxAttribute(attr) || !attr.initializer) return;
        if (!ATTR_NAMES.has(attr.name.getText())) return;
        if (!ts.isStringLiteral(attr.initializer)) return;

        const message = decodeEntities(attr.initializer.text);
        if (!worthLifting(message)) return;
        if (!ensureProse(attr)) {
            refuse(attr, `${attr.name.getText()}="…" — no component to hold the hook`);
            return;
        }

        const id = nextId(ns);
        catalogue[ns][id] = message;
        liftedCount += 1;
        edits.push({
            start: attr.initializer.getStart(),
            end: attr.initializer.getEnd(),
            text: `{PAGE_PROSE.${ns}.${id}}`,
        });
    }

    const visit = (node) => {
        if (ts.isJsxAttribute(node)) { tryAttribute(node); return; }
        if (ts.isJsxElement(node)) {
            // Attributes on this element are lifted whether or not its children
            // are, and they are inside the opening tag the block edit leaves
            // alone — so do them first, then decide about descending.
            for (const attr of node.openingElement.attributes.properties) visit(attr);
            if (tryBlock(node)) return;
            for (const child of node.children) visit(child);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(src);

    if (!edits.length) continue;

    for (const [at, insertion] of hooks) {
        if (insertion) edits.push({ start: at, end: at, text: insertion });
    }

    // ---- imports ----------------------------------------------------------
    const imports = src.statements.filter(ts.isImportDeclaration);
    const last = imports[imports.length - 1];
    const depth = rel.split('/').length - 2;
    const prefix = depth > 0 ? '../'.repeat(depth) : './';
    const needed = [];
    const usesRich = edits.some((e) => e.text.startsWith('{rich('));
    if (usesRich && !/from '[^']*i18n\/rich'/.test(text)) needed.push(`import { rich } from '${prefix}i18n/rich';`);
    if (!/from '[^']*i18n\/siteData'/.test(text)) {
        needed.push(`import { useSiteData } from '${prefix}i18n/siteData';`);
    }
    const usesSlots = edits.some((e) => e.text.includes('(c: ReactNode)'));
    if (usesSlots && !/\bReactNode\b/.test(text)) {
        needed.push(`import type { ReactNode } from 'react';`);
    }
    if (needed.length) {
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: `\n${needed.join('\n')}` });
    }

    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = text;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    touchedFiles += 1;
    const added = Object.keys(catalogue[ns] ?? {}).filter((id) => !(before.get(ns)?.has(id))).length;
    console.log(`${WRITE ? 'lifted' : 'would lift'} ${String(added).padStart(3)} string(s)  ${rel}`);
    if (WRITE) writeFileSync(file, out, 'utf8');
}

// ---- write the catalogue module -----------------------------------------
if (WRITE && Object.keys(catalogue).length) {
    const body = Object.keys(catalogue)
        .sort()
        .map((ns) => {
            const entries = Object.entries(catalogue[ns])
                .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
            const lines = entries.map(([id, msg]) => `        ${id}: ${JSON.stringify(msg)},`).join('\n');
            return `    ${ns}: {\n${lines}\n    },`;
        })
        .join('\n');

    writeFileSync(
        PROSE_FILE,
        `/**
 * Prose lifted out of the page components by scripts/i18n-lift-jsx.mjs.
 *
 * GENERATED THE FIRST TIME, EDITED BY HAND AFTER THAT. Re-running the codemod
 * over an already-lifted page does nothing, because the prose is no longer in
 * the JSX to find — so this file is normal source from here on. Re-word a
 * sentence here, not in the component. A later run MERGES into what is here
 * rather than replacing it, and continues the numbering, so ids already carrying
 * translations keep pointing at the same sentence.
 *
 * \`<1>…</1>\` marks a slot: the element that wrapped that run of text in the
 * original markup, whose props live in the component and never reach a
 * translator. An EMPTY slot, \`<2></2>\`, is an element with nothing in it — an
 * icon, a \`<br />\` — and it is in the message so a translation can move it.
 * \`{name}\` is an interpolated value. All three are named, so a translation may
 * put them wherever the target language needs them. See src/i18n/rich.tsx.
 *
 * This is an ordinary data module, so \`yarn i18n:extract\` picks it up and the
 * overlay in src/i18n/siteData.ts translates it exactly like every other one.
 */
export const PAGE_PROSE = {
${body}
} as const;
`,
        'utf8',
    );
    console.log(`\nwrote src/data/pageProse.ts`);
}

if (!WRITE) {
    // The whole point of --dry is reading the messages before they are real.
    for (const ns of Object.keys(catalogue).sort()) {
        const fresh = Object.entries(catalogue[ns]).filter(([id]) => !before.get(ns)?.has(id));
        if (!fresh.length) continue;
        console.log(`\n${ns}:`);
        for (const [id, msg] of fresh) console.log(`  ${id}: ${JSON.stringify(msg)}`);
    }
}

console.log(`\n${WRITE ? 'lifted' : 'would lift'} ${liftedCount} string(s) across ${touchedFiles} file(s)`);
if (skipped.length) {
    console.log(`\nleft alone — need a person (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.file}:${s.line}  ${s.why}`);
}
