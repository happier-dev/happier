import { describe, expect, it } from 'vitest';

import { initialMachineMetadata } from './metadata';

describe('initialMachineMetadata', () => {
  it('positively advertises typed attached-session terminal support', () => {
    expect(initialMachineMetadata.daemonTerminalSessionAttachSupported).toBe(true);
  });
});
