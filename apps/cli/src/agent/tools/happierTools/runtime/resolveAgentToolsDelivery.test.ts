import { describe, expect, it } from 'vitest';

import { resolveAgentToolsDelivery } from './resolveAgentToolsDelivery';

describe('resolveAgentToolsDelivery', () => {
  it('suppresses shell-bridge delivery when its provider-owned runtime prerequisite is unavailable', () => {
    expect(resolveAgentToolsDelivery('pi', {
      platform: 'win32',
      environmentVariables: {
        ProgramFiles: 'Z:\\missing-program-files',
        'ProgramFiles(x86)': 'Z:\\missing-program-files-x86',
        USERPROFILE: 'Z:\\missing-home',
        PATH: '',
      },
      directory: 'Z:\\missing-workspace',
    }, () => false)).toBe('unsupported');
  });

  it('preserves the manifest delivery for providers without runtime shell prerequisites', () => {
    expect(resolveAgentToolsDelivery('claude', {
      platform: 'win32',
      environmentVariables: {},
    })).toBe('native_mcp');
  });
});
