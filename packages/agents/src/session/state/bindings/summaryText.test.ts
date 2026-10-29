import { describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '@happier-dev/protocol';

import {
  createSummaryTextMetadataUpdater,
  summaryTextBinding,
} from './summaryText.js';
import { createSessionStateFieldMetadataUpdater } from './publishField.js';

describe('summaryTextBinding', () => {
  it('seeds a native title once and preserves an explicit title without publishing timestamp-only changes', () => {
    const nativeTitle = createSessionStateFieldMetadataUpdater('display.title', {
      title: 'Request to Reply OK', updatedAt: 200, staleBehavior: 'drop', preserveExistingValue: true,
    });
    const seeded = nativeTitle({});
    expect(seeded).toEqual({ summary: { text: 'Request to Reply OK', updatedAt: 200 } });
    expect(nativeTitle(seeded)).toBe(seeded);
    const renamed = createSessionStateFieldMetadataUpdater('display.title', {
      title: 'My chosen title', updatedAt: 300,
    })(seeded);
    const laterNativeTitle = createSessionStateFieldMetadataUpdater('display.title', {
      title: 'Later native title', updatedAt: 400, staleBehavior: 'drop', preserveExistingValue: true,
    });
    expect(laterNativeTitle(renamed)).toBe(renamed);
    expect(renamed).toEqual({ summary: { text: 'My chosen title', updatedAt: 300 } });
  });

  describe.each(['binding', 'metadata updater'] as const)('zero-time title arbitration through %s', (entryPoint) => {
    const writeTitle = (metadata: SessionMetadata) => entryPoint === 'binding'
      ? summaryTextBinding.write(metadata, {
        value: { title: 'Older zero-time title', updatedAt: 0, staleBehavior: 'drop' },
      })
      : createSummaryTextMetadataUpdater({
        title: 'Older zero-time title', updatedAt: 0, staleBehavior: 'drop',
      })(metadata);

    it.each([
      { name: 'missing timestamp', summary: { text: 'Retained title' } },
      { name: 'non-finite timestamp', summary: { text: 'Retained title', updatedAt: Number.NaN } },
      { name: 'empty title text', summary: { text: '' } },
      { name: 'stored zero timestamp', summary: { text: 'Retained title', updatedAt: 0 } },
      { name: 'newer timestamp', summary: { text: 'Retained title', updatedAt: 1 } },
    ])('preserves a present title with $name', ({ summary }) => {
      const metadata = { summary };
      expect(writeTitle(metadata)).toBe(metadata);
    });

    it('accepts the first zero-time title when title text is absent', () => {
      expect(writeTitle({})).toEqual({
        summary: { text: 'Older zero-time title', updatedAt: 0 },
      });
    });
  });

  it('reads display.title from metadata summary text', () => {
    expect(summaryTextBinding.read({
      summary: {
        text: 'Existing title',
        updatedAt: 42,
      },
    })).toEqual({
      value: 'Existing title',
      updatedAt: 42,
    });
  });

  it('writes display.title without adding a new metadata key', () => {
    const metadata = summaryTextBinding.write(
      {
        existing: 'keep',
        summary: {
          text: 'Old',
          updatedAt: 100,
          provider: 'codex',
        },
      },
      { value: 'Renamed', updatedAt: 123 },
    );

    expect(metadata).toEqual({
      existing: 'keep',
      summary: {
        text: 'Renamed',
        updatedAt: 123,
        provider: 'codex',
      },
    });
    expect(metadata).not.toHaveProperty('title');
  });

  it('drops stale provider title candidates by default', () => {
    const updater = createSummaryTextMetadataUpdater({
      title: 'Provider stale',
      updatedAt: 4,
    });

    expect(updater({
      summary: {
        text: 'Current',
        updatedAt: 5,
      },
    })).toEqual({
      summary: {
        text: 'Current',
        updatedAt: 5,
      },
    });
  });

  it.each(['plain', 'timestamped'] as const)('bumps a stale manual title through the %s field binding', shape => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    try {
      const updater = createSessionStateFieldMetadataUpdater('display.title', shape === 'plain'
        ? 'Manual rename' : { title: 'Manual rename', updatedAt: 10 });
      const current = { summary: { text: 'Current', updatedAt: 20 } };
      const renamed = updater(current);
      expect(renamed).toEqual({ summary: { text: 'Manual rename', updatedAt: 21 } });
      expect(updater(renamed)).toBe(renamed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bumps explicit local title writes when the candidate timestamp is stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10));

    try {
      const updater = createSummaryTextMetadataUpdater({
        title: 'Local rename',
        staleBehavior: 'bump-if-value-changed',
      });

      expect(updater({
        summary: {
          text: 'Current',
          updatedAt: 20,
        },
      })).toEqual({
        summary: {
          text: 'Local rename',
          updatedAt: 21,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is available through the generic session state field updater', () => {
    const updater = createSessionStateFieldMetadataUpdater('display.title', 'Generic title');

    expect(updater({})).toEqual({
      summary: {
        text: 'Generic title',
        updatedAt: expect.any(Number),
      },
    });
  });
});
