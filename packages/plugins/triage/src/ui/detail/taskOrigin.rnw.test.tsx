// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { preflightTriageRouteLensV1, TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../navigation/location.js';
import { TriageTaskOrigin } from './taskOrigin.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

it('reads the persisted origin once per open or explicit refresh and opens the complete error reference', async () => {
  const entryRef = testkitEntryRef({ kindId: 'issue', entryId: 'created-issue' });
  const originError = { entryRef: testkitEntryRef({ kindId: 'error-issue', collisionScope: 'production', entryId: 'checkout-error' }),
    display: { title: 'Checkout fails after payment', scopeLabel: 'Production' } };
  const reads: unknown[] = [];
  const opens: unknown[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'persisted-error-origin', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      const [refresh, setRefresh] = React.useState(0);
      const [unrelated, setUnrelated] = React.useState(0);
      return <><TriageTaskOrigin entryRef={{ ...entryRef }} refreshGeneration={refresh} />
        <Button title={`Unrelated ${unrelated}`} onPress={() => setUnrelated(value => value + 1)} />
        <Button title="Refresh task" onPress={() => setRefresh(value => value + 1)} /></>;
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/read-origin-error-v1'); reads.push(input); return { v: 1, originError };
      },
      openSurface: request => { opens.push(request); },
    },
  });
  mounted.push(fixture);
  const label = 'From error: Checkout fails after payment';
  await fixture.getByRole('button', { name: label });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Unrelated 0' })); });
  expect(reads).toEqual([{ v: 1, entryRef }]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh task' })); });
  expect(reads).toEqual([{ v: 1, entryRef }, { v: 1, entryRef }]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: label })); });
  const route = preflightTriageRouteLensV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: originError.entryRef });
  expect(route.kind).toBe('accepted');
  expect(opens).toMatchObject([{ view: { pluginId: 'happier.triage', localId: 'triage' },
    ...(route.kind === 'accepted' ? { subPath: route.subPath } : {}) }]);
});
