import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from './storageStore';
import {
  clearPersistenceStorage,
  getPersistenceStorage,
} from './persistenceStorage';
import {
  readServicesColumnGrouping,
  setServicesColumnGrouping,
  useServicesColumnGrouping,
} from './servicesColumnUiState';

afterEach(() => {
  standardCleanup();
  clearPersistenceStorage();
});

describe('Services column grouping (owner 2026-11-16: per-device view state, never Account settings)', () => {
  it("starts By project and keeps the person's choice on this device, outside Account settings", async () => {
    const settingsBefore = getStorage().getState().settings;
    const hook = await renderHook(() => useServicesColumnGrouping());
    expect(hook.getCurrent()).toBe('project');
    await act(async () => {
      setServicesColumnGrouping('type');
    });
    expect(hook.getCurrent()).toBe('type');
    expect(readServicesColumnGrouping()).toBe('type');
    // Stored in the device KV owner, not the settings blob.
    expect(
      getPersistenceStorage()
        .getAllKeys()
        .some((key) => key.includes('services-column')),
    ).toBe(true);
    expect(getStorage().getState().settings).toBe(settingsBefore);
  });

  it('reads an unknown stored value as By project', () => {
    expect(readServicesColumnGrouping()).toBe('project');
  });
});
