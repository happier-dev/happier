import { describe, expect, it } from 'vitest';

import { MENTION_BOUNDS } from '@happier-dev/protocol';

import { buildSessionReferenceBlockV1 } from './sessionReferenceBlock';
import { resolveProviderPromptForDispatch } from './resolveProviderPromptForDispatch';

function metaWithMentions(mentions: readonly unknown[]): Record<string, unknown> {
    return { happierStructuredInputV1: { v: 1, mentions } };
}

function sessionMention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        kind: 'happier.session',
        ref: 'session:cmslj08960ku1tmhrd0v4a0a7',
        token: '@session:fix-startup-4a0a7',
        start: 0,
        end: 25,
        ...overrides,
    };
}

function createSession(metadata: unknown = {}) {
    let snapshot = metadata;
    return {
        getMetadataSnapshot: () => snapshot,
        updateMetadata: (updater: (value: any) => any) => {
            snapshot = updater(snapshot);
        },
    };
}

describe('session reference block (D-21)', () => {
    it('names the referenced session id and marks the title as an insert-time snapshot', () => {
        const block = buildSessionReferenceBlockV1(metaWithMentions([
            sessionMention({ label: 'Fix Detached Dev Stack Startup' }),
        ]));

        expect(block).toContain('<happier_session_reference>');
        expect(block).toContain('</happier_session_reference>');
        expect(block).toContain('cmslj08960ku1tmhrd0v4a0a7');
        expect(block).toContain('Fix Detached Dev Stack Startup');
        expect(block).toMatch(/may have changed/);
    });

    it('tells the agent the tools may be available and that a tool failure must be surfaced', () => {
        const block = buildSessionReferenceBlockV1(metaWithMentions([sessionMention()])) ?? '';

        expect(block).toMatch(/may be available/);
        expect(block).toMatch(/If a tool call fails/);
    });

    it('carries no transcript content', () => {
        const block = buildSessionReferenceBlockV1(metaWithMentions([
            sessionMention({ label: 'Fix Detached Dev Stack Startup' }),
        ])) ?? '';

        expect(block).toMatch(/No transcript content is included/);
        // The only session-derived strings in the block are its id and the title snapshot.
        expect(block.length).toBeLessThanOrEqual(MENTION_BOUNDS.maxReferenceBlockChars);
    });

    it('states an unreadable reference instead of fabricating an id', () => {
        const block = buildSessionReferenceBlockV1(metaWithMentions([
            // A `happier.session` mention whose ref is not a readable `session:<id>`: a
            // mismatched scheme must never be reinterpreted (INV-4).
            sessionMention({ ref: 'vendorPlugin:plugin://gmail@openai-curated' }),
        ])) ?? '';

        expect(block).toMatch(/could not be read/);
        expect(block).not.toContain('gmail');
        expect(block).not.toMatch(/session id: \S/);
    });

    it('deduplicates by reference and keeps first-occurrence order (D-26)', () => {
        const block = buildSessionReferenceBlockV1(metaWithMentions([
            sessionMention({ ref: 'session:aaa', start: 0, end: 10, token: '@session:a' }),
            sessionMention({ ref: 'session:bbb', start: 11, end: 21, token: '@session:b' }),
            sessionMention({ ref: 'session:aaa', start: 22, end: 32, token: '@session:a' }),
        ])) ?? '';

        expect(block.match(/session id: aaa/g)).toHaveLength(1);
        expect(block.indexOf('session id: aaa')).toBeLessThan(block.indexOf('session id: bbb'));
    });

    it('stays inside maxReferenceBlockChars and states what it dropped', () => {
        const mentions = Array.from({ length: 64 }, (_, index) => sessionMention({
            ref: `session:${'s'.repeat(40)}${index}`,
            label: 'A very long session title '.repeat(4),
            start: index * 30,
            end: index * 30 + 25,
        }));

        const block = buildSessionReferenceBlockV1(metaWithMentions(mentions)) ?? '';

        expect(block.length).toBeLessThanOrEqual(MENTION_BOUNDS.maxReferenceBlockChars);
        expect(block).toMatch(/omitted to stay within the reference budget/);
        expect(block.endsWith('</happier_session_reference>')).toBe(true);
    });

    it('returns null for a message with no session reference', () => {
        expect(buildSessionReferenceBlockV1({})).toBeNull();
        expect(buildSessionReferenceBlockV1(metaWithMentions([
            { kind: 'happier.file', ref: 'file:src/index.ts', token: '@src/index.ts', start: 0, end: 13 },
        ]))).toBeNull();
    });
});

describe('prompt finalization wiring', () => {
    it('appends the block to the provider prompt and leaves the user text alone', async () => {
        const userText = 'compare this with @session:fix-startup-4a0a7';
        const resolved = await resolveProviderPromptForDispatch({
            session: createSession({}),
            userText,
            allowSeed: false,
            localId: 'local-1',
            nowMs: 1,
            refreshMetadataBeforeRead: false,
            meta: metaWithMentions([sessionMention({ label: 'Fix Startup' })]),
        });

        expect(resolved.providerPrompt.startsWith(userText)).toBe(true);
        expect(resolved.providerPrompt).toContain('<happier_session_reference>');
        expect(resolved.providerPrompt).toContain('cmslj08960ku1tmhrd0v4a0a7');
    });

    it('keeps the block out of the dispatch metadata, so it can never reach displayText', async () => {
        const resolved = await resolveProviderPromptForDispatch({
            session: createSession({}),
            userText: 'hi',
            allowSeed: false,
            localId: 'local-1',
            nowMs: 1,
            refreshMetadataBeforeRead: false,
            meta: metaWithMentions([sessionMention()]),
        });

        expect(JSON.stringify(resolved.meta)).not.toContain('happier_session_reference');
    });

    it('emits no provider structured item for a session reference', async () => {
        const resolved = await resolveProviderPromptForDispatch({
            session: createSession({}),
            userText: 'hi',
            allowSeed: false,
            localId: 'local-1',
            nowMs: 1,
            refreshMetadataBeforeRead: false,
            meta: metaWithMentions([sessionMention()]),
            catalogs: {
                listSkills: async () => ({ skills: [] }),
                listVendorPlugins: async () => ({ vendorPlugins: [] }),
            },
        });

        const envelope = (resolved.meta as Record<string, any>).happierStructuredInputV1;
        // Codex builds items only from `skillMentions`/`vendorPluginMentions`; a session
        // reference contributes to neither, so the block is its only presentation.
        expect(envelope.skillMentions).toBeUndefined();
        expect(envelope.vendorPluginMentions).toBeUndefined();
        expect(envelope.mentions).toBeUndefined();
    });

    it('applies the block after the replay seed, so both reach the provider once', async () => {
        const resolved = await resolveProviderPromptForDispatch({
            session: createSession({ replaySeedV1: { v: 1, seedText: 'SEED', sourceSessionId: 's', sourceCutoffSeqInclusive: 1, createdAtMs: 1 } }),
            userText: 'hello',
            allowSeed: true,
            localId: 'local-1',
            nowMs: 1,
            refreshMetadataBeforeRead: false,
            meta: metaWithMentions([sessionMention()]),
        });

        expect(resolved.providerPrompt.indexOf('SEED')).toBe(0);
        expect(resolved.providerPrompt.indexOf('hello')).toBeLessThan(
            resolved.providerPrompt.indexOf('<happier_session_reference>'),
        );
    });
});
