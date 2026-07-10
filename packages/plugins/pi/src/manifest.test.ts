import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Pi plugin manifest', () => {
  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'pi');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'pi.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields).toEqual([]);
    expect(contribution?.ui.sections).toEqual([]);
  });
});
