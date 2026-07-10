import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'opencode');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'opencode.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields.map((field) => field.id)).toEqual([
      'opencodeBackendMode',
      'opencodeServerBaseUrl',
      'opencodeServerBaseUrlByServerIdV1',
    ]);
    expect(contribution?.fields.find((field) => field.id === 'opencodeBackendMode')).toMatchObject({
      default: 'server',
      schema: {
        kind: 'enum',
        values: ['server', 'acp'],
      },
    });
    expect(contribution?.ui.sections.map((section) => section.id)).toEqual([
      'opencodeBackendMode',
      'opencodeServer',
    ]);
  });
});
