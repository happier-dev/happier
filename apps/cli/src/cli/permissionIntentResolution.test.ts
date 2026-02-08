import { describe, expect, it } from 'vitest';

import { resolveLatestPermissionIntent } from '@happier-dev/agents';

describe('resolveLatestPermissionIntent', () => {
  it('returns null when no candidates are valid', () => {
    expect(resolveLatestPermissionIntent([])).toBe(null);
    expect(resolveLatestPermissionIntent([{ rawMode: null, updatedAt: 10 }])).toBe(null);
  });

  it('prefers the newest updatedAt across sources', () => {
    const resolved = resolveLatestPermissionIntent([
      { rawMode: 'read-only', updatedAt: 100 },
      { rawMode: 'bypassPermissions', updatedAt: 200 }, // legacy token -> yolo intent
      { rawMode: 'default', updatedAt: 150 },
    ]);
    expect(resolved).toEqual({ intent: 'yolo', updatedAt: 200 });
  });

  it('keeps first valid candidate when updatedAt timestamps tie', () => {
    const resolved = resolveLatestPermissionIntent([
      { rawMode: 'read-only', updatedAt: 200 },
      { rawMode: 'yolo', updatedAt: 200 },
    ]);
    expect(resolved).toEqual({ intent: 'read-only', updatedAt: 200 });
  });

  it('ignores non-finite timestamps even when mode token is valid', () => {
    const resolved = resolveLatestPermissionIntent([
      { rawMode: 'yolo', updatedAt: Number.NaN },
      { rawMode: 'default', updatedAt: Number.POSITIVE_INFINITY },
      { rawMode: 'read-only', updatedAt: 10 },
    ]);
    expect(resolved).toEqual({ intent: 'read-only', updatedAt: 10 });
  });
});
