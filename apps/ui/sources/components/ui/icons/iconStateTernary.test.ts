import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES_DIR = join(__dirname, '..', '..', '..');

/**
 * Bans `cond ? 'glyph' : 'glyph'` — a conditional whose arms are the same glyph.
 *
 * This is not a style nit. Under Ionicons, fill was encoded in the NAME, so a toggle was written
 * `isFavorite ? 'star' : 'star-outline'` and the two arms were the entire visual difference between
 * on and off. The Phosphor migration mapped both spellings onto one glyph, which silently turned
 * every one of those into `isFavorite ? 'star' : 'star'` — sixteen toggles across fifteen files,
 * six of which were left with no way at all to tell their two states apart.
 *
 * A self-identical ternary is the fingerprint of exactly that: a state distinction the author
 * deliberately wrote, now collapsed. Keeping it out means the collapse cannot happen quietly again.
 */
function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
    }
    return out;
}

describe('icon state ternaries', () => {
    it('never resolves both arms to the same glyph', () => {
        const offenders: string[] = [];

        for (const file of walk(SOURCES_DIR)) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(/\?\s*'([a-z][a-z0-9-]*)'\s*:\s*'([a-z][a-z0-9-]*)'/g)) {
                if (match[1] !== match[2]) continue;
                // Only flag values that name a real glyph — plenty of domain ternaries are unrelated.
                const line = source.slice(0, match.index).split('\n').length;
                const context = source.split('\n').slice(Math.max(0, line - 4), line + 1).join('\n');
                if (!/\b(name|icon|iconName|glyph)\b/i.test(context)) continue;
                offenders.push(`${file.replace(SOURCES_DIR, '')}:${line} — ${match[1]} on both arms`);
            }
        }

        expect(offenders.sort()).toEqual([]);
    });

    /**
     * The clause above bans `cond ? 'star' : 'star'`, and that shape is exactly what a careful
     * cleanup pass removes: replacing the collapsed ternary with `const iconName = 'star'` reads as
     * tidying, satisfies the ban, and destroys the state distinction just as completely. That is not
     * hypothetical — `PathFavoriteToggleButton` was left that way, favourite and not-favourite
     * separated by colour alone, with the ban green the whole time.
     *
     * So the invariant is stated on the element that DECLARES itself a two-state control:
     * `aria-pressed` and `accessibilityState={{ selected: … }}` are the component saying, in machine
     * terms, "I am on or off". `DESIGN.md`: "Do not rely on color, hover, animation, spatial
     * position, sound, or haptics alone."
     *
     * Scoped to toggles whose ENTIRE content is one icon, because those are the ones with nowhere
     * else to put the difference. A toggle carrying a label, a badge dot, or a filled box already
     * says on/off through that; a lone glyph has only its `name` and its `weight`, so one of the two
     * has to move. Constant name, no weight, and all that is left is the colour swap.
     */
    it('gives an icon-only toggle a glyph difference, not only a colour swap', () => {
        const TOGGLE_DECLARATION = /^\s*(?:aria-pressed\s*=|accessibilityState\s*=\s*\{\{\s*selected\s*:)/;
        const OPENING_TAG = /^\s*<[A-Za-z]/;
        const CLOSING_LINE = /^\s*(?:<\/|\/>)/;
        const indentOf = (line: string): number => (line.match(/^\s*/) ?? [''])[0].length;

        const offenders: string[] = [];

        for (const file of walk(SOURCES_DIR)) {
            if (!file.endsWith('.tsx')) continue;
            const source = readFileSync(file, 'utf8');
            const lines = source.split('\n');
            const reported = new Set<string>();

            for (let i = 0; i < lines.length; i++) {
                if (!TOGGLE_DECLARATION.test(lines[i]!)) continue;

                // The element carrying the declaration, bounded by indentation: JSX in this codebase
                // is consistently indented, and a full parse buys nothing a guard needs.
                let openIndex = -1;
                for (let j = i; j >= 0; j--) {
                    if (OPENING_TAG.test(lines[j]!)) { openIndex = j; break; }
                }
                if (openIndex < 0) continue;
                const baseIndent = indentOf(lines[openIndex]!);
                let endIndex = lines.length - 1;
                for (let j = i + 1; j < lines.length; j++) {
                    if (CLOSING_LINE.test(lines[j]!) && indentOf(lines[j]!) <= baseIndent) { endIndex = j; break; }
                }
                const element = lines.slice(openIndex, endIndex + 1).join('\n');

                // Icon-only: one child element, and it is the icon. Anything richer has another
                // channel available and is not this defect.
                const icons = [...element.matchAll(/<Icon\b[\s\S]*?\/>/g)];
                const childElements = [...element.matchAll(/<[A-Za-z]/g)].length - 1;
                if (icons.length !== 1 || childElements !== 1) continue;

                const jsx = icons[0]![0];
                if (/\bweight\s*=/.test(jsx)) continue; // weight carries the state
                const nameProp = jsx.match(/\bname\s*=\s*(\{[^}]*\}|"[^"]*")/);
                if (!nameProp) continue;
                const nameExpr = nameProp[1]!;
                if (nameExpr.includes('?')) continue; // the glyph itself branches

                let glyph: string;
                const literal = nameExpr.match(/^"([a-z][a-z0-9-]*)"$/);
                if (literal) {
                    glyph = literal[1]!;
                } else {
                    // A bare identifier: follow it to its declaration, and only call it constant if
                    // that declaration is. Anything else (a member access, a call, a lookup) is
                    // data-driven rather than a fixed glyph.
                    const identifier = nameExpr.match(/^\{([A-Za-z_$][\w$]*)(?:\s+as\s+[^}]+)?\}$/);
                    if (!identifier) continue;
                    const binding = identifier[1]!;
                    if (new RegExp(`\\blet\\s+${binding}\\b`).test(source)) continue; // reassigned later
                    const declaration = source.match(
                        new RegExp(`\\b(?:const|var)\\s+${binding}\\b[^=;]*=([\\s\\S]*?);\\n`),
                    );
                    if (!declaration || declaration[1]!.includes('?')) continue;
                    glyph = binding;
                }

                const key = `${file}:${jsx}`;
                if (reported.has(key)) continue;
                reported.add(key);
                offenders.push(
                    `${file.replace(SOURCES_DIR, '')}:${openIndex + 1} — icon-only toggle renders a constant '${glyph}' glyph with no weight`,
                );
            }
        }

        expect(offenders.sort()).toEqual([]);
    });
});
