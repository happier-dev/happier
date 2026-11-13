import { describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  get: vi.fn(async (url: string) => (url.endsWith('/v1/account/profile')
    ? { status: 200, data: { id: 'account-1' } }
    : { status: 404, data: {} })),
}));

// The Home is the system boundary: count the Account-profile reads it would serve.
vi.mock('@/api/client/credentialAxios', () => ({
  default: { get: http.get, post: vi.fn(), defaults: {} },
}));

import { MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { createCliActionDeps } from './createCliActionDeps';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const materialization = {
  pluginId: 'com.acme.github',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
} as const;
const caller = {
  kind: 'plugin' as const,
  pluginId: materialization.pluginId,
  materialization,
  occurrenceId: 'github-occurrence-a',
  sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'generation-a', installSource: 'archive' as const },
};

describe('createCliActionDeps Automation Event Account identity', () => {
  it('lists Event sources with the host-held authenticated Account id instead of re-reading the profile per call', async () => {
    const listPublicProjection = vi.fn(async () => ({ kind: 'unchanged' as const, revision: '7' }));
    const adoptedSet = {
      refresh: async () => ({ kind: 'adopted' as const, revision: '7' }),
      readPublicProjection: () => ({ kind: 'available' as const, revision: '7', definitions: [] }),
      listPublicProjection,
      prepareAdmission: async () => null,
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      resolveAutomationEventAdoptedDefinitionSet: () => adoptedSet as never,
      revalidatePluginActionCallerMaterialization: async () => true,
      revalidatePluginActionCallerOccurrence: async () => true,
      resolveAuthenticatedAccountId: async () => 'account-1',
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(deps.automationEventAction?.({
        actionId: 'automation.event.sources.list',
        input: { transport: { kind: 'checkpointedPull' }, pageSize: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE },
        caller,
      })).resolves.toEqual({ kind: 'unchanged', revision: '7' });
    }

    const profileReads = http.get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile')).length;
    expect({ profileReads, listed: listPublicProjection.mock.calls.length }).toEqual({ profileReads: 0, listed: 3 });
    expect(listPublicProjection).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1' }));
  });
});
