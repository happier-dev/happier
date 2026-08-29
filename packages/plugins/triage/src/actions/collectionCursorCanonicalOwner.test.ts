import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProtocolCollectionOpaqueCursorV1Schema } from '@happier-dev/plugin-sdk/protocol';

import { TriageReadEntryDetailInputV1Schema, TriageReadEntryDetailResultV1Schema } from './entryDetailProtocol.js';
import { TriageListEntriesInputV1Schema, TriageListEntriesResultV1Schema } from './listEntriesProtocol.js';
import { TriageListPinnedEntriesInputV1Schema, TriageListPinnedEntriesResultV1Schema } from './userMarksProtocol.js';

/**
 * The Triage Actions compose the canonical Protocol Collection cursor.
 *
 * The Account Collection cursor has one grammar owner: Protocol's
 * `PluginCollectionOpaqueCursorV1Schema`, projected for feature authors as
 * `ProtocolCollectionOpaqueCursorV1Schema` on `@happier-dev/plugin-sdk/protocol`.
 * This plugin used to re-declare that 4096-character base64url grammar locally,
 * which let the two spellings drift. These assertions keep the local
 * declaration deleted and keep every Action wire embedded on the canonical
 * projection.
 */

const triageSourceRoot = join(import.meta.dirname, '..');
const retiredLocalCursorModule = join(import.meta.dirname, 'collectionCursorProtocol.ts');

/** The child projection `defineProtocolObject` embeds for the canonical cursor. */
const CANONICAL_CURSOR_PROJECTION = Object.freeze({
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    pattern: '^[A-Za-z0-9_-]+$',
});

function triageSourceFiles(): readonly string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
            const path = join(directory, entry);
            if (statSync(path).isDirectory()) walk(path);
            // Tests legitimately name the retired module and its bound while
            // proving their absence; the duplication fence covers shipped sources.
            else if (/\.(?:ts|tsx)$/u.test(entry) && !/(?:\.test|\.testkit)\.tsx?$/u.test(entry)) {
                files.push(path);
            }
        }
    };
    walk(triageSourceRoot);
    return files;
}

describe('the Triage Collection cursor composes the canonical Protocol owner', () => {
    it('keeps no local cursor grammar declaration in the plugin', () => {
        expect(existsSync(retiredLocalCursorModule)).toBe(false);
        for (const path of triageSourceFiles()) {
            const source = readFileSync(path, 'utf8');
            expect(source.includes('collectionCursorProtocol'), path).toBe(false);
            // The retired local declaration was this repo's only `maxLength: 4096`
            // spelling inside the plugin; its return would be a second cursor owner.
            expect(source.includes('maxLength: 4096'), path).toBe(false);
        }
    });

    it('embeds the canonical cursor projection in every paging Action wire', () => {
        // Pin/Unpin: the marks pager.
        expect(TriageListPinnedEntriesInputV1Schema.jsonSchema.properties?.cursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);
        expect(TriageListPinnedEntriesResultV1Schema.jsonSchema.properties?.nextCursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);

        // Entry detail: the linked-Session pager (the read arm of the result union).
        expect(TriageReadEntryDetailInputV1Schema.jsonSchema.properties?.linkedSessionsCursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);
        expect(TriageReadEntryDetailResultV1Schema.jsonSchema.anyOf?.[0]?.properties?.linkedSessionsNextCursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);

        // Aggregate list: the configured-source batch pager (the allConfigured arm).
        expect(TriageListEntriesInputV1Schema.jsonSchema.properties?.sources?.anyOf?.[0]?.properties?.cursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);
        expect(TriageListEntriesResultV1Schema.jsonSchema.properties?.configuredSourcesNextCursor)
            .toEqual(CANONICAL_CURSOR_PROJECTION);
    });

    it('admits exactly the canonical cursor at the marks pager boundary', () => {
        const inputWith = (cursor: unknown): Readonly<Record<string, unknown>> => ({
            v: 1,
            limit: 1,
            cursor,
        });

        expect(TriageListPinnedEntriesInputV1Schema.safeParse(inputWith('a'.repeat(4096))).success)
            .toBe(true);
        expect(TriageListPinnedEntriesInputV1Schema.safeParse(inputWith('a'.repeat(4097))).success)
            .toBe(false);
        expect(TriageListPinnedEntriesInputV1Schema.safeParse(inputWith('bad cursor')).success)
            .toBe(false);
        expect(TriageListPinnedEntriesInputV1Schema.safeParse({ v: 1, limit: 1 }).success)
            .toBe(true);
    });
});
