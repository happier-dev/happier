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
import type { ScmFileViewedFile, ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
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

describe('TriageChangedFilesList Viewed marks', () => {
  const PATHS = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'] as const;
  /** A host boundary fixture: the app's Viewed owner answers per path and records each write. */
  function viewedSource(initial: Readonly<Record<string, ScmFileViewedFile['state']>>) {
    const writes: Array<Readonly<{ path: string; viewed: boolean }>> = [];
    // One stable snapshot per path, as the host owner publishes them.
    const files = new Map<string, ScmFileViewedFile>(PATHS.map((path) => [path, { state: initial[path] ?? null, pending: false, errorCode: null }]));
    const snapshot = { status: 'ready' as const, headOid: 'head', errorCode: null };
    const source: ScmFileViewedSource = {
      getFile: (path) => files.get(path)!,
      subscribeFile: () => () => {},
      getSnapshot: () => snapshot,
      subscribeStatus: () => () => {},
      subscribeChanges: () => () => {},
      getViewedPaths: () => new Set(Object.entries(initial).filter(([, state]) => state === 'viewed').map(([path]) => path)),
      setViewed: async (path, viewed) => { writes.push({ path, viewed }); return true; },
      refresh: async () => {},
    };
    return { source, writes };
  }

  async function mountList(source: ScmFileViewedSource, onFocusPath: (path: string | null) => void) {
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'files-viewed', mountNonce: 'files-viewed-mount' },
        authorPlugin: { id: 'fixture.source', version: '0.0.0' },
        surface: defineUiSurface(() => (
          <TriageChangedFilesList
            accessibilityLabel="Changed files"
            accessibilityLabelKey="fixture.files"
            sections={[{ key: 'files', title: '', data: PATHS.map((path) => ({ path, diffAvailable: true })) }]}
            focusPath={null}
            onFocusPath={onFocusPath}
            active
            viewed={{ source, labels: { viewed: 'Viewed', notSaved: 'Not saved' } }}
            renderBody={() => null}
            header={<TriageChangedFilesProgress value="1 of 3 viewed" />}
          />
        )),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
        launchInput: null,
      });
    });
    mounted.push(fixture);
    return fixture;
  }

  it('marks a file viewed from its own checkbox in one press, without opening the file (N32)', async () => {
    const { source, writes } = viewedSource({ 'src/alpha.ts': 'viewed', 'src/beta.ts': 'unviewed' });
    const opened: Array<string | null> = [];
    const files = await mountList(source, (path) => { opened.push(path); });
    const alpha = await files.getByRole('checkbox', { name: 'Viewed: src/alpha.ts' });
    const beta = await files.getByRole('checkbox', { name: 'Viewed: src/beta.ts' });
    expect(alpha.state?.checked).toBe(true);
    expect(beta.state?.checked).toBe(false);
    await act(async () => { await files.press(beta); });
    expect(writes).toEqual([{ path: 'src/beta.ts', viewed: true }]);
    expect(opened).toEqual([]);
    // The box is the one control for the mark: the row's menu no longer repeats it.
    await expect(files.queryByRole('menuitem', { name: 'Mark viewed' })).resolves.toBeUndefined();
  });

  it('keeps the box\'s place for a file the source has not answered for, so rows do not shift when it does', async () => {
    const { source } = viewedSource({ 'src/alpha.ts': 'viewed', 'src/beta.ts': 'unviewed' });
    const files = await mountList(source, () => {});
    // gamma has no answer yet: no control is offered, its hidden box holds the column.
    await expect(files.queryByRole('checkbox', { name: 'Viewed: src/gamma.ts' })).resolves.toBeUndefined();
    expect(document.querySelector('[data-testid="triage-file-viewed:src/gamma.ts-unknown"]')).not.toBeNull();
  });
});
