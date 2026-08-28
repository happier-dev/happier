import { describe, expect, it } from 'vitest';

import { createHostApiStub } from './surfaceFixture.testSupport.js';

describe('createHostApiStub', () => {
  it('supplies the current ephemeral-input, Composer, page, and resource Host API members', async () => {
    const host = createHostApiStub();

    await expect(host.settleEphemeralInput({ kind: 'cancelled' })).rejects.toMatchObject({
      code: 'unsupported_method',
    });
    await expect(host.activeComposer()).resolves.toBeNull();
    await expect(host.replacePageLocation('issues/42')).rejects.toMatchObject({
      code: 'unsupported_method',
    });
    await expect(host.watchResource(
      { pluginId: 'acme.fixture', localId: 'issues' },
      () => undefined,
    )).rejects.toMatchObject({
      code: 'unsupported_method',
    });
  });
});
