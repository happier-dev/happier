import { describe, expect, it } from 'vitest';

import { initialMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';

describe('initialMachineMetadata', () => {
  it('advertises daemon-owned runtime control capabilities', () => {
    expect(initialMachineMetadata.daemonTerminalSessionAttachSupported).toBe(true);
    expect(initialMachineMetadata.daemonSessionGoalControlsSupported).toBe(true);
  });

  it('refreshes older persisted metadata without dropping user-owned fields', () => {
    const current = {
      ...initialMachineMetadata,
      displayName: 'Build box',
      daemonTerminalSessionAttachSupported: undefined,
      daemonSessionGoalControlsSupported: undefined,
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, current.host)).toMatchObject({
      displayName: 'Build box',
      daemonTerminalSessionAttachSupported: true,
      daemonSessionGoalControlsSupported: true,
    });
  });

  it('returns the existing metadata object when every daemon-owned field is current', () => {
    const current = {
      ...initialMachineMetadata,
      displayName: 'Build box',
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, current.host)).toBe(current);
  });
});
