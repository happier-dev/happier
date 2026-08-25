import { describe, expect, it } from 'vitest';

import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

import { TriageListEntriesInputV1Schema } from './listEntriesProtocol.js';

/**
 * The aggregate wire's string bounds are the published V1 byte bounds.
 *
 * Every one of them is documented and enforced by the source protocol as a
 * count of UTF-8 bytes. A string bound spelled as a length is counted in code
 * points instead, so the same value that a source is refused for sending would
 * be admitted here — and the derived worst-case encoded result, which is what
 * keeps the current maximum-window shape inventory current, would be measured
 * against a bound three or four times narrower than what the wire admits.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });

/** Three UTF-8 bytes per code point, and no JSON escape at all. */
const WIDE = '一';

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
    return encoder.encode(value).byteLength;
}

function inputWith(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return {
        v: 1,
        sources: { kind: 'allConfigured' },
        limit: 1,
        order: 'newest',
        ...overrides,
    };
}

function admits(value: Readonly<Record<string, unknown>>): boolean {
    return TriageListEntriesInputV1Schema.safeParse(value).success;
}

function fragmentAt(path: readonly string[]): PluginJsonSchema {
    let fragment: PluginJsonSchema = TriageListEntriesInputV1Schema.jsonSchema;
    for (const segment of path) {
        const next = segment === '[]' ? fragment.items : fragment.properties?.[segment];
        if (next === undefined) throw new Error(`no schema fragment at ${path.join('.')}`);
        fragment = next;
    }
    return fragment;
}

const boundedStrings = [
    {
        name: 'query',
        bound: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
        path: ['query'],
        build: (value: string) => inputWith({ query: value }),
    },
    {
        name: 'filters.types[].kindId',
        bound: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
        path: ['filters', 'types', '[]', 'kindId'],
        build: (value: string) => inputWith({
            filters: {
                sources: [],
                types: [{ source: SOURCE, kindId: value }],
                scopes: [],
                states: [],
                attention: [],
            },
        }),
    },
    {
        name: 'filters.scopes[].collisionScope',
        bound: MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
        path: ['filters', 'scopes', '[]', 'collisionScope'],
        build: (value: string) => inputWith({
            filters: {
                sources: [],
                types: [],
                scopes: [{ source: SOURCE, collisionScope: value }],
                states: [],
                attention: [],
            },
        }),
    },
] as const;

describe('the aggregate list wire string bounds', () => {
    it.each(boundedStrings)('bounds $name in UTF-8 bytes, not characters', ({ bound, build }) => {
        // One code point under the bound in bytes: admitted.
        const inside = WIDE.repeat(Math.floor(bound / utf8Bytes(WIDE)));
        expect(utf8Bytes(inside)).toBeLessThanOrEqual(bound);
        expect(admits(build(inside))).toBe(true);

        // One code point over it in bytes, still far under it in characters:
        // this is the value the source wire refuses and this wire must too.
        const over = `${inside}${WIDE}`;
        expect(utf8Bytes(over)).toBeGreaterThan(bound);
        expect([...over]).toHaveLength(Math.floor(bound / utf8Bytes(WIDE)) + 1);
        expect(admits(build(over))).toBe(false);

        // The bound itself is unchanged for single-byte text: this narrows a
        // unit, it does not shrink the product bound.
        expect(admits(build('a'.repeat(bound)))).toBe(true);
        expect(admits(build('a'.repeat(bound + 1)))).toBe(false);

        // Empty stays refused: every V1 string is non-empty.
        expect(admits(build(''))).toBe(false);
    });

    /**
     * The host validates an Action value against the *published JSON Schema*
     * before the handler runs, so the projection is the layer that decides.
     * A byte bound that survived only inside the composable parser would leave
     * the boundary admitting what the parser rejects.
     */
    it.each(boundedStrings)('publishes $name as a byte bound the host boundary enforces', ({ bound, path }) => {
        const fragment = fragmentAt(path);

        expect(fragment['x-happier-max-utf8-bytes']).toBe(bound);
        expect(fragment.maxLength).toBeUndefined();
        expect(fragment.minLength).toBe(1);
        expect(fragment.pattern).toBeDefined();
    });
});
