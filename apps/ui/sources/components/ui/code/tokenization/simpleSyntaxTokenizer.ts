export type SimpleSyntaxTokenType = 'keyword' | 'string' | 'number' | 'comment' | 'default';

export type SimpleSyntaxToken = Readonly<{
    text: string;
    type: SimpleSyntaxTokenType;
}>;

function isIdentifierStart(ch: string): boolean {
    return /[A-Za-z_$]/.test(ch);
}

function isIdentifierChar(ch: string): boolean {
    return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
}

function buildKeywordSet(language: string): ReadonlySet<string> {
    const base = [
        'if',
        'else',
        'for',
        'while',
        'do',
        'switch',
        'case',
        'break',
        'continue',
        'return',
        'try',
        'catch',
        'finally',
        'throw',
        'new',
        'import',
        'export',
        'from',
        'as',
        'in',
        'instanceof',
        'typeof',
        'void',
        'delete',
        'await',
        'async',
    ];

    const lang = language.toLowerCase();
    const tsLike = [
        'const',
        'let',
        'var',
        'function',
        'class',
        'interface',
        'type',
        'enum',
        'extends',
        'implements',
        'public',
        'private',
        'protected',
        'static',
        'readonly',
        'get',
        'set',
    ];

    const pyLike = [
        'def',
        'lambda',
        'pass',
        'yield',
        'with',
        'global',
        'nonlocal',
        'and',
        'or',
        'not',
        'is',
        'None',
        'True',
        'False',
    ];

    const keywords =
        lang === 'python' || lang === 'py'
            ? base.concat(pyLike)
            : lang === 'typescript' || lang === 'ts' || lang === 'javascript' || lang === 'js'
                ? base.concat(tsLike)
                : base;

    return new Set(keywords);
}

function pushToken(out: SimpleSyntaxToken[], token: SimpleSyntaxToken) {
    const prev = out[out.length - 1];
    if (prev && prev.type === token.type) {
        out[out.length - 1] = { type: prev.type, text: prev.text + token.text };
        return;
    }
    out.push(token);
}

export function tokenizeSimpleSyntaxLine(params: {
    line: string;
    language: string | null;
}): SimpleSyntaxToken[] {
    const raw = params.line ?? '';
    const language = params.language;
    if (!language) return [{ text: raw, type: 'default' }];

    const keywords = buildKeywordSet(language);
    const out: SimpleSyntaxToken[] = [];

    const isPython = language.toLowerCase() === 'python' || language.toLowerCase() === 'py';

    let i = 0;
    while (i < raw.length) {
        const ch = raw[i] ?? '';

        // Line comments.
        if (ch === '/' && raw[i + 1] === '/') {
            pushToken(out, { type: 'comment', text: raw.slice(i) });
            break;
        }
        if (isPython && ch === '#') {
            pushToken(out, { type: 'comment', text: raw.slice(i) });
            break;
        }

        // Block comment start.
        if (ch === '/' && raw[i + 1] === '*') {
            const end = raw.indexOf('*/', i + 2);
            const commentText = end === -1 ? raw.slice(i) : raw.slice(i, end + 2);
            pushToken(out, { type: 'comment', text: commentText });
            i += commentText.length;
            continue;
        }

        // Strings.
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            let j = i + 1;
            while (j < raw.length) {
                const cj = raw[j] ?? '';
                if (cj === '\\') {
                    j += 2;
                    continue;
                }
                if (cj === quote) {
                    j += 1;
                    break;
                }
                j += 1;
            }
            const str = raw.slice(i, j);
            pushToken(out, { type: 'string', text: str });
            i = j;
            continue;
        }

        // Numbers.
        if (isDigit(ch)) {
            let j = i + 1;
            while (j < raw.length) {
                const cj = raw[j] ?? '';
                if (isDigit(cj) || cj === '_' || cj === '.' || /[a-fA-Fxob]/.test(cj)) {
                    j += 1;
                    continue;
                }
                break;
            }
            pushToken(out, { type: 'number', text: raw.slice(i, j) });
            i = j;
            continue;
        }

        // Identifiers / keywords.
        if (isIdentifierStart(ch)) {
            let j = i + 1;
            while (j < raw.length && isIdentifierChar(raw[j] ?? '')) {
                j += 1;
            }
            const ident = raw.slice(i, j);
            pushToken(out, { type: keywords.has(ident) ? 'keyword' : 'default', text: ident });
            i = j;
            continue;
        }

        // Everything else.
        pushToken(out, { type: 'default', text: ch });
        i += 1;
    }

    return out;
}

