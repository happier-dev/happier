import { describe, expect, it } from 'vitest';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { AttachmentDraft } from './attachmentDraftModel';
import { appendPictureStepNotes } from './pictureStepNotes';

const picture = (
  id: string,
  document?: ImageMarksDocumentV1,
  browser = false,
): AttachmentDraft => {
  const source = {
    kind: 'memory' as const,
    name: `${id}.png`,
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    previewUri: 'data:image/png;base64,AQ==',
  };
  return {
    id,
    source,
    status: 'pending',
    ...(document ? { edit: { original: source, document } } : {}),
    ...(browser && document
      ? {
          browserAnnotation: { annotationId: `a-${id}`, image: document.image },
        }
      : {}),
  };
};
const marked = (
  notes: readonly (string | undefined)[],
): ImageMarksDocumentV1 => ({
  v: 1,
  image: { width: 10, height: 10, scale: 1 },
  marks: notes.map((note, index) => ({
    id: `s${index}`,
    kind: 'step',
    at: { x: index, y: 1 },
    color: 'red',
    size: 'm',
    ...(note ? { note } : {}),
  })),
});

describe('picture numbered comments on send', () => {
  it('sends each noted picture as [Image #N] and its numbered list after the person text, and nothing else', () => {
    const drafts = [
      picture('plain'),
      picture('bare', marked([undefined])),
      picture('noted', marked(['Steer here', undefined])),
      picture('browser', marked(['Already in the marks document']), true),
    ];
    expect(appendPictureStepNotes('Enter should queue.  ', drafts)).toBe(
      'Enter should queue.\n\nNumbered marks on [Image #3]:\n1. Steer here\n2. (no note)',
    );
    expect(
      appendPictureStepNotes('', [picture('noted', marked(['Only this']))]),
    ).toBe('Numbered marks on [Image #1]:\n1. Only this');
    expect(
      appendPictureStepNotes('Unchanged', [
        picture('plain'),
        picture('bare', marked([undefined])),
      ]),
    ).toBe('Unchanged');
  });
});
