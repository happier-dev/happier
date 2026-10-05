import { describe, expect, it } from 'vitest';

import {
  HAPPIER_CARRIED_PREVIEW_OFFSET,
  resolveHappierCarriedPreviewPlacement,
  resolveHappierDropChooserSections,
  resolveHappierStagedMoveKey,
} from './dragDrop.js';

describe('resolveHappierCarriedPreviewPlacement', () => {
  const size = { width: 304, height: 96 };
  const viewport = { width: 1440, height: 900 };

  it('sits below and to the right of the pointer, so it never covers the target it points at', () => {
    const placement = resolveHappierCarriedPreviewPlacement({ pointer: { x: 300, y: 200 }, size, viewport });
    expect(placement).toEqual({
      left: 300 + HAPPIER_CARRIED_PREVIEW_OFFSET.x,
      top: 200 + HAPPIER_CARRIED_PREVIEW_OFFSET.y,
      side: 'right',
    });
  });

  it('flips to the left of the pointer near the right edge, and above it near the bottom', () => {
    const placement = resolveHappierCarriedPreviewPlacement({ pointer: { x: 1400, y: 880 }, size, viewport });
    expect(placement.side).toBe('left');
    expect(placement.left + size.width).toBeLessThanOrEqual(1400);
    expect(placement.top + size.height).toBeLessThanOrEqual(880);
  });

  it('stays inside the window when neither side fits', () => {
    const placement = resolveHappierCarriedPreviewPlacement({ pointer: { x: 150, y: 40 }, size, viewport: { width: 320, height: 200 } });
    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.left + size.width).toBeLessThanOrEqual(320);
  });
});

describe('resolveHappierDropChooserSections', () => {
  it('lists unavailable targets in their own section with the owner reason instead of hiding them', () => {
    const sections = resolveHappierDropChooserSections({
      unavailableTitle: "Can't take reports",
      options: [
        { id: 'top', label: 'Top level', current: true },
        { id: 'fix', label: 'Fix settings modal remount', detail: 'Working', group: 'happier' },
        { id: 'docs', label: 'Docs search index', detail: '2d ago', group: 'website', refusedReason: 'Shared with you read-only' },
        { id: 'relay', label: 'Relay retry with backoff', detail: 'Working · devbox', group: 'happier' },
        { id: 'acme', label: 'Onboarding email copy', group: 'happier', refusedReason: 'In Acme Studio, another Home' },
      ],
    });

    expect(sections.map((section) => section.title ?? null)).toEqual([null, 'happier', "Can't take reports"]);
    expect(sections[1]!.options.map((option) => option.id)).toEqual(['fix', 'relay']);
    expect(sections[2]!.options).toEqual([
      { id: 'docs', label: 'Docs search index', detail: 'Shared with you read-only', disabled: true, current: false },
      { id: 'acme', label: 'Onboarding email copy', detail: 'In Acme Studio, another Home', disabled: true, current: false },
    ]);
    expect(sections[0]!.options[0]).toMatchObject({ id: 'top', disabled: false, current: true });
  });

  it('omits the unavailable section when every target admits the item', () => {
    const sections = resolveHappierDropChooserSections({
      unavailableTitle: 'Unavailable',
      options: [{ id: 'a', label: 'A' }],
    });
    expect(sections).toHaveLength(1);
  });
});

describe('resolveHappierStagedMoveKey', () => {
  it('picks up on Space or Enter only while nothing is staged, ignoring key repeat', () => {
    expect(resolveHappierStagedMoveKey({ key: ' ', staged: false })).toBe('pickUp');
    expect(resolveHappierStagedMoveKey({ key: 'Enter', staged: false })).toBe('pickUp');
    expect(resolveHappierStagedMoveKey({ key: ' ', staged: false, repeat: true })).toBeNull();
    expect(resolveHappierStagedMoveKey({ key: 'ArrowDown', staged: false })).toBeNull();
    expect(resolveHappierStagedMoveKey({ key: 'Escape', staged: false })).toBeNull();
  });

  it('chooses with arrows, goes in with → and out with ←, drops with Enter and cancels with Escape', () => {
    expect(resolveHappierStagedMoveKey({ key: 'ArrowUp', staged: true })).toBe('previous');
    expect(resolveHappierStagedMoveKey({ key: 'ArrowDown', staged: true })).toBe('next');
    expect(resolveHappierStagedMoveKey({ key: 'ArrowRight', staged: true })).toBe('in');
    expect(resolveHappierStagedMoveKey({ key: 'ArrowLeft', staged: true })).toBe('out');
    expect(resolveHappierStagedMoveKey({ key: 'Enter', staged: true })).toBe('drop');
    expect(resolveHappierStagedMoveKey({ key: ' ', staged: true })).toBe('drop');
    expect(resolveHappierStagedMoveKey({ key: 'Escape', staged: true })).toBe('cancel');
    expect(resolveHappierStagedMoveKey({ key: 'Tab', staged: true })).toBeNull();
  });

  it('mirrors in and out for right-to-left layouts', () => {
    expect(resolveHappierStagedMoveKey({ key: 'ArrowLeft', staged: true, rtl: true })).toBe('in');
    expect(resolveHappierStagedMoveKey({ key: 'ArrowRight', staged: true, rtl: true })).toBe('out');
  });
});
