import { describe, expect, it } from 'vitest';

import {
  TranscriptAnnotationV1Schema,
  buildTranscriptAnnotationPresentationV1,
} from './transcriptAnnotation.js';
import {
  MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
  MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
  ComposerAttachmentAuthorPresentationV1Schema,
} from '../../runtime/input/composerAttachmentV1.js';

const source = { kind: 'session' as const, session: { serverId: 'server-1', sessionId: 'session-1' }, messageId: 'message-1' };

describe('transcript annotation value', () => {
  it('keeps quote whitespace and requires a closed committed source with nonblank quote and note', () => {
    const value = { quote: '  a passage\n  ', note: ' a note ', source };
    expect(TranscriptAnnotationV1Schema.parse(value)).toEqual(value);
    for (const invalid of [
      { ...value, quote: '\n\t' }, { ...value, note: ' ' },
      { ...value, extra: true }, { ...value, source: { ...source, localId: 'pending' } },
      { ...value, source: { ...source, session: { ...source.session, extra: true } } },
    ]) expect(TranscriptAnnotationV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('projects bounded display excerpts and retains the exact source without altering full content', () => {
    const value = TranscriptAnnotationV1Schema.parse({ quote: `  ${'😀'.repeat(400)}\n `, note: ` ${'🌿'.repeat(800)} `, source });
    const presentation = buildTranscriptAnnotationPresentationV1(value);
    expect(Array.from(presentation.label)).toHaveLength(MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1);
    expect(Array.from(presentation.description)).toHaveLength(MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1);
    expect(presentation.source).toEqual(source);
    expect(presentation.label).not.toContain('\ufffd');
    expect(value.quote).toBe(`  ${'😀'.repeat(400)}\n `);
    expect(buildTranscriptAnnotationPresentationV1({ quote: '  first\nsecond  ', note: ' note ', source }))
      .toEqual({ label: 'first second', description: 'note', source });
  });

  it('keeps excerpts admissible when the display boundary falls on whitespace', () => {
    const presentation = buildTranscriptAnnotationPresentationV1({
      quote: `${'q'.repeat(MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 - 1)} next`,
      note: `${'n'.repeat(MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1 - 1)} next`, source,
    });
    expect(ComposerAttachmentAuthorPresentationV1Schema.safeParse(presentation).success).toBe(true);
  });
});
