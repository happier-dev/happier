import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

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
});
