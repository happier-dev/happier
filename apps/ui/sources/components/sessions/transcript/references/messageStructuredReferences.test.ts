import { describe, expect, it } from 'vitest';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol';

import { resolveMessageStructuredReferences } from './messageStructuredReferences';

function metaWithMentions(mentions: readonly Record<string, unknown>[]): Record<string, unknown> {
    return { happierStructuredInputV1: { v: 1, mentions } };
}

function sessionMention(sessionId: string, token: string, label?: string) {
    return {
        kind: MENTION_KIND_V1.session,
        ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, sessionId),
        token,
        ...(label ? { label } : {}),
    };
}

function fileMention(path: string, token: string) {
    return {
        kind: MENTION_KIND_V1.file,
        ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, path),
        token,
    };
}

describe('resolveMessageStructuredReferences', () => {
    it('renders a session reference only from the envelope, never from matching text (INV-5)', () => {
        const text = 'compare with @session:release-prep-a1b2c3';

        const withEnvelope = resolveMessageStructuredReferences({
            meta: metaWithMentions([sessionMention('sess_42', '@session:release-prep-a1b2c3', 'Release prep')]),
            text,
        });
        const withoutEnvelope = resolveMessageStructuredReferences({ meta: undefined, text });

        expect(withEnvelope).toEqual([
            { kind: 'session', sessionId: 'sess_42', label: 'Release prep' },
        ]);
        // Identical text, no envelope entry: plain text. This is the whole point of INV-5 —
        // an agent that merely writes a session-looking token cannot manufacture a link.
        expect(withoutEnvelope).toEqual([]);
    });

    it('renders a quoted file token the legacy text scan cannot parse', () => {
        const text = 'open @"my file.ts" please';

        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([fileMention('my file.ts', '@"my file.ts"')]),
            text,
        });

        expect(references).toEqual([{ kind: 'file', path: 'my file.ts' }]);
        expect(resolveMessageStructuredReferences({ meta: undefined, text })).toEqual([]);
    });

    it('keeps the legacy text scan for files so pre-envelope messages still render', () => {
        expect(resolveMessageStructuredReferences({
            meta: undefined,
            text: 'see @src/api.ts and @README.md',
        })).toEqual([
            { kind: 'file', path: 'src/api.ts' },
            { kind: 'file', path: 'README.md' },
        ]);
    });

    it('collapses an envelope file reference and its text-scan twin into one chip', () => {
        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([fileMention('src/api.ts', '@src/api.ts')]),
            text: 'see @src/api.ts twice: @src/api.ts',
        });

        expect(references).toEqual([{ kind: 'file', path: 'src/api.ts' }]);
    });

    it('leaves a well-formed unknown kind inert and never reinterprets it as a known one', () => {
        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([
                { kind: 'acme.ticket', ref: 'session:sess_42', token: '@acme:1' },
                sessionMention('sess_real', '@session:real'),
            ]),
            text: '@acme:1 @session:real',
        });

        expect(references).toEqual([{ kind: 'session', sessionId: 'sess_real', label: null }]);
    });

    it('drops a file reference whose path escapes the workspace', () => {
        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([
                {
                    kind: MENTION_KIND_V1.file,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, '../../etc/passwd'),
                    token: '@x',
                },
            ]),
            text: '@x',
        });

        expect(references).toEqual([]);
    });

    // D-4 precedence itself is pinned where a legacy arm actually exists — the protocol owner
    // (`mentionRefV1.test.ts` over `readStructuredInputMentionSourcesV1`) and the CLI consumers.
    // This projection has no legacy arm, so a precedence assertion here would hold for every
    // possible implementation. What it CAN violate is bypassing the canonical META reader and
    // taking the mentions off raw `meta`, so that is what is pinned.
    it('reads through the canonical sanitizing reader, so a malformed sibling drops alone (INV-4)', () => {
        const references = resolveMessageStructuredReferences({
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [
                        // No `token`: rejected element-wise by `sanitizeMentionRefsV1`,
                        // which runs inside `readHappierStructuredInputV1FromMeta`. This
                        // projection checks only kind + ref scheme, so bypassing that reader and
                        // taking `meta.happierStructuredInputV1.mentions` off the RAW meta would
                        // render it — verified RED. Swapping only
                        // `readStructuredInputMentionSourcesV1` for `envelope.mentions` is NOT
                        // caught here and must not be claimed: by that point the envelope is
                        // already sanitized. D-4 precedence is pinned at the protocol owner.
                        { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess_bad') },
                        sessionMention('sess_ok', '@session:ok'),
                    ],
                    skillMentions: [{ name: 'review', path: '/skills/review' }],
                },
            },
            text: '@session:bad @session:ok',
        });

        expect(references).toEqual([{ kind: 'session', sessionId: 'sess_ok', label: null }]);
    });
});
