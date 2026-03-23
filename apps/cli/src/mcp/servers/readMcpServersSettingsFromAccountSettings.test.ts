import { describe, expect, it } from 'vitest';

import { readMcpServersSettingsFromAccountSettings } from './readMcpServersSettingsFromAccountSettings';

describe('readMcpServersSettingsFromAccountSettings', () => {
  it('returns empty settings when missing', () => {
    const out = readMcpServersSettingsFromAccountSettings({});
    expect(out.v).toBe(1);
    expect(out.strictMode).toBe(false);
    expect(out.servers).toEqual([]);
    expect(out.bindings).toEqual([]);
  });

  it('parses settings when present', () => {
    const out = readMcpServersSettingsFromAccountSettings({
      mcpServersSettingsV1: {
        v: 1,
        strictMode: true,
        servers: [],
        bindings: [],
      },
    });
    expect(out.strictMode).toBe(true);
  });
});

