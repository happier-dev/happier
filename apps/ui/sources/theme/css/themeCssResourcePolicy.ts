/** CSS tokens use ASCII whitespace, not JavaScript's broader Unicode whitespace. */
const isWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f';
const isName = (char: string | undefined): boolean => char !== undefined && /[a-zA-Z0-9_-]/.test(char);
const trimCssWhitespace = (value: string): string => {
    let start = 0;
    let end = value.length;
    while (start < end && isWhitespace(value[start])) start++;
    while (end > start && isWhitespace(value[end - 1])) end--;
    return value.slice(start, end);
};
// Values do not acquire future resource-loading functions merely because the
// browser learns their syntax. This is the single shared value policy.
const nonFetchingFunctions = new Set(`
    var env attr calc min max clamp round mod rem sin cos tan asin acos atan atan2
    pow sqrt hypot log exp abs sign progress calc-size anchor anchor-size
    rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark device-cmyk
    linear-gradient radial-gradient conic-gradient repeating-linear-gradient
    repeating-radial-gradient repeating-conic-gradient -webkit-linear-gradient -webkit-radial-gradient
    translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d
    rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d perspective
    blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia
    cubic-bezier steps linear scroll view repeat minmax fit-content
    inset circle ellipse polygon path rect xywh shape ray superellipse
    counter counters symbols content string leader target-counter target-counters target-text
    stylistic styleset character-variant swash ornaments annotation
`.trim().split(/\s+/));

/** One policy shared by native preparation and detached browser sanitation. */
export function themeCssResourceRejection(value: string, context: 'declaration' | 'prelude' = 'declaration'): string | null {
    if (value.includes('\\')) return 'escaped-token';
    let index = 0;
    const skipComment = (): boolean => {
        if (value[index] !== '/' || value[index + 1] !== '*') return false;
        const end = value.indexOf('*/', index + 2);
        index = end < 0 ? value.length : end + 2;
        return true;
    };
    while (index < value.length) {
        if (skipComment()) continue;
        const char = value[index];
        if (char === '"' || char === "'") {
            index++;
            while (index < value.length && value[index] !== char) index++;
            index++;
            continue;
        }
        if (!isName(char)) { index++; continue; }
        const start = index++;
        while (index < value.length && isName(value[index])) index++;
        if (value[index] !== '(') continue;
        const name = value.slice(start, index).toLowerCase();
        index++;
        if (name === 'image-set' || name === '-webkit-image-set' || name === 'src' || name === 'image') return 'resource-function';
        if (name !== 'url') {
            if (context === 'declaration' && !nonFetchingFunctions.has(name)) return 'unknown-function';
            continue;
        }
        while (index < value.length && isWhitespace(value[index])) index++;
        let argument = '';
        const quote = value[index] === '"' || value[index] === "'" ? value[index++] : null;
        if (quote) {
            const argumentStart = index;
            while (index < value.length && value[index] !== quote) index++;
            if (index === value.length) return 'invalid-url';
            argument = value.slice(argumentStart, index++);
            while (index < value.length && (isWhitespace(value[index]) || skipComment())) {
                if (isWhitespace(value[index])) index++;
            }
            if (value[index] !== ')') return 'invalid-url';
        } else {
            while (index < value.length && value[index] !== ')') {
                // In an unquoted URL token, comment-looking characters are URL
                // characters. Removing them could turn a relative URL into data:.
                argument += value[index++];
            }
            if (value[index] !== ')') return 'invalid-url';
        }
        index++;
        const address = trimCssWhitespace(argument);
        if (!address.startsWith('#') && address.slice(0, 5).toLowerCase() !== 'data:') return 'external-url';
    }
    return null;
}

/** Preserve authored escapes until they can be removed: CSSOM normalizes names. */
export function removeEscapedThemeCssTokens(source: string): Readonly<{ css: string; removed: readonly string[] }> {
    let index = 0;
    const removed: string[] = [];
    const block = (nested: boolean): string => {
        let output = '';
        let start = index;
        let escaped = false;
        const brackets: string[] = [];
        const flush = (end: number): void => {
            const fragment = source.slice(start, end);
            if (escaped) removed.push(fragment);
            else output += fragment;
            start = end;
            escaped = false;
        };
        while (index < source.length) {
            const char = source[index];
            if (char === '/' && source[index + 1] === '*') {
                const end = source.indexOf('*/', index + 2);
                if (end < 0) throw new SyntaxError('Unfinished CSS comment');
                index = end + 2;
                continue;
            }
            if (char === '"' || char === "'") {
                index++;
                while (index < source.length && source[index] !== char) {
                    if (source[index] === '\\') { escaped = true; index++; }
                    index++;
                }
                if (index === source.length) throw new SyntaxError('Unfinished CSS string');
                index++;
                continue;
            }
            if (char === '\\') { escaped = true; index += 2; continue; }
            if (char === '(' || char === '[') { brackets.push(char); index++; continue; }
            if (char === ')' || char === ']') {
                const opener = brackets.pop();
                if (opener !== (char === ')' ? '(' : '[')) throw new SyntaxError('Unbalanced CSS token');
                index++;
                continue;
            }
            if (brackets.length) { index++; continue; }
            if (char === '{') {
                const header = source.slice(start, index);
                const rejectHeader = escaped;
                index++;
                const children = block(true);
                if (rejectHeader) removed.push(source.slice(start, index));
                else output += `${header}{${children}}`;
                start = index;
                escaped = false;
                continue;
            }
            if (char === '}') {
                if (!nested) throw new SyntaxError('Unexpected CSS block end');
                flush(index);
                index++;
                return output;
            }
            index++;
            if (char === ';') flush(index);
        }
        if (nested || brackets.length) throw new SyntaxError('Unfinished CSS block');
        flush(index);
        return output;
    };
    return { css: block(false), removed };
}
