import { describe, expect, it } from 'vitest';

import { HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS } from '@happier-dev/agents';
import {
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  buildMentionRefForKindV1,
  type MentionRefV1,
} from '@happier-dev/protocol';

import { buildSessionReferenceContextBlockForDispatch } from './sessionReferenceBlock';

const mention: MentionRefV1 = {
  kind: MENTION_KIND_V1.session,
  ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
  token: '@session:source',
  start: 0,
  end: 15,
};

describe('buildSessionReferenceContextBlockForDispatch', () => {
  it('projects a Session identity and tool hint without transcript context', () => {
    const block = buildSessionReferenceContextBlockForDispatch([{
      ...mention,
      label: 'Old title at insertion time',
    }]);

    expect(block).toContain('<happier_session_reference>');
    expect(block).toContain('</happier_session_reference>');
    expect(block).toContain('source-session');
    expect(block).toContain('Old title at insertion time');
    expect(block).toContain('tools may be available');
    expect(block).toContain('No transcript content is included');
    expect(block).not.toContain('<happier_session_reference_context');
  });

  it('states an unreadable Session reference without guessing an identity', () => {
    const block = buildSessionReferenceContextBlockForDispatch([{
      ...mention,
      ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://gmail@happier'),
    }]);

    expect(block).toMatch(/could not be read/);
    expect(block).not.toContain('gmail');
    expect(block).not.toMatch(/session_id=/);
  });

  it('deduplicates Session identities by reference in first-occurrence order', () => {
    const block = buildSessionReferenceContextBlockForDispatch([
      { ...mention, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'one'), token: '@session:one', start: 0, end: 12 },
      { ...mention, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'two'), token: '@session:two', start: 13, end: 25 },
      { ...mention, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'one'), token: '@session:one', start: 26, end: 38 },
    ]);

    expect(block.match(/session_id="one"/g)).toHaveLength(1);
    expect(block.indexOf('session_id="one"')).toBeLessThan(block.indexOf('session_id="two"'));
  });

  it('stays within the Session block budget and says when it omitted references', () => {
    const block = buildSessionReferenceContextBlockForDispatch(Array.from({ length: 64 }, (_, index) => ({
      ...mention,
      ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, `${'s'.repeat(40)}${index}`),
      token: `@session:${index}`,
      start: index * 30,
      end: index * 30 + 20,
      label: 'A title that occupies the bounded Session reference projection'.repeat(2),
    })));

    expect(Array.from(block).length).toBeLessThanOrEqual(MENTION_BOUNDS.maxReferenceBlockChars);
    expect(block).toMatch(/omitted to stay within the reference budget/);
    expect(block.endsWith('</happier_session_reference>')).toBe(true);
  });

  /**
   * The same block is composed into the replay-seed prompt at dispatch, and the
   * seed was built earlier against a reservation of exactly this block's bound
   * (`HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS`). That reservation is
   * denominated in UTF-16 code units, because that is the unit the replay budget
   * measures and slices with. So the block has to fit the reservation in THAT
   * unit, not only in code points — one astral character costs two of them, and
   * a block bounded only by code points can cost up to twice what was reserved.
   * The dispatch refit, designed to be a no-op, would then delete transcript
   * lines the seed was entitled to.
   */
  it('fits the replay-seed dispatch reservation when labels carry astral characters', () => {
    const block = buildSessionReferenceContextBlockForDispatch(Array.from({ length: 64 }, (_, index) => ({
      ...mention,
      ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, `${'s'.repeat(40)}${index}`),
      token: `@session:${index}`,
      start: index * 30,
      end: index * 30 + 20,
      // 128 code points / 256 UTF-16 code units: the largest label the mention
      // schema admits, made entirely of astral characters.
      label: '\u{1F680}'.repeat(128),
    })));

    expect(block).toContain('\u{1F680}');
    expect(block.length).toBeLessThanOrEqual(HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS - 2);
    // The code-point contract the mention domain states still holds: UTF-16
    // length dominates code-point length, so bounding by it satisfies both.
    expect(Array.from(block).length).toBeLessThanOrEqual(MENTION_BOUNDS.maxReferenceBlockChars);
    expect(block).toMatch(/omitted to stay within the reference budget/);
  });

  it('returns an empty block when no Session reference is present', () => {
    expect(buildSessionReferenceContextBlockForDispatch([])).toBe('');
    expect(buildSessionReferenceContextBlockForDispatch([{
      ...mention,
      kind: MENTION_KIND_V1.file,
      ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/index.ts'),
      token: '@src/index.ts',
      start: 0,
      end: 13,
    }])).toBe('');
  });
});
