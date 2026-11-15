import { expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { machineAccessSurface } from '../../../plugin-sdk/fixtures/authoring-inference/machineAccess.js';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

it.each(['ready', 'key_pending', 'refused'] as const)('renders safe recipient %s and content-free Machine work', async accessState => {
  const ui = await createPluginUiTestkit({
    identity: { instanceId: 'machine-access-author', mountNonce: accessState },
    authorPlugin: { id: 'example.machine-access-author', version: '1.0.0' },
    surface: machineAccessSurface,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    // The host Action transport is the boundary; the public surface and RNW renderer stay real.
    handlers: { executeAction: async ({ action }) => {
      if (action === 'machines.access.grants.list') return {
        machineId: 'machine', custodian: { accountId: 'owner', displayName: 'Owner' },
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState },
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
      } satisfies PluginActionResultById['machines.access.grants.list'];
      if (action === 'machines.work.summary.get') return { kind: 'current', requesters: [
        { accountId: 'recipient', displayName: 'Alex', sessions: 2, tasks: 1, terminals: 3 },
      ] };
      throw new Error(`Unexpected Action ${action}`);
    } },
  });
  try {
    await ui.press(await ui.getByRole('button', { name: 'Read machine access' }));
    await expect(ui.getByText(accessState)).resolves.toEqual({ content: accessState });
    await expect(ui.getByText('Alex: 2 sessions, 1 tasks, 3 terminals')).resolves.toEqual({ content: 'Alex: 2 sessions, 1 tasks, 3 terminals' });
  } finally { await ui.dispose(); }
});
