// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, expect, it } from 'vitest';

import { TriageReadyHiddenFooter } from './readyHiddenFooter.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((fixture) => fixture.dispose()));
});

async function mount(element: React.ReactElement) {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'ready-footer',
        mountNonce: String(mounted.length),
      },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => element),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  mounted.push(fixture);
  return fixture;
}

it('says what the Ready lens set aside, from the window census, and lifts the lens on Show them', async () => {
  let shown = 0;
  const fixture = await mount(
    <TriageReadyHiddenFooter
      counts={{ blocker_not_terminal: 2, blocker_unreadable: 1 }}
      onShow={() => {
        shown += 1;
      }}
    />,
  );
  expect(document.body.textContent).toContain(
    '3 not ready: 2 wait on blockers, 1 with a blocker that can’t be read',
  );
  await act(async () => {
    await fixture.press(
      await fixture.getByRole('button', { name: 'Show them' }),
    );
  });
  expect(shown).toBe(1);
});

it('names only the reasons present, and draws nothing when the lens set nothing aside or there is no census', async () => {
  await mount(
    <TriageReadyHiddenFooter
      counts={{ blocker_not_terminal: 0, blocker_unreadable: 2 }}
      onShow={() => {}}
    />,
  );
  expect(document.body.textContent).toContain(
    '2 not ready: 2 with a blocker that can’t be read',
  );
  expect(document.body.textContent).not.toContain('wait on blockers');
  const empty = await mount(
    <TriageReadyHiddenFooter
      counts={{ blocker_not_terminal: 0, blocker_unreadable: 0 }}
      onShow={() => {}}
    />,
  );
  const none = await mount(
    <TriageReadyHiddenFooter counts={undefined} onShow={() => {}} />,
  );
  expect(
    await empty.queryByRole('button', { name: 'Show them' }),
  ).toBeUndefined();
  expect(
    await none.queryByRole('button', { name: 'Show them' }),
  ).toBeUndefined();
});
