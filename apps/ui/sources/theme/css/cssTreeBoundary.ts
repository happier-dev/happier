import parse from 'css-tree/lib/parser';

export type CssPosition = Readonly<{ offset: number; line: number; column: number }>;
export type CssLocation = Readonly<{ start: CssPosition; end: CssPosition }>;
export type CssNode = Readonly<{
    type: string;
    loc: CssLocation | null;
    children: readonly CssNode[];
    prelude: CssNode | null;
    block: CssNode | null;
    value: string | CssNode | null;
    name: string | CssNode | null;
    property: string | null;
    matcher: string | null;
    flags: string | null;
    important: boolean;
}>;
function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object') throw new TypeError('Invalid css-tree node');
    return value as Record<string, unknown>;
}

function position(value: unknown): CssPosition {
    const input = record(value);
    if (typeof input.offset !== 'number' || typeof input.line !== 'number' || typeof input.column !== 'number') {
        throw new TypeError('Invalid css-tree source location');
    }
    return { offset: input.offset, line: input.line, column: input.column };
}

function node(value: unknown): CssNode {
    const input = record(value);
    if (typeof input.type !== 'string') throw new TypeError('Invalid css-tree node type');
    const location = input.loc === null || input.loc === undefined ? null : record(input.loc);
    const children: CssNode[] = [];
    if (input.children !== null && input.children !== undefined) {
        const list = record(input.children);
        if (typeof list.toArray !== 'function') throw new TypeError('Invalid css-tree child list');
        const items: unknown = list.toArray();
        if (!Array.isArray(items)) throw new TypeError('Invalid css-tree children');
        for (const child of items) children.push(node(child));
    }
    const optionalNode = (value: unknown): CssNode | null => value === null || value === undefined ? null : node(value);
    const textOrNode = (value: unknown): string | CssNode | null => typeof value === 'string' ? value : optionalNode(value);
    const optionalText = (value: unknown): string | null => typeof value === 'string' ? value : null;
    return {
        type: input.type,
        loc: location ? { start: position(location.start), end: position(location.end) } : null,
        children,
        prelude: optionalNode(input.prelude),
        block: optionalNode(input.block),
        value: textOrNode(input.value),
        name: textOrNode(input.name),
        property: optionalText(input.property),
        matcher: optionalText(input.matcher),
        flags: optionalText(input.flags),
        important: input.important === true,
    };
}

/** The only full AST parse. Importing this adapter never imports the lexer/data catalogue. */
export function parseThemeCss(source: string): CssNode {
    const parsed: unknown = parse(source, { positions: true });
    return node(parsed);
}
