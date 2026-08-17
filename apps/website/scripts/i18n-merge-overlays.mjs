/**
 * Merge translated chunks into one overlay per locale, and refuse the ones that
 * would ship a different claim than the English.
 *
 * Translation is the cheap part; a translation that quietly changes a number or
 * localises `happier attach <session-id>` is the expensive part. These checks
 * are mechanical, they run in milliseconds, and they catch the failures that
 * actually happen — every one of them was chosen because it has a real failure
 * mode on this specific corpus:
 *
 *   numerals      "at most once a turn and three times per session hour" is a
 *                 policy default read out of a zod schema. A model that renders
 *                 "three" as "3" is fine; one that renders it as "five" has
 *                 published a false claim about the product. Digits and CJK
 *                 numerals are normalised before comparison.
 *   placeholders  {name}/{binary} must survive by name and count, or rich()
 *                 renders the literal brace text to the reader.
 *   slots         <1>…</1> must stay balanced and matched, or a sentence loses
 *                 its link — or swallows the rest of the paragraph.
 *   do-not-translate
 *                 the 102 strings carrying code spans and CLI invocations must
 *                 contain those tokens byte-identically. A localised command
 *                 does not run.
 *   untranslated  a value identical to the English is reported, not failed:
 *                 sometimes correct (product names), usually a skipped string.
 *
 * Usage:
 *   node scripts/i18n-merge-overlays.mjs           # merge + validate + write
 *   node scripts/i18n-merge-overlays.mjs --check   # validate only, write nothing
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OVERLAYS = join(ROOT, 'src/i18n/messages/overlays');
const PARTS = join(OVERLAYS, '.parts');
const CHECK = process.argv.includes('--check');

const en = JSON.parse(readFileSync(join(ROOT, 'src/i18n/generated/en.json'), 'utf8'));
const dnt = existsSync(join(ROOT, 'src/i18n/generated/dnt.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'src/i18n/generated/dnt.json'), 'utf8'))
    : {};

/** Fullwidth ０-９ and the CJK digits, so "３" and "三" compare against "3". */
/**
 * DIGITS ONLY, AND DELIBERATELY SO.
 *
 * An earlier version also mapped English number words to digits — one→1,
 * three→3 — and then compared that against the translation. It fired on ~200
 * strings per locale, every one of them a false positive: "It is ONE Claude Code
 * process" against Catalan "És UN SOL procés" is a correct translation with no
 * digit in it. Word-number mapping only means anything inside a single language.
 *
 * So this compares actual digits, normalising fullwidth ０-９ and the CJK
 * numerals a Chinese or Japanese translation legitimately uses for a figure.
 * That catches the failure that matters — "13 agents" becoming "12" — and stays
 * silent on what it cannot check. Sentences whose numbers are spelled out in
 * English are reported separately as unverifiable rather than failed.
 */
/**
 * CJK NUMERALS ARE NOT NORMALISED, AND THAT WAS THE SECOND MISTAKE HERE.
 *
 * Mapping 一→1 looks obviously right and is obviously wrong: 一 is an ordinary
 * word in Chinese prose. 一次 ("once"), 一台 ("a machine"), 第一方
 * ("first-party") are not figures, and treating them as digits produced 332
 * failures for zh-Hans where comparing plain digits finds 24. Modern Chinese
 * technical writing uses Arabic numerals for real quantities anyway, so nothing
 * is lost.
 *
 * TIMES ARE NORMALISED TO A 24-HOUR NUMBER. "out until 4pm" rendered in Catalan
 * as "fins a les 16:00" is a correct localisation, and comparing raw digits
 * called it a changed claim.
 */
