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

import { TriageChangedFilesList, TriageChangedFilesLoading, TriageChangedFilesProgress } from './changedFilesList.js';

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

  it('stands the loading line on the settled files\' text edge, so it does not move when the files arrive', async () => {
    const loadingLine = 'Comparing iteration 2 while the files load.';
    const settledLine = 'Comparing iteration 2 against the base.';
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'files-edge', mountNonce: 'files-edge-mount' },
        authorPlugin: { id: 'fixture.source', version: '0.0.0' },
        surface: defineUiSurface(() => (
          <>
            <TriageChangedFilesLoading title="Reading the changed files" titleKey="fixture.readingFiles" progress={loadingLine} />
            <TriageChangedFilesList
              accessibilityLabel="Changed files"
              accessibilityLabelKey="fixture.files"
              sections={[{ key: 'files', title: '', data: [{ path: 'src/a.ts' }] }]}
              focusPath={null}
              onFocusPath={() => {}}
              active
              viewed={null}
              renderBody={() => null}
              header={<TriageChangedFilesProgress value={settledLine} />}
            />
          </>
        )),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
        launchInput: null,
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText(settledLine)).resolves.toBeDefined();
    // The line's start edge: every horizontal inset its ancestors draw before its words.
    const startEdge = (text: string): number => {
      const node = [...document.body.querySelectorAll<HTMLElement>('*')].find((element) => element.textContent === text
        && [...element.children].every((child) => child.textContent !== text));
      expect(node).toBeDefined();
      let edge = 0;
      for (let element: HTMLElement | null = node!; element !== null && element !== document.body; element = element.parentElement) {
        edge += (Number.parseFloat(element.style.paddingLeft || element.style.paddingInlineStart || '0') || 0)
          + (Number.parseFloat(element.style.marginLeft || '0') || 0);
      }
      return edge;
    };
    expect(startEdge(settledLine)).toBeGreaterThan(0);
    expect(startEdge(loadingLine)).toBe(startEdge(settledLine));
  });
});
