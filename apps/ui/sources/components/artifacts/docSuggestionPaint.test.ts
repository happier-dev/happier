import { describe, expect, it } from 'vitest';

import { planDocSuggestionPaint } from './docSuggestionPaint';

const doc = [
  '# Payment retries',
  '',
  'Check the dashboard first. A replay shows two rows with the **same** key.',
  '',
  '- Escalate to on-call',
  '- Write it down',
  '',
  'Close the incident when the queue drains.',
].join('\n');

function at(quote: string) {
  const start = doc.indexOf(quote);
  return { start, end: start + quote.length };
}

describe('planDocSuggestionPaint', () => {
  it('paints a suggestion in its paragraph and keeps the rest of the Doc as its own source', () => {
    const plan = planDocSuggestionPaint({
      markdown: doc,
      suggestions: [
        {
          id: 't1',
          range: at('A replay shows two rows'),
          after: 'A replay shows one row',
        },
      ],
    });
    expect(plan?.painted.has('t1')).toBe(true);
    const kinds = plan?.segments.map((segment) => segment.kind);
    expect(kinds).toEqual(['prose', 'suggestion', 'prose']);
    // Every prose segment is the Doc's own bytes at its own offset, so passages keep their positions.
    for (const segment of plan?.segments ?? []) {
      if (segment.kind === 'prose')
        expect(
          doc.slice(segment.start, segment.start + segment.markdown.length),
        ).toBe(segment.markdown);
    }
    const painted = plan?.segments.find(
      (segment) => segment.kind === 'suggestion',
    );
    expect(painted).toMatchObject({
      id: 't1',
      before:
        'Check the dashboard first. A replay shows two rows with the same key.',
      after:
        'Check the dashboard first. A replay shows one row with the same key.',
    });
  });

  it('leaves a suggestion on a heading or a list to its card', () => {
    expect(
      planDocSuggestionPaint({
        markdown: doc,
        suggestions: [
          { id: 'h', range: at('Payment retries'), after: 'Retries' },
        ],
      }),
    ).toBeNull();
    expect(
      planDocSuggestionPaint({
        markdown: doc,
        suggestions: [
          { id: 'l', range: at('Escalate to on-call'), after: 'Page on-call' },
        ],
      }),
    ).toBeNull();
  });

  it('paints two suggestions in different paragraphs and only the first of two in one paragraph', () => {
    const plan = planDocSuggestionPaint({
      markdown: doc,
      suggestions: [
        { id: 'b', range: at('queue drains'), after: 'queue is empty' },
        {
          id: 'a',
          range: at('Check the dashboard'),
          after: 'Open the dashboard',
        },
        { id: 'a2', range: at('same'), after: 'identical' },
      ],
    });
    expect([...(plan?.painted ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('paints nothing for a range outside the source', () => {
    expect(
      planDocSuggestionPaint({
        markdown: doc,
        suggestions: [
          {
            id: 'x',
            range: { start: doc.length, end: doc.length + 4 },
            after: 'x',
          },
        ],
      }),
    ).toBeNull();
  });
});
