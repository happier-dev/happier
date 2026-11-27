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
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageSourceCommentComposer } from './sourceWrites.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE: TriageEntryRefV1 = {
  source: { pluginId: 'fixture.source', localId: 'issues' },
  kindId: 'issue',
  collisionScope: 'acme/web',
  entryId: '2490',
} as TriageEntryRefV1;
const ACTION = {
  pluginId: 'fixture.source',
  localId: 'comment-create',
} as never;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(element: React.ReactElement): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'comment-internal',
        mountNonce: 'comment-internal',
      },
      authorPlugin: { id: 'fixture.source', version: '0.0.0' },
      surface: defineUiSurface(() => element),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ hostWork: true }),
      launchInput: null,
    });
  });
  mounted.push(fixture);
  return fixture;
}

describe('TriageSourceCommentComposer Internal switch', () => {
  it('starts public, moves to the item’s internal host thread, and is public again after an Internal send', async () => {
    const fixture = await mount(
      <TriageSourceCommentComposer
        action={ACTION}
        sourceName="GitHub"
        buildInput={(body) => ({ body })}
        internal={{ anchor: ISSUE }}
      />,
    );
    const toggle = await fixture.getByRole('switch', { name: 'Internal' });
    expect(toggle.state?.checked).toBe(false);
    expect(
      await fixture.getByRole('textbox', { name: 'Comment' }),
    ).toBeTruthy();
    expect(
      await fixture.queryByRole('group', {
        name: 'Comments on 2490, internal',
      }),
    ).toBeUndefined();

    await act(async () => {
      await fixture.press(toggle);
    });
    expect(
      await fixture.getByRole('group', { name: 'Comments on 2490, internal' }),
    ).toBeTruthy();
    expect(
      await fixture.queryByRole('button', { name: 'Publish comment' }),
    ).toBeUndefined();

    await act(async () => {
      await fixture.press(await fixture.getByRole('button', { name: 'Send' }));
    });
    expect(
      (await fixture.getByRole('switch', { name: 'Internal' })).state?.checked,
    ).toBe(false);
    expect(
      await fixture.queryByRole('group', {
        name: 'Comments on 2490, internal',
      }),
    ).toBeUndefined();
  });

  it('offers no switch where the source names no entry for private comments', async () => {
    const fixture = await mount(
      <TriageSourceCommentComposer
        action={ACTION}
        sourceName="GitHub"
        buildInput={(body) => ({ body })}
      />,
    );
    expect(
      await fixture.queryByRole('switch', { name: 'Internal' }),
    ).toBeUndefined();
  });
});
