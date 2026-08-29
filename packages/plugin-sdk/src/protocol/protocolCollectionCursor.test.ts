import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { PluginCollectionOpaqueCursorV1Schema as canonicalPluginCollectionOpaqueCursorV1Schema } from '@happier-dev/protocol/plugins/data/collectionOpaqueCursorV1';

import {
    defineProtocolLiteral,
    defineProtocolObject,
    ProtocolCollectionOpaqueCursorV1Schema,
    type ProtocolCollectionOpaqueCursorV1,
} from './index.js';

/**
 * The public validator-neutral projection of the Account Data Collection's
 * opaque continuation cursor.
 *
 * A feature protocol must be able to embed this exact cursor in its own closed
 * Action wire shapes and publish the result as portable JSON Schema, without
 * re-declaring the 4096-character base64url grammar locally. `/protocol`
 * publishes the canonical Protocol value itself; the SDK adds no second
 * parser, limit, or JSON-Schema owner.
 */

const MAX_CURSOR = 'a'.repeat(4096);

describe('the /protocol Collection cursor projection', () => {
    it('publishes the canonical Protocol parser under its own name', () => {
        expect(ProtocolCollectionOpaqueCursorV1Schema).toBe(
            canonicalPluginCollectionOpaqueCursorV1Schema,
        );
        expectTypeOf<ProtocolCollectionOpaqueCursorV1>().toBeString();

        const source = readFileSync(new URL('./collectionCursor.ts', import.meta.url), 'utf8');
        expect(source).not.toContain('type PluginCollectionOpaqueCursorV1');
        expect(source).toContain('ProtocolCollectionOpaqueCursorV1 = string');
    });

    it('composes into a closed Action result a feature protocol authors', () => {
        const pageResult = defineProtocolObject({
            v: defineProtocolLiteral(1),
            nextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
        }, { policy: 'closed' });

        expect(pageResult.parse({ v: 1, nextCursor: MAX_CURSOR })).toEqual({
            v: 1,
            nextCursor: MAX_CURSOR,
        });
        // Absent stays absent; the cursor is optional, not nullable.
        expect(pageResult.parse({ v: 1 })).toEqual({ v: 1 });
        // The composed object stays closed even though the projection is open.
        expect(pageResult.safeParse({ v: 1, nextCursor: MAX_CURSOR, extra: true }).success).toBe(false);
        // The embedded grammar is the canonical one, not a narrowed copy.
        expect(pageResult.safeParse({ v: 1, nextCursor: 'not base64url' }).success).toBe(false);
        expect(pageResult.safeParse({ v: 1, nextCursor: `${MAX_CURSOR}a` }).success).toBe(false);
    });

    it('publishes the exact canonical grammar in the emitted projection', () => {
        expect(ProtocolCollectionOpaqueCursorV1Schema.jsonSchema).toEqual({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: '^[A-Za-z0-9_-]+$',
        });
    });

    it('keeps one author-visible cursor owner on the protocol barrels', () => {
        expect(readFileSync(new URL('./index.public.ts', import.meta.url), 'utf8'))
            .toContain('ProtocolCollectionOpaqueCursorV1Schema');
        expect(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
            .toContain('ProtocolCollectionOpaqueCursorV1Schema');
        // Neither sibling authoring surface publishes a cursor name: one
        // author-visible owner per concept.
        expect(readFileSync(new URL('../ui/index.public.ts', import.meta.url), 'utf8'))
            .not.toContain('ProtocolCollectionOpaqueCursor');
        expect(readFileSync(new URL('../contributions/index.public.ts', import.meta.url), 'utf8'))
            .not.toContain('ProtocolCollectionOpaqueCursor');
    });
});
