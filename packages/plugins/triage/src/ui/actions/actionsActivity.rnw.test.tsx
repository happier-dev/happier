// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { expect, it } from 'vitest';

import { readTriageActionsForSurface } from '../../actions/actionsCatalog.js';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 } from '../../actions/actionsCatalogProtocol.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../settings/actions.js';
import { createTestkitAccountKv } from '../../settings/testkit/accountKv.test-support.js';
import { useTriageActions } from './useTriageActions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalogSurface = defineUiSurface(() => <Text value={useTriageActions().loaded ? 'Actions loaded' : 'Actions pending'} />);

it('reads the Action catalog once on each open and does no work while retained and closed', async () => {
  const account = createTestkitAccountKv();
  const deps = { catalog: account.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };
  let active = false;
  let reads = 0;
  const mount = async () => createPluginUiTestkit({
    identity: { instanceId: 'retained-actions', mountNonce: 'retained-actions' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: context => catalogSurface({ ...context, activity: { active } }),
    surfaceContext: createSurfaceContextFixture({}),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      async executeAction({ action }) {
        const id = typeof action === 'string' ? action : action.localId;
        expect(id).toBe(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1);
        reads += 1;
        return await readTriageActionsForSurface({ v: 1 }, deps);
      },
    },
  });
  let fixture!: Awaited<ReturnType<typeof mount>>;
  await act(async () => { fixture = await mount(); });
  const setActive = async (value: boolean) => {
    active = value;
    await act(async () => { await fixture.updateSurface(fixture.context.surface); });
  };
  try {
    expect(reads).toBe(0);
    await setActive(true);
    expect(reads).toBe(1);
    await expect(fixture.getByText('Actions loaded')).resolves.toBeDefined();
    await setActive(false);
    expect(reads).toBe(1);
    await setActive(true);
    expect(reads).toBe(2);
  } finally {
    await act(async () => { await fixture.dispose(); });
  }
});
