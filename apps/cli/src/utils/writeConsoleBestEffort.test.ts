import { describe, expect, it } from 'vitest';

import { shouldInstallConsoleWriteErrorGuards } from './writeConsoleBestEffort';

describe('shouldInstallConsoleWriteErrorGuards', () => {
  it('disables console stream guards under Bun runtimes', () => {
    expect(shouldInstallConsoleWriteErrorGuards({ processVersions: { bun: '1.3.5' } })).toBe(false);
  });

  it('keeps console stream guards enabled under Node runtimes', () => {
    expect(shouldInstallConsoleWriteErrorGuards({ processVersions: { node: '24.1.0' } })).toBe(true);
  });
});
