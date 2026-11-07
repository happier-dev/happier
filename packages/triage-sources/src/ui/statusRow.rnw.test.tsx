// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageStatusRow } from './statusRow.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(element: React.ReactElement): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'status-row', mountNonce: 'status-row-mount' },
      authorPlugin: { id: 'fixture.source', version: '0.0.0' },
      surface: defineUiSurface(() => element),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
      launchInput: null,
    });
  });
  mounted.push(fixture);
  return fixture;
}

describe('TriageStatusRow list presentation', () => {
  it('opens a status that has its own detail (a CI run) on press, with no in-place disclosure', async () => {
    let opened = 0;
    const fixture = await mount(
      <TriageStatusRow
        presentation="list"
        name="E2E · webkit"
        status="Failed"
        tone="danger"
        onPress={() => {
          opened++;
        }}
      />,
    );
    await fixture.press(await fixture.getByRole('button'));
    expect(opened).toBe(1);
  });
});
