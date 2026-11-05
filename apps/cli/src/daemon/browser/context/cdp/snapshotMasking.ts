import { z } from 'zod';

const indexes = z.array(z.number().int());
const rareStrings = z.object({ index: indexes, value: indexes });
// The subset read from Chromium's DOMSnapshot.captureSnapshot boundary. Unlike a
// page script this includes flattened shadow DOM and child documents, plus CSS.
const censusSchema = z.object({
    strings: z.array(z.string()),
    documents: z.array(z.object({
        nodes: z.object({
            parentIndex: indexes,
            nodeName: indexes,
            nodeValue: indexes,
            attributes: z.array(indexes),
            inputValue: rareStrings.optional(),
            textValue: rareStrings.optional(),
        }),
        layout: z.object({ nodeIndex: indexes, styles: z.array(indexes) }),
    })).min(1),
});

export type SnapshotMasking = Readonly<{ hasSensitiveFields: boolean; values: readonly string[] }>;

/** One privacy census per boundary, never one CDP request per field. Raw values stay in memory. */
export function readSnapshotMasking(value: unknown): SnapshotMasking {
    const census = censusSchema.parse(value);
    const values = new Set<string>();
    let hasSensitiveFields = false;
    const stringAt = (index: number): string => {
        if (index === -1) return '';
        const text = census.strings[index];
        if (text === undefined) throw new Error('Incomplete browser privacy census');
        return text;
    };
    const add = (text: string) => {
        if (!text) return;
        values.add(text);
        // AX normalizes whitespace/soft characters, while visible text can retain them.
        const normalized = text.replace(/[\u200b\u00ad]/gu, '').replace(/\s+/gu, ' ').trim();
        if (normalized) values.add(normalized);
    };
    for (const { nodes, layout } of census.documents) {
        const count = nodes.nodeName.length;
        if (nodes.parentIndex.length !== count || nodes.nodeValue.length !== count
            || nodes.attributes.length !== count || layout.nodeIndex.length !== layout.styles.length) {
            throw new Error('Incomplete browser privacy census');
        }
        const sensitive = new Set<number>();
        const nodeAt = (index: number): number => {
            if (index < 0 || index >= count) throw new Error('Incomplete browser privacy census');
            return index;
        };
        for (let i = 0; i < count; i++) {
            const attributes = new Map<string, string>();
            const raw = nodes.attributes[i];
            if (raw.length % 2) throw new Error('Incomplete browser privacy census');
            for (let j = 0; j < raw.length; j += 2) attributes.set(stringAt(raw[j]).toLowerCase(), stringAt(raw[j + 1]));
            if (attributes.get('type')?.toLowerCase() === 'password'
                || attributes.get('autocomplete')?.toLowerCase().split(/\s+/u).includes('one-time-code')) {
                sensitive.add(i);
                add(attributes.get('value') ?? '');
            }
        }
        for (let i = 0; i < layout.nodeIndex.length; i++) {
            const nodeIndex = nodeAt(layout.nodeIndex[i]);
            const style = layout.styles[i];
            // Chromium's document LayoutView has no Element/computed style.
            if (style.length === 0 && nodes.parentIndex[nodeIndex] === -1
                && stringAt(nodes.nodeName[nodeIndex]) === '#document') continue;
            if (style.length !== 1) throw new Error('Incomplete browser privacy census');
            const security = stringAt(style[0]);
            if (security && security !== 'none') sensitive.add(nodeIndex);
        }
        hasSensitiveFields ||= sensitive.size > 0;
        // Parent indices precede descendants in Chromium's flattened DOM. Inherited
        // masking protects text nodes inside a CSS-masked contenteditable as well.
        const maskedText = new Map<number, string>();
        for (let i = 0; i < count; i++) {
            const parent = nodes.parentIndex[i];
            if (parent >= i || parent < -1) throw new Error('Incomplete browser privacy census');
            if (sensitive.has(parent)) sensitive.add(i);
            if (!sensitive.has(i)) continue;
            const text = stringAt(nodes.nodeValue[i]);
            add(text);
            maskedText.set(i, text);
            const raw = nodes.attributes[i];
            for (let j = 0; j < raw.length; j += 2) if (stringAt(raw[j]).toLowerCase() === 'value') add(stringAt(raw[j + 1]));
        }
        // Text split across descendants also appears joined in AX names and innerText.
        for (let i = count - 1; i >= 0; i--) {
            const text = maskedText.get(i);
            const parent = nodes.parentIndex[i];
            if (text && sensitive.has(parent)) maskedText.set(parent, text + (maskedText.get(parent) ?? ''));
        }
        for (const text of maskedText.values()) add(text);
        for (const rare of [nodes.inputValue, nodes.textValue]) {
            if (!rare) continue;
            if (rare.index.length !== rare.value.length) throw new Error('Incomplete browser privacy census');
            for (let i = 0; i < rare.index.length; i++) if (sensitive.has(nodeAt(rare.index[i]))) add(stringAt(rare.value[i]));
        }
    }
    return { hasSensitiveFields, values: [...values].sort() };
}

/** Redact before whitespace normalization or any downstream truncation. */
export function snapshotTextMasker(masking: SnapshotMasking): (text: string) => string {
    if (masking.values.length === 0) return text => text;
    const pattern = new RegExp([...masking.values].sort((a, b) => b.length - a.length)
        .map(text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu');
    return text => text.replace(pattern, '[MASKED]');
}
