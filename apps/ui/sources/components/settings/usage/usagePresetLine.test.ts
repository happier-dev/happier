import { describe, expect, it } from 'vitest';
import { resolveUsagePresetLine } from './usagePresetLine';

const surface = { kind: 'core', id: 'usage.overview' } as never;
const tab = { id: 'overview', name: 'Overview', isPreset: true, edited: true };

describe('the "… is yours now" line', () => {
  it('shows on first paint from the view list\'s local edited fact, before the layout read answers (R139)', () => {
    expect(resolveUsagePresetLine(null, tab, surface)).toEqual({
      preset: { id: 'overview', name: 'Overview', isEdited: true, changes: [] }, surface,
    });
    // An unedited view, a personal view, or no known surface says nothing yet.
    expect(resolveUsagePresetLine(null, { ...tab, edited: false }, surface)).toBeNull();
    expect(resolveUsagePresetLine(null, { ...tab, isPreset: false }, surface)).toBeNull();
    expect(resolveUsagePresetLine(null, tab, undefined)).toBeNull();
  });
  it('follows the read layout\'s own preset once it answers', () => {
    const preset = { id: 'overview', name: 'Overview', isEdited: true, changes: [] };
    expect(resolveUsagePresetLine({ preset, surface }, tab, undefined)).toEqual({ preset, surface });
    expect(resolveUsagePresetLine({ preset: { ...preset, isEdited: false }, surface }, tab, surface)).toBeNull();
  });
});
