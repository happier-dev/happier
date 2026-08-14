import { Fragment, type ReactNode } from 'react';

/**
 * The smallest thing that can render a translated sentence containing links,
 * code spans and interpolated values.
 *
 * A message looks like this:
 *
 *   'Happier looks for <1>{binary}</1> on your PATH and runs the copy you installed.'
 *
 * `<1>…</1>` is a SLOT: the element that wrapped that run of text in the
 * original JSX. `{binary}` is a VALUE. Both are named rather than positional, so
 * a translator can move them anywhere the target language needs them — which is
 * the entire reason the sentence is one message instead of three fragments
 * glued together in source order. German and Japanese do not put the object
 * where English does, and a sentence assembled from fragments cannot be fixed by
 * any translator.
 *
 * DELIBERATELY NOT ICU, and not intl-messageformat.
 * The library is ~40 KB gzipped against 7 KB of headroom in the perf budget, and
 * this site's whole corpus needs exactly two features: slots and named values.
 * There are 47 interpolation sites and 2 plurals across ~700 strings. When a
 * third feature is genuinely needed — selectordinal, nested plurals, number
 * skeletons — the honest move is to raise the JS budget and take the real
 * library, not to grow this into a parser. That decision belongs to whoever hits
 * it; this file should not creep towards it.
 *
 * UNKNOWN SLOTS AND VALUES RENDER AS THEIR OWN TEXT rather than throwing or
 * disappearing. A translator who writes `<2>` where the message has one slot
 * gets visible `<2>` in the page — findable, and vastly better than a blank
 * paragraph or a white screen on a marketing page.
 */

export type Slots = Record<string | number, (children: ReactNode) => ReactNode>;
export type Values = Record<string, string | number>;

/** `<1>`, `</1>` or `{name}` — the only three tokens this understands. */
const TOKEN = /(<\/?\d+>|\{[a-zA-Z][\w]*\})/g;

function substitute(text: string, values: Values | undefined): string {
    if (!values) return text;
    return text.replace(/\{([a-zA-Z][\w]*)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
    );
}

/**
 * Key an array of nodes. Slot contents are arrays too, so keying only the top
 * level left React warning about the children of every nested slot.
 */
function keyed(nodes: ReactNode[]): ReactNode {
    return nodes.map((node, i) => <Fragment key={i}>{node}</Fragment>);
}

export function rich(message: string, slots?: Slots, values?: Values): ReactNode {
    if (!slots || Object.keys(slots).length === 0) {
        return substitute(message, values);
    }

    const pieces = message.split(TOKEN).filter((p) => p !== '');

    // One pass, with an explicit stack, so a slot can contain another slot.
    const root: ReactNode[] = [];
    const stack: { name: string; children: ReactNode[] }[] = [];
    const push = (node: ReactNode) => (stack.length ? stack[stack.length - 1].children : root).push(node);

    for (const piece of pieces) {
        const open = /^<(\d+)>$/.exec(piece);
        if (open && slots[open[1]]) {
            stack.push({ name: open[1], children: [] });
            continue;
        }
        const close = /^<\/(\d+)>$/.exec(piece);
        if (close && stack.length && stack[stack.length - 1].name === close[1]) {
            const done = stack.pop()!;
            push(slots[done.name](keyed(done.children)));
            continue;
        }
        push(substitute(piece, values));
    }

    // An unclosed slot would otherwise swallow the rest of the sentence.
    while (stack.length) {
        const done = stack.pop()!;
        push(`<${done.name}>`);
        for (const child of done.children) push(child);
    }

    return keyed(root);
}
