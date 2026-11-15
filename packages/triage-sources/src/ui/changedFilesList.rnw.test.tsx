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

import { TriageChangedFilesLoading } from './changedFilesList.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('TriageChangedFilesLoading', () => {
  it('draws the line that will stand above the files while they load, in its own words once the source knows them', async () => {
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: {
          instanceId: 'files-loading',
          mountNonce: 'files-loading-mount',
        },
        authorPlugin: { id: 'fixture.source', version: '0.0.0' },
        surface: defineUiSurface(() => (
          <TriageChangedFilesLoading
            title="Reading the changed files"
            titleKey="fixture.readingFiles"
            progress="Comparing iteration 2 against the pull request's base."
          />
        )),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
        launchInput: null,
      });
    });
    mounted.push(fixture);
    // The settled panel leads with this line, so the files arrive where their placeholders stood.
    await expect(
      fixture.getByText(
        "Comparing iteration 2 against the pull request's base.",
      ),
    ).resolves.toBeDefined();
  });
});
