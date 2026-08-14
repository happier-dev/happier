/**
 * Lift prose out of JSX and into src/data/pageProse.ts.
 *
 *   -<P>Then <code>happier codex</code> in a repository.</P>
 *   +<P>{rich(PAGE_PROSE.codexRemotePage.p3, { 1: (c) => <code>{c}</code> })}</P>
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
 * WHAT IT REFUSES. A block containing a JSX expression that is not a plain
 * member access — a `.map()`, a ternary, a call — is left alone and reported.
 * Those need a person to decide what the message actually is.
 *
 * IDS ARE ORDINAL PER PAGE (`securityPage.p0`, `p1`, …). Prose blocks have no
 * natural key, and content-derived ids orphan every translation the moment the
 * English is re-worded — which happens far more often than blocks are reordered.
 * Reordering renumbers; that is the accepted cost and the reason `--check`
 * exists.
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

const PROSE_TAGS = new Set(['P', 'p', 'li', 'blockquote', 'figcaption', 'dd']);
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
    : ['src/pages', 'src/sections'].flatMap((d) => {
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
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
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

const catalogue = {};      // ns -> { id -> message }
const skipped = [];
let liftedBlocks = 0;
let touchedFiles = 0;

for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const ns = nsFor(file);

    const blocks = [];
    const visit = (node) => {
        if (ts.isJsxElement(node) && PROSE_TAGS.has(node.openingElement.tagName.getText())) {
            const kids = node.children.filter((c) => !(ts.isJsxText(c) && c.text.trim() === ''));
            const words = node.children
                .filter(ts.isJsxText)
                .map((c) => c.text.trim())
                .join(' ')
                .split(/\s+/)
                .filter(Boolean).length;
            if (words >= 3) {
                blocks.push({ node, kids });
                return; // do not descend into a block we are taking whole
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(src);
    if (!blocks.length) continue;

    const edits = [];
    let index = 0;

    for (const { node, kids } of blocks) {
        const id = `p${index}`;
        let slot = 0;
        let message = '';
        const slotFns = [];
        const values = [];
        let refuse = null;

        for (const child of kids) {
            if (ts.isJsxText(child)) {
                message += jsxText(child.text);
            } else if (ts.isJsxElement(child)) {
                slot += 1;
                // A slot's own children may be text and simple interpolations —
                // `<code>{agent.binary}</code>` is the commonest shape on the
                // site. rich() substitutes values inside a slot, so these become
                // `<1>{binary}</1>` rather than being refused.
                let inner = '';
                for (const c of child.children) {
                    if (ts.isJsxText(c)) { inner += jsxText(c.text); continue; }
                    if (ts.isJsxExpression(c) && c.expression && ts.isPropertyAccessExpression(c.expression)
                        && ts.isIdentifier(c.expression.expression)) {
                        const name = c.expression.name.text;
                        inner += `{${name}}`;
                        values.push(`${name}: ${c.expression.getText()}`);
                        continue;
                    }
                    refuse = `nested ${ts.isJsxElement(c) ? 'element' : 'expression'} inside <${child.openingElement.tagName.getText()}>`;
                    break;
                }
                if (refuse) break;
                message += `<${slot}>${inner}</${slot}>`;
                const open = child.openingElement.getText();
                const tag = child.openingElement.tagName.getText();
                slotFns.push(`${slot}: (c: ReactNode) => ${open}{c}</${tag}>`);
            } else if (ts.isJsxSelfClosingElement(child)) {
                refuse = `self-closing <${child.tagName.getText()}>`;
                break;
            } else if (ts.isJsxExpression(child) && child.expression) {
                const e = child.expression;
                if (ts.isStringLiteral(e)) { message += e.text; continue; }
                if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
                    const name = e.name.text;
                    message += `{${name}}`;
                    values.push(`${name}: ${e.getText()}`);
                    continue;
                }
                refuse = `expression \`${e.getText().slice(0, 40)}\``;
                break;
            }
        }

        if (refuse) {
            skipped.push({ file: rel, line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1, why: refuse });
            continue;
        }

        message = message.trim();
        if (!message) continue;

        catalogue[ns] ??= {};
        catalogue[ns][id] = message;
        index += 1;
        liftedBlocks += 1;

        const args = [`PAGE_PROSE.${ns}.${id}`];
        if (slotFns.length) args.push(`{ ${slotFns.join(', ')} }`);
        else if (values.length) args.push('undefined');
        if (values.length) args.push(`{ ${values.join(', ')} }`);

        const openTag = node.openingElement.getText();
        const closeTag = node.closingElement.getText();
        edits.push({
            start: node.getStart(),
            end: node.getEnd(),
            text: `${openTag}{rich(${args.join(', ')})}${closeTag}`,
        });
    }

    if (!edits.length) continue;

    // imports
    const imports = src.statements.filter(ts.isImportDeclaration);
    const last = imports[imports.length - 1];
    const depth = rel.split('/').length - 2;
    const prefix = depth > 0 ? '../'.repeat(depth) : './';
    const needed = [];
    if (!/from '[^']*i18n\/rich'/.test(text)) needed.push(`import { rich } from '${prefix}i18n/rich';`);
    if (!/PAGE_PROSE\s*}/.test(text) && !/from '[^']*data\/pageProse'/.test(text)) {
        needed.push(`import { PAGE_PROSE } from '${prefix}data/pageProse';`);
    }
    const usesSlots = edits.some((e) => e.text.includes('(c: ReactNode)'));
    if (usesSlots && !/\bReactNode\b/.test(text)) {
        needed.push(`import type { ReactNode } from 'react';`);
    }
    if (needed.length) {
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: `\n${needed.join('\n')}` });
    }

    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    touchedFiles += 1;
    console.log(`${WRITE ? 'lifted' : 'would lift'} ${String(index).padStart(3)} block(s)  ${rel}`);
    if (WRITE) writeFileSync(file, out, 'utf8');
}

// ---- write the catalogue module -----------------------------------------
if (WRITE && Object.keys(catalogue).length) {
    const body = Object.entries(catalogue)
        .sort()
        .map(([ns, entries]) => {
            const lines = Object.entries(entries)
                .map(([id, msg]) => `        ${id}: ${JSON.stringify(msg)},`)
                .join('\n');
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
 * sentence here, not in the component.
 *
 * \`<1>…</1>\` marks a slot: the element that wrapped that run of text in the
 * original markup, whose props live in the component and never reach a
 * translator. \`{name}\` is an interpolated value. Both are named, so a
 * translation may put them wherever the target language needs them. See
 * src/i18n/rich.tsx.
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
    console.log(`\nwrote src/data/pageProse.ts (${liftedBlocks} messages)`);
}

console.log(`\n${WRITE ? 'lifted' : 'would lift'} ${liftedBlocks} block(s) across ${touchedFiles} file(s)`);
if (skipped.length) {
    console.log(`\nleft alone — need a person (${skipped.length}):`);
    for (const s of skipped.slice(0, 30)) console.log(`  ${s.file}:${s.line}  ${s.why}`);
}
