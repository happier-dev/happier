import { describe, expect, it } from 'vitest';

import { hasSessionTitleInMetadata, readSessionTitleInMetadata } from './sessionTitle';

describe('Session title metadata', () => {
  it('reads the current title before a retained name and preserves authored spelling', () => {
    const metadata = { summary: { text: '  Second notes: KEEP This Name  ' }, name: 'Old name' };
    expect(readSessionTitleInMetadata(metadata)).toBe('Second notes: KEEP This Name');
    expect(hasSessionTitleInMetadata(metadata)).toBe(true);
    expect(readSessionTitleInMetadata({ summary: { text: ' ' }, name: 'Retained name' })).toBe('Retained name');
  });

  it('does not promote display projections or folders into authored titles', () => {
    for (const metadata of [null, {}, { summaryText: 'A transient dictated request', path: '/project' }]) {
      expect(readSessionTitleInMetadata(metadata)).toBeNull();
      expect(hasSessionTitleInMetadata(metadata)).toBe(false);
    }
  });
});
