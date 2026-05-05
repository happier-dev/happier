import { describe, expect, it } from 'vitest';

import {
  formatReleaseChannel,
  publicLabelToRing,
  ringToPublicLabel,
} from './releaseChannel';

describe('ringToPublicLabel', () => {
  it('maps publicdev to dev', () => {
    expect(ringToPublicLabel('publicdev')).toBe('dev');
  });

  it('maps stable/preview identity', () => {
    expect(ringToPublicLabel('stable')).toBe('stable');
    expect(ringToPublicLabel('preview')).toBe('preview');
  });

  it('maps internal rings to their public label', () => {
    expect(ringToPublicLabel('internaldev')).toBe('dev');
    expect(ringToPublicLabel('internalpreview')).toBe('preview');
  });
});

describe('publicLabelToRing', () => {
  it('normalises dev to publicdev', () => {
    expect(publicLabelToRing('dev')).toBe('publicdev');
  });

  it('returns empty string for unknown values', () => {
    expect(publicLabelToRing('nonsense')).toBe('');
    expect(publicLabelToRing('')).toBe('');
  });
});

describe('formatReleaseChannel', () => {
  it('renders publicdev as dev label', () => {
    const out = formatReleaseChannel('publicdev');
    expect(out).toContain('dev');
    expect(out).not.toContain('publicdev');
  });

  it('renders dev alias correctly', () => {
    expect(formatReleaseChannel('dev', { colored: false })).toBe('dev');
  });

  it('renders stable/preview labels colored', () => {
    expect(formatReleaseChannel('stable', { colored: false })).toBe('stable');
    expect(formatReleaseChannel('preview', { colored: false })).toBe('preview');
  });

  it('returns unknown input verbatim', () => {
    expect(formatReleaseChannel('weird-value', { colored: false })).toBe('weird-value');
  });

  it('returns empty input verbatim', () => {
    expect(formatReleaseChannel('', { colored: false })).toBe('');
  });

  it('colored output still contains the label text', () => {
    // In TTY environments chalk adds ANSI escapes; in CI/non-TTY it emits
    // the bare string. Both are valid — the contract is "contains label".
    expect(formatReleaseChannel('dev')).toContain('dev');
    expect(formatReleaseChannel('stable')).toContain('stable');
    expect(formatReleaseChannel('preview')).toContain('preview');
  });
});