function numerals(text) {
    let t = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    // Digits inside an IDENTIFIER are not quantities. `E2EE` contributes a "2",
    // so a translation writing 端到端加密 read as a dropped number; the same for
    // v0.3, x86_64, AES-256, S3. Code spans go too — their contents must survive
    // byte-identically and that is the DNT check's job, not this one.
    t = t.replace(/`[^`]*`/g, ' ');
    t = t.replace(/\b[\w-]*[A-Za-z][\w-]*\d[\w.-]*\b/g, ' ');
    t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi, (_m, h, min, ap) => {
        let hour = Number(h) % 12;
        if (ap.toLowerCase() === 'p') hour += 12;
        return ` ${hour}${min && min !== '00' ? `:${min}` : ''} `;
    });
    t = t.replace(/\b(\d{1,2}):00\b/g, ' $1 ');
    // The same 12-hour normalisation for the languages that write the marker
    // BEFORE the hour: 午後 4 時 (ja), 下午 4 点 (zh). Without this, a correct
    // Japanese rendering of "4pm" read as "the 16 became a 4".
    t = t.replace(/(?:午後|下午)\s*(\d{1,2})\s*[時点點]?/g, (_m, h) => ` ${(Number(h) % 12) + 12} `);
    t = t.replace(/(?:午前|上午)\s*(\d{1,2})\s*[時点點]?/g, (_m, h) => ` ${Number(h) % 12} `);
    // Russian puts the marker AFTER the hour and spells it as a noun:
    // "до 4 часов дня" is 4pm. Same normalisation, different word order.
    // `[а-яё]` and no `\b`: JavaScript's `\w` and `\b` are ASCII-only, so `час\w*`
    // never matched "часов" and a trailing `\b` after "дня" never fired.
    t = t.replace(/(\d{1,2})\s*(?:час[а-яё]*\s*)?(?:дня|вечера)/gi, (_m, h) => ` ${(Number(h) % 12) + 12} `);
    t = t.replace(/(\d{1,2})\s*(?:час[а-яё]*\s*)?(?:утра|ночи)/gi, (_m, h) => ` ${Number(h) % 12} `);
    return (t.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '')).sort();
}

/**
 * English figures written as words.
 *
 * A translation is ALLOWED to render "the twelve other agents" as "los otros 12
 * agentes" — spelling out is an English style choice, not part of the claim. So
 * a digit in the translation is acceptable when it matches a number the English
 * spelled out, and only an unexplained digit is a defect. What is still caught
 * is the thing that matters: a figure that changed value.
 */
const WORD_VALUE = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
    fifteen: '15', twenty: '20', thirty: '30', forty: '40', fifty: '50',
    sixty: '60', seventy: '70', eighty: '80', ninety: '90',
    hundred: '100', thousand: '1000',
    // ORDINALS MATTER AS MUCH AS CARDINALS HERE, and leaving them out was the
    // single biggest source of noise. English writes "a third agent", "no second
    // copy", "a sixth entry"; Japanese and Chinese write 3 つ目, 2 つ目, 6 番目.
    // The digit is a faithful rendering of a word the English already contains.
    first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6',
    seventh: '7', eighth: '8', ninth: '9', tenth: '10', twelfth: '12',
    // And the one collective noun this copy uses as a figure.
    dozen: '12',
    // MONTH NAMES, because leaving them out changed a translation. The site
    // carries "Verified August 2026" attestations; Chinese and Japanese write a
    // date as 2026 年 8 月, which introduced an "8" this check called invented.
    // A translator worked around it by writing 2026 年八月 instead — less
    // idiomatic prose, chosen to satisfy a validator bug. A check that quietly
    // degrades the thing it is checking is worse than no check.
    january: '1', february: '2', march: '3', april: '4', may: '5', june: '6',
    july: '7', august: '8', september: '9', october: '10', november: '11', december: '12',
};
const SPELLED = new RegExp(`\\b(?:${Object.keys(WORD_VALUE).join('|')})\\b`, 'i');

/** Digits the source either prints or spells out — the set a translation may use. */
function allowedDigits(source) {
    const set = new Set(numerals(source));
    for (const [word, value] of Object.entries(WORD_VALUE)) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(source)) set.add(value);
    }
    // Japanese and Chinese need a CLASSIFIER where English uses an article:
    // "a machine like any other" has to become 「1台のマシン」, and "an npm
    // package" becomes 「1つの npm パッケージ」. The 1 is obligatory grammar, not
    // a quantity the translator invented. Only 1, and only when the English
    // actually has a singular determiner — anything larger is still caught.
    // "per" counts as a determiner for this purpose: "Switches per turn" is
    // "per ONE turn", and Japanese must write it 1 ターンあたり.
    if (/\b(?:a|an|the|single|each|every|one|per)\b/i.test(source)) set.add('1');
    return set;
}

/** Every digit the translation prints that the source cannot account for. */
function unexplainedDigits(source, value) {
    const allowed = allowedDigits(source);
    return numerals(value).filter((n) => !allowed.has(n));
}

const placeholders = (t) => (t.match(/\{[a-zA-Z][\w]*\}/g) ?? []).sort();
const slotTags = (t) => (t.match(/<\/?\d+>/g) ?? []);

function slotsBalanced(text) {
    const stack = [];
    for (const tag of slotTags(text)) {
        const close = tag.startsWith('</');
        const n = tag.replace(/[^\d]/g, '');
        if (close) {
            if (stack.pop() !== n) return false;
        } else stack.push(n);
    }
    return stack.length === 0;
}

const locales = existsSync(PARTS)
    ? [...new Set(readdirSync(PARTS).filter((f) => f.endsWith('.json')).map((f) => f.split('.')[0]))]
    : [];

if (!locales.length) {
    console.error(`no chunk files in ${PARTS}`);
    process.exit(1);
}

let anyFatal = false;
const summary = [];

for (const locale of locales.sort()) {
    const merged = {};
    for (const file of readdirSync(PARTS).filter((f) => f.startsWith(`${locale}.`) && f.endsWith('.json'))) {
        let part;
        try {
            part = JSON.parse(readFileSync(join(PARTS, file), 'utf8'));
        } catch (error) {
            console.error(`  ${file}: INVALID JSON — ${error.message}`);
            anyFatal = true;
            continue;
        }
        Object.assign(merged, part);
    }

    const problems = { unknownId: [], numerals: [], placeholders: [], slots: [], dnt: [], untranslated: [], unverifiable: [] };

    for (const [id, value] of Object.entries(merged)) {
        const source = en[id];
        if (source === undefined) { problems.unknownId.push(id); continue; }
        if (typeof value !== 'string' || value.trim() === '') { problems.untranslated.push(id); continue; }

        const unexplained = unexplainedDigits(source, value);
        const dropped = numerals(source).filter((n) => !numerals(value).includes(n));
        if (unexplained.length || dropped.length) problems.numerals.push(id);
        else if (SPELLED.test(source)) problems.unverifiable.push(id);
        if (placeholders(source).join() !== placeholders(value).join()) problems.placeholders.push(id);
        if (slotTags(source).length !== slotTags(value).length || !slotsBalanced(value)) problems.slots.push(id);
        for (const token of dnt[id]?.dnt ?? []) {
            if (!value.includes(token)) { problems.dnt.push(`${id} :: ${token}`); break; }
        }
        if (value === source && source.split(/\s+/).length > 4) problems.untranslated.push(id);
    }

    const fatal = problems.numerals.length + problems.placeholders.length + problems.slots.length + problems.dnt.length;
    const total = Object.keys(en).length;
    const covered = Object.keys(merged).filter((id) => en[id] !== undefined).length;

    summary.push({ locale, covered, total, fatal, problems });
    if (fatal) anyFatal = true;

    if (!CHECK && !fatal) {
        mkdirSync(OVERLAYS, { recursive: true });
        const clean = Object.fromEntries(
            Object.entries(merged).filter(([id]) => en[id] !== undefined).sort(),
        );
        writeFileSync(join(OVERLAYS, `${locale}.json`), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    }
}

console.log('locale     coverage        fatal   notes');
for (const s of summary) {
    const pct = ((s.covered / s.total) * 100).toFixed(0);
    const notes = [];
    for (const [kind, list] of Object.entries(s.problems)) {
        if (list.length) notes.push(`${kind}:${list.length}`);
    }
    console.log(
        `  ${s.locale.padEnd(8)} ${String(s.covered).padStart(4)}/${s.total}  ${pct.padStart(3)}%   ` +
            `${String(s.fatal).padStart(5)}   ${notes.join(' ') || '—'}`,
    );
}

for (const s of summary) {
    if (!s.fatal) continue;
    console.log(`\n${s.locale} — must be fixed before this locale can ship:`);
    for (const [kind, list] of Object.entries(s.problems)) {
        if (!list.length || ['untranslated','unknownId','unverifiable'].includes(kind)) continue;
        for (const id of list.slice(0, 6)) {
            console.log(`  ${kind.padEnd(13)} ${id}`);
            if (kind === 'numerals') {
                console.log(`      en: ${JSON.stringify(en[id.split(' :: ')[0]]?.slice(0, 110))}`);
            }
        }
        if (list.length > 6) console.log(`  ${kind.padEnd(13)} …and ${list.length - 6} more`);
    }
}

console.log(
    anyFatal
        ? '\nFAILED — locales with fatal problems were NOT written.'
        : `\nOK — wrote ${summary.length} overlay(s) to src/i18n/messages/overlays/`,
);
process.exit(anyFatal ? 1 : 0);
