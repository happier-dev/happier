import { describe, expect, it } from 'vitest';

import { SCRIM_RAMP_UNDERLAP } from '@/components/ui/overlays/progressiveScrimFalloff';

import { resolveDockedBandGeometry } from './dockedBandGeometry';

/** How far the band's top stands above the top of the docked stack (its header line, or a template header). */
function riseAboveStack(
  geometry: ReturnType<typeof resolveDockedBandGeometry>,
): number {
  return geometry.rampHeight - SCRIM_RAMP_UNDERLAP - geometry.seatTop;
}

describe('the docked new-session band (owner 2026-11-11, item 20)', () => {
  it('dissolves upward from the top of the docked stack over the same short ramp as a phone, on a desktop', () => {
    const desktop = resolveDockedBandGeometry({ phone: false, cardTop: 44 });
    const phone = resolveDockedBandGeometry({ phone: true, cardTop: 44 });
    // One rule: the same short ramp on every width, no fixed tall desktop band reaching over the page above.
    expect(desktop.rampHeight).toBe(phone.rampHeight);
    // A desktop band holds the whole stack (header and any template header are inside it) and starts only a
    // short dissolve above its top, so it no longer frosts the Session composer above the dock.
    expect(desktop.seatTop).toBe(0);
    expect(riseAboveStack(desktop)).toBe(
      phone.rampHeight - SCRIM_RAMP_UNDERLAP,
    );
    expect(riseAboveStack(desktop)).toBeLessThanOrEqual(100);
  });

  it('never frosts the Session composer above the dock: the dissolve fits the clearance the page leaves', () => {
    // The Session composer ends 44 above the docked stack: the band dissolves within that, not over it.
    const desktop = resolveDockedBandGeometry({ phone: false, cardTop: 44, clearanceAbove: 44 });
    expect(riseAboveStack(desktop)).toBeLessThanOrEqual(44);
    expect(riseAboveStack(desktop)).toBeGreaterThan(0);
  });

  it('seats a phone band on the card edge, as 0.2 did', () => {
    expect(
      resolveDockedBandGeometry({ phone: true, cardTop: 44 }),
    ).toMatchObject({ seatTop: 44, axes: 'top' });
    expect(
      resolveDockedBandGeometry({ phone: false, cardTop: 44 }),
    ).toMatchObject({ axes: 'centre' });
  });
});
