import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { resolveHappierPopoverPlacement } from '@happier-dev/plugin-ui/presentation';

const { useAgentInputPopoverLayout } =
  await import('./useAgentInputPopoverLayout');

describe('useAgentInputPopoverLayout anchor', () => {
  it("hangs a form field's picker below its field and keeps a composer chip's above it, each flipping when its side lacks room", async () => {
    const field = await renderHook(() =>
      useAgentInputPopoverLayout({ open: true, anchor: 'field' }),
    );
    const chip = await renderHook(() =>
      useAgentInputPopoverLayout({ open: true }),
    );
    expect(field.getCurrent()).toMatchObject({
      placement: 'bottom',
      flip: true,
    });
    expect(chip.getCurrent()).toMatchObject({ placement: 'top', flip: true });
    await field.unmount();
    await chip.unmount();
  });

  it("opens a chip's popover on the side that holds its designed height, else the roomier side", async () => {
    const layout = await renderHook(() =>
      useAgentInputPopoverLayout({ open: true, maxHeightCap: 640 }),
    );
    const side = (top: number, bottom: number) => resolveHappierPopoverPlacement({
      placement: layout.getCurrent().placement,
      preferredMinAvailable: layout.getCurrent().placementMinSpace ?? 0,
      flip: layout.getCurrent().flip,
      available: { top, bottom, left: 0, right: 0 },
    });
    // A composer high on its page (bulk compose, New Session): 330 above clips a 640 picker, 500 below holds more.
    expect(side(330, 500)).toBe('bottom');
    // The docked composer at the window's foot keeps opening above it.
    expect(side(700, 40)).toBe('top');
    expect(side(400, 300)).toBe('top');
    await layout.unmount();
  });
});
