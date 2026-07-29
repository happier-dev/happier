import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  impactAsync: vi.fn(async () => { throw new Error('haptics_unavailable'); }),
  notificationAsync: vi.fn(async () => { throw new Error('haptics_unavailable'); }),
}));

vi.mock('expo-haptics', () => ({
  impactAsync: state.impactAsync,
  notificationAsync: state.notificationAsync,
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Error: 'Error' },
}));

describe('haptics', () => {
  it('keeps optional native feedback fail-safe when the platform module rejects', async () => {
    const { hapticsError, hapticsLight } = await import('./haptics');
    await expect(hapticsLight()).resolves.toBeUndefined();
    await expect(hapticsError()).resolves.toBeUndefined();
  });
});
