import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tracking: {
    capture: vi.fn(),
    identify: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/track', () => ({
  tracking: mocks.tracking,
  getTrackingAnonymousUserId: () => 'anon-user',
}));

import {
  localSettingsDefaults,
  type LocalSettings,
} from '@/sync/domains/settings/localSettings';

import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';
import { emitLocalSettingChangedEvents } from './emitSettingChangedEvent';

// Layout state the app writes as people collapse the sidebar or drag a pane edge is not a
// deliberate setting: it is neither a device_user property nor a setting_changed event.
const LOCAL_UI_STATE: Partial<LocalSettings> = {
  sidebarCollapsed: true,
  newSessionDockedWidthPx: 500,
};

function propertyNamesFor(
  properties: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  return Object.keys(properties).filter((name) =>
    keys.some(
      (key) =>
        name === `local_setting__${key}` ||
        name.startsWith(`local_setting__${key}__`),
    ),
  );
}

describe('UI-state local settings are not analytics settings', () => {
  beforeEach(() => {
    mocks.tracking.capture.mockReset();
  });

  it('leaves layout state out of the device_user snapshot', () => {
    const snapshot = buildLocalSettingsSnapshot({
      ...localSettingsDefaults,
      ...LOCAL_UI_STATE,
    });

    expect(
      propertyNamesFor(snapshot.properties, Object.keys(LOCAL_UI_STATE)),
    ).toEqual([]);
    expect(snapshot.properties.local_setting__themePreference).toBeDefined();
  });

  it('sends 0 setting_changed events for layout state and 1 for a deliberate local setting', () => {
    emitLocalSettingChangedEvents({
      previousSettings: localSettingsDefaults,
      nextSettings: { ...localSettingsDefaults, ...LOCAL_UI_STATE },
      source: 'ui',
    });
    expect(mocks.tracking.capture).toHaveBeenCalledTimes(0);

    emitLocalSettingChangedEvents({
      previousSettings: localSettingsDefaults,
      nextSettings: { ...localSettingsDefaults, themePreference: 'dark' },
      source: 'ui',
    });
    expect(mocks.tracking.capture).toHaveBeenCalledTimes(1);
    expect(mocks.tracking.capture).toHaveBeenCalledWith(
      'setting_changed',
      expect.objectContaining({ setting_key: 'themePreference' }),
    );
  });
});
