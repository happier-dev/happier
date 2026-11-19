import { describe, expect, it } from 'vitest';
import { MENTION_KIND_V1, buildMentionRefForKindV1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { buildComposerReferenceMentionPayloadV1 } from '@happier-dev/protocol/runtime/input/composerReferenceProviderV1';

import { resolveMessageStructuredReferences } from './messageStructuredReferences';
import { selectNicknameTargets } from './messageNicknameReferences';

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
    it('admits only direct family and structured destinations, leaving ambiguous names plain', () => {
        const session = (sessionId: string) => ({ kind: 'session', sessionId } as const);
        const eligible = selectNicknameTargets({
            currentId: 'current',
            candidates: [
                { id: 'lead', parentId: 'grand', nickname: 'Lead', target: session('lead') },
                { id: 'current', parentId: 'lead', nickname: 'Self', target: session('current') },
                { id: 'sibling', parentId: 'lead', nickname: 'Twin', target: session('sibling') },
                { id: 'child', parentId: 'current', nickname: 'Leaf', target: session('child') },
                { id: 'grandchild', parentId: 'child', nickname: 'Grandchild', target: session('grandchild') },
                { id: 'mentioned', parentId: null, nickname: 'Aside', target: session('mentioned') },
                { id: 'mentionedTwin', parentId: null, nickname: 'Twin', target: session('mentionedTwin') },
                { id: 'unrelated', parentId: 'other', nickname: 'Elsewhere', target: session('unrelated') },
            ],
            mentionedSessionIds: new Set(['mentioned', 'mentionedTwin']),
        });
        const result = resolveMessageStructuredReferences({
            text: 'Lead, Self, Twin, Leaf, Grandchild, Aside, Elsewhere.',
            meta: undefined,
            nicknameTargets: eligible,
        });
        expect([...result.inline.values()].map(reference => reference.sessionId)).toEqual(['lead', 'child', 'mentioned']);
        expect(result.markdown).toContain('Self, Twin');
        expect(result.markdown).toContain('Grandchild');
        expect(result.markdown).toContain('Elsewhere');
    });

    it('projects unique whole nicknames into the same inline references, skipping Markdown links and code', () => {
        const scout = { kind: 'nativeChild', parentSessionId: 'parent', toolMessageRouteId: 'tool:scout', agentId: 'codex' } as const;
        const text = 'Scout, Scout_2, éScout, `Scout`, [Scout](https://example.com/Scout), Scout.\n\n```\nScout\n```';
        const result = resolveMessageStructuredReferences({ text, meta: undefined, nicknameTargets: new Map([['Scout', scout]]) });
        const [reference] = [...result.inline.values()];
        expect(reference).toMatchObject({ kind: MENTION_KIND_V1.session, label: 'Scout', sessionTarget: scout });
        expect(result.markdown?.split(reference!.token!)).toEqual([
            '',
            ', Scout_2, éScout, `Scout`, [Scout](https://example.com/Scout), ',
            '.\n\n```\nScout\n```',
        ]);
        expect(result.row).toEqual([]);
    });

    it('keeps authored bindings and Find coordinates after an earlier nickname expands into a token', () => {
        const ref = buildMentionRefForKindV1(MENTION_KIND_V1.session, 'linked');
        const token = formatInlineReferenceTokenV1({ label: 'Already linked', ref });
        const text = `Scout then ${token} and needle.`;
        const result = resolveMessageStructuredReferences({
            text,
            meta: metaWithMentions([sessionMention('linked', token)]),
            nicknameTargets: new Map([['Scout', { kind: 'session', sessionId: 'scout' }]]),
        });
        expect([...result.inline.get(ref)!.tokenStarts!]).toEqual([result.markdown!.indexOf(token)]);
        const start = text.indexOf('needle');
        const projected = result.projectFindRange!({ start, end: start + 'needle'.length, current: true });
        expect(result.markdown!.slice(projected.start, projected.end)).toBe('needle');
        expect(projected.current).toBe(true);
    });
    it('projects every built-in mention and qualified contributed item through typed identity and portable glyphs', () => {
        const mentions: MentionRefV1[] = ([
            [MENTION_KIND_V1.file, 'src/components/', 'components/'],
            [MENTION_KIND_V1.session, 's1', 'Auth fix'],
            [MENTION_KIND_V1.skill, 'review', 'review'],
            [MENTION_KIND_V1.vendorPlugin, 'inspector', 'Inspector'],
            [MENTION_KIND_V1.workflow, 'w1', 'Release'],
            [MENTION_KIND_V1.widget, 'qualified-instance', 'Overview'],
        ] as const).map(([kind, opaque, label]) => {
            const ref = buildMentionRefForKindV1(kind, opaque);
            return { kind, ref, label, token: formatInlineReferenceTokenV1({ label, ref }) };
        });
        const contributed = buildComposerReferenceMentionPayloadV1({ reference: { pluginId: 'example.issues', localId: 'issues' },
            candidate: { id: 'issue-42', label: 'Issue #42' } });
        mentions.push({ ...contributed, token: formatInlineReferenceTokenV1({ label: contributed.label!, ref: contributed.ref }) });
        const text = mentions.map(mention => mention.token).join(' ');
        const projection = resolveMessageStructuredReferences({ text, meta: metaWithMentions(mentions) });
        expect([...projection.inline.values()].map(({ label, glyph }) => [label, glyph])).toEqual([
            ['components/', 'file'], ['Auth fix', 'conversations'], ['review', 'terminal'], ['Inspector', 'settings'],
            ['Release', 'action'], ['Overview', 'board'], ['Issue #42', 'mention'],
        ]);
        expect(projection.row).toEqual([]);
    });

    it('binds inline tokens to typed records, excludes their paths from the legacy scan, and deduplicates the row', () => {
        const ref = buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/@notes/a.ts');
        const token = `[a.ts](happier-ref:${ref})`;
        const result = resolveMessageStructuredReferences({
            text: `Open ${token}, then @src/@notes/a.ts and @README.md`,
            meta: metaWithMentions([{ ...fileMention('src/@notes/a.ts', token), label: 'a.ts' }]),
        });
        expect(result.inline.get(ref)).toMatchObject({ ref, kind: MENTION_KIND_V1.file, label: 'a.ts', path: 'src/@notes/a.ts' });
        expect(result.row).toEqual([{ kind: 'file', path: 'README.md' }]);
        expect(resolveMessageStructuredReferences({ text: token, meta: undefined }).inline.size).toBe(0);
        expect(resolveMessageStructuredReferences({ text: token, meta: undefined }).row).toEqual([]);
    });

    it('numbers only images by attachment order and binds them by id', () => {
        const result = resolveMessageStructuredReferences({
            text: '[second](happier-ref:attachment:b) [first](happier-ref:attachment:a) [doc](happier-ref:attachment:c)',
            meta: { happier: { kind: 'attachments.v1', payload: { attachments: [
                { id: 'a', name: 'a.png', path: '/a.png', mimeType: 'image/png', sizeBytes: 1 },
                { id: 'c', name: 'notes.txt', path: '/notes.txt', mimeType: 'text/plain', sizeBytes: 2 },
                { id: 'b', name: 'b.png', path: '/b.png', mimeType: 'image/png', sizeBytes: 3 },
            ] } } },
        });
        expect(result.inline.get('attachment:b')).toMatchObject({ label: 'Image #2', imageNumber: 2, attachmentId: 'b' });
        expect(result.inline.get('attachment:a')).toMatchObject({ label: 'Image #1', imageNumber: 1 });
        expect(result.inline.get('attachment:c')).toMatchObject({ label: 'notes.txt' });
        expect(result.row).toEqual([]);
    });

    it('uses the message image order for SessionMedia-backed plugin pictures and upload pictures', () => {
        const result = resolveMessageStructuredReferences({
            text: '[upload](happier-ref:attachment:upload) [camera](happier-ref:attachment:camera)',
            meta: {
                happier: { kind: 'session_media.v1', payload: { media: [{ id: 'm1', role: 'input', category: 'attachment',
                    mediaKind: 'image', mimeType: 'image/png', name: 'camera.png', path: '.happier/uploads/camera.png',
                    sizeBytes: 42, origin: { source: 'user-upload' } }] } },
                happierAttachments: { kind: 'attachments.v1', payload: { attachments: [
                    { id: 'upload', name: 'upload.png', path: '/upload.png', mimeType: 'image/png', sizeBytes: 1 },
                ] } },
                happierStructuredInputV1: { v: 1, composerAttachments: [{ v: 1, instanceId: 'camera',
                    attachment: { pluginId: 'example.camera', localId: 'capture' }, key: 'camera', value: {},
                    presentation: { label: 'Camera', typeLabel: 'Picture' }, content: { kind: 'sessionMedia', mediaId: 'm1' } }],
                    imageInputs: [{ id: 'upload', kind: 'localImage', path: '/upload.png' }],
                },
            },
        });
        expect(result.inline.get('attachment:camera')).toMatchObject({ label: 'Image #2', imageNumber: 2, mediaId: 'm1' });
        expect(result.inline.get('attachment:upload')).toMatchObject({ label: 'Image #1', imageNumber: 1 });
    });

    it('renders a session reference only from the envelope, never from matching text (INV-5)', () => {
        const text = 'compare with @session:release-prep-a1b2c3';

        const withEnvelope = resolveMessageStructuredReferences({
            meta: metaWithMentions([sessionMention('sess_42', '@session:release-prep-a1b2c3', 'Release prep')]),
            text,
        });
        const withoutEnvelope = resolveMessageStructuredReferences({ meta: undefined, text });

        expect(withEnvelope.row).toEqual([
            { kind: 'session', sessionId: 'sess_42', label: 'Release prep' },
        ]);
        // Identical text, no envelope entry: plain text. This is the whole point of INV-5 —
        // an agent that merely writes a session-looking token cannot manufacture a link.
        expect(withoutEnvelope.row).toEqual([]);
    });

    it('renders a quoted file token the legacy text scan cannot parse', () => {
        const text = 'open @"my file.ts" please';

        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([fileMention('my file.ts', '@"my file.ts"')]),
            text,
        });

        expect(references.row).toEqual([{ kind: 'file', path: 'my file.ts' }]);
        expect(resolveMessageStructuredReferences({ meta: undefined, text }).row).toEqual([]);
    });

    it('keeps the legacy text scan for files so pre-envelope messages still render', () => {
        expect(resolveMessageStructuredReferences({
            meta: undefined,
            text: 'see @src/api.ts and @README.md',
        }).row).toEqual([
            { kind: 'file', path: 'src/api.ts' },
            { kind: 'file', path: 'README.md' },
        ]);
    });

    it('collapses an envelope file reference and its text-scan twin into one chip', () => {
        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([fileMention('src/api.ts', '@src/api.ts')]),
            text: 'see @src/api.ts twice: @src/api.ts',
        });

        expect(references.row).toEqual([{ kind: 'file', path: 'src/api.ts' }]);
    });

    it('leaves a well-formed unknown kind inert and never reinterprets it as a known one', () => {
        const references = resolveMessageStructuredReferences({
            meta: metaWithMentions([
                { kind: 'acme.ticket', ref: 'session:sess_42', token: '@acme:1' },
                sessionMention('sess_real', '@session:real'),
            ]),
            text: '@acme:1 @session:real',
        });

        expect(references.row).toEqual([{ kind: 'session', sessionId: 'sess_real', label: null }]);
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

        expect(references.row).toEqual([]);
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

        expect(references.row).toEqual([{ kind: 'session', sessionId: 'sess_ok', label: null }]);
    });
    it("never lists the transcript's own Session in the reference row, and leaves every other reference alone", () => {
        const meta = metaWithMentions([
            sessionMention('sess_receiver', '@Session "Receiver"', 'Receiver'),
            sessionMention('sess_peer', '@Session "Peer"', 'Peer'),
            fileMention('src/a.ts', '@src/a.ts'),
        ]);
        const text = 'Ready; @Session "Peer" checked @src/a.ts.';
        expect(resolveMessageStructuredReferences({ meta, text, ownSessionId: 'sess_receiver' }).row).toEqual([
            { kind: 'session', sessionId: 'sess_peer', label: 'Peer' }, { kind: 'file', path: 'src/a.ts' },
        ]);
        // Another transcript (or a caller with no transcript) still shows the receiver: the stored identity is untouched.
        expect(resolveMessageStructuredReferences({ meta, text, ownSessionId: 'sess_other' }).row.map(reference => reference.kind === 'session' ? reference.sessionId : reference.path))
            .toEqual(['sess_receiver', 'sess_peer', 'src/a.ts']);
        expect(resolveMessageStructuredReferences({ meta: metaWithMentions([sessionMention('sess_receiver', '@self')]), text: '@self',
            ownSessionId: 'sess_receiver' }).row).toEqual([]);
    });
});
