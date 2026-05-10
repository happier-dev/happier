import { describe, expect, it, vi } from 'vitest';

import {
  createSummaryTextMetadataUpdater,
  summaryTextBinding,
} from './summaryText.js';
import { createSessionStateFieldMetadataUpdater } from './publishField.js';

describe('summaryTextBinding', () => {
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
