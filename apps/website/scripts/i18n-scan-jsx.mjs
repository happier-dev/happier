/**
 * Classify the prose that lives in JSX rather than in a data module.
 *
 * The data modules extract by walking runtime values (scripts/i18n-extract.mjs).
 * JSX cannot: a paragraph is a tree of children, and the interesting question is
 * not "what strings are here" but "is this sentence whole".
 *
 *   SIMPLE   <P>One text node, nothing else.</P>
 *            Liftable by codemod with no judgement: the element's whole child
 *            list becomes one message.
 *
 *   SLOTTED  <P>Text <code>happier codex</code> more text.</P>
 *            One sentence shattered across children. Liftable, but the message
 *            needs numbered slots — "Text <1>happier codex</1> more text." — and
 *            a renderer that puts the elements back. Mechanical to detect, and
 *            the slot numbering is mechanical too, but a human has to read the
 *            result because a translator will move the slots around and only a
 *            reader can tell whether the sentence still parses.
 *
 *   DYNAMIC  <P>Install {agent.name} on {agent.vendor}.</P>
 *            Needs ICU-style placeholders and, where a count is involved, plural
 *            categories. Russian and Polish have three, CJK has one.
 *
 * Usage: node scripts/i18n-scan-jsx.mjs [--list simple|slotted|dynamic]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ts = createRequire(join(ROOT, 'package.json'))('typescript');

const listArg = process.argv.indexOf('--list');
const LIST = listArg >= 0 ? process.argv[listArg + 1] : null;

/** Elements whose children are prose rather than layout. */
const PROSE_TAGS = new Set(['P', 'p', 'li', 'Li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'figcaption', 'summary', 'dd', 'dt']);

function walkFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walkFiles(p, out); continue; }
        if (extname(p) !== '.tsx' || p.includes('.test.')) continue;
        out.push(p);
    }
    return out;
}

const files = ['src/pages', 'src/sections', 'src/components'].flatMap((d) => {
    try { return walkFiles(join(ROOT, d)); } catch { return []; }
});

const buckets = { simple: [], slotted: [], dynamic: [] };
const perFile = {};

function textOf(node) {
    return node.text.replace(/\s+/g, ' ').trim();
}

/** Does this subtree contain enough language to be worth translating? */
function proseWeight(children) {
    let text = '';
    for (const c of children) {
        if (ts.isJsxText(c)) text += ` ${textOf(c)}`;
        else if (ts.isJsxElement(c)) text += ` ${proseWeight(c.children).text}`;
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return { text: trimmed, words: trimmed ? trimmed.split(/\s+/).length : 0 };
}

for (const file of files) {
    const rel = relative(ROOT, file);
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visit = (node) => {
        if (ts.isJsxElement(node)) {
            const tag = node.openingElement.tagName.getText();
            if (PROSE_TAGS.has(tag)) {
                const kids = node.children.filter(
                    (c) => !(ts.isJsxText(c) && textOf(c) === ''),
                );
                const { text, words } = proseWeight(node.children);
                if (words >= 3) {
                    const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    const hasExpression = kids.some(
                        (c) => ts.isJsxExpression(c) && c.expression && !ts.isStringLiteral(c.expression),
                    );
                    const hasElement = kids.some((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
                    const bucket = hasExpression ? 'dynamic' : hasElement ? 'slotted' : 'simple';
                    buckets[bucket].push({ file: rel, line, tag, words, text });
                    perFile[rel] ??= { simple: 0, slotted: 0, dynamic: 0, words: 0 };
                    perFile[rel][bucket] += 1;
                    perFile[rel].words += words;
                    return; // do not descend into a prose block we already counted
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(src);
}

if (LIST && buckets[LIST]) {
    for (const b of buckets[LIST]) {
        console.log(`${b.file}:${b.line}  <${b.tag}> ${b.words}w`);
        console.log(`   ${b.text.slice(0, 150)}`);
    }
    process.exit(0);
}

const count = (k) => buckets[k].length;
const words = (k) => buckets[k].reduce((n, b) => n + b.words, 0);
const total = count('simple') + count('slotted') + count('dynamic');

console.log('JSX PROSE BLOCKS            blocks     words');
for (const k of ['simple', 'slotted', 'dynamic']) {
    console.log(`  ${k.padEnd(24)} ${String(count(k)).padStart(6)}  ${String(words(k)).padStart(8)}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(total).padStart(6)}  ${String(words('simple') + words('slotted') + words('dynamic')).padStart(8)}`);
console.log(
    `\n  codemod-able with no judgement: ${count('simple')} (${((count('simple') / total) * 100).toFixed(0)}%)` +
    `\n  codemod + a human read:         ${count('slotted')} (${((count('slotted') / total) * 100).toFixed(0)}%)` +
    `\n  needs placeholders/plurals:     ${count('dynamic')} (${((count('dynamic') / total) * 100).toFixed(0)}%)`,
);

console.log('\nTOP FILES');
for (const [f, b] of Object.entries(perFile).sort((a, b) => b[1].words - a[1].words).slice(0, 12)) {
    console.log(`  ${String(b.words).padStart(5)}w  simple ${String(b.simple).padStart(3)}  slotted ${String(b.slotted).padStart(3)}  dynamic ${String(b.dynamic).padStart(3)}  ${f}`);
}
console.log('\n  node scripts/i18n-scan-jsx.mjs --list slotted   # see the shattered ones');
