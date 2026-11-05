import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';

import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider } from '../AppPaneProvider';
import { PaneRegionProvider } from '../paneRegion';
import {
  PanePresentationProvider,
  type PanePresentation,
  type PanePresentationIntent,
} from '../panePresentation';
import { useAppPaneScope, type AppPaneScopeApi } from './useAppPaneScope';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createWorkspaceFileDetailsTab } from '../details/fileDetailsTab';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE_ID = 'session:walkthrough-phone';
const initialStorageState = storage.getState();
beforeEach(() => {
  storage.setState(initialStorageState, true);
  replacePersistentUiStateForTest(paneUiState, {});
});
afterEach(() => {
  storage.setState(initialStorageState, true);
  replacePersistentUiStateForTest(paneUiState, {});
});

/** The phone layout: every Details page opened from another one is its own tab (owner ruling 2026-10-30). */
function phoneRailPresentation(
  presented: PanePresentationIntent[],
): PanePresentation {
  return (intent) => {
    presented.push(intent);
    return intent.pane === 'details' && intent.fromDetails
      ? 'ownTab'
      : undefined;
  };
}

async function renderOpeners(presentation: PanePresentation | null) {
  const commands: { session?: AppPaneScopeApi; page?: AppPaneScopeApi } = {};
  function Session() {
    commands.session = useAppPaneScope(SCOPE_ID);
    return null;
  }
  function Page() {
    commands.page = useAppPaneScope(SCOPE_ID);
    return null;
  }
  const screen = await renderScreen(
    <AppPaneProvider>
      <PanePresentationProvider value={presentation}>
        <PaneRegionProvider region="main">
          <Session />
        </PaneRegionProvider>
        <PaneRegionProvider region="details">
          <Page />
        </PaneRegionProvider>
      </PanePresentationProvider>
    </AppPaneProvider>,
  );
  const { act } = await import('react-test-renderer');
  return {
    screen,
    act,
    session: () => commands.session!,
    page: () => commands.page!,
  };
}

describe('a page opened from a Details page', () => {
  it('leaves the Session pane unchanged when its layout opens the walkthrough in its own tab', async () => {
    const { screen, act, session } = await renderOpeners(intent => intent.pane === 'details' ? 'ownTab' : undefined);
    try {
      await act(async () => session().openDetailsTab(createSessionScmReviewDetailsTab({
        comparison: { kind: 'workingTree' }, view: 'walkthrough',
      }), { intent: 'pinned' }));
      expect(session().scopeState?.details.tabs ?? []).toEqual([]);
      expect(session().scopeState?.details.isOpen ?? false).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it('becomes its own tab where the layout gives each Details page one, so the pane holds one tab', async () => {
    const presented: PanePresentationIntent[] = [];
    const { screen, act, session, page } = await renderOpeners(
      phoneRailPresentation(presented),
    );
    try {
      const walkthrough = createSessionScmReviewDetailsTab({
        comparison: { kind: 'workingTree' },
      });
      await act(async () =>
        session().openDetailsTab(walkthrough, { intent: 'pinned' }),
      );
      const file = createWorkspaceFileDetailsTab('src/file-000.js');
      await act(async () => page().openDetailsTab(file));

      expect(page().scopeState?.details.tabs.map((tab) => tab.key)).toEqual([
        walkthrough.key,
      ]);
      expect(presented.at(-1)).toMatchObject({
        scopeId: SCOPE_ID,
        pane: 'details',
        tab: { key: file.key },
        fromDetails: true,
      });

      // Re-addressing the page on screen (its comparison or Explain) stays in place.
      await act(async () =>
        page().openDetailsTab(
          createSessionScmReviewDetailsTab({ comparison: { kind: 'session' } }),
          { intent: 'pinned' },
        ),
      );
      expect(page().scopeState?.details.tabs.map((tab) => tab.key)).toEqual([
        walkthrough.key,
      ]);
      expect(page().scopeState?.details.tabs[0]).toMatchObject({
        resource: { comparison: { kind: 'session' } },
      });
    } finally {
      await screen.unmount();
    }
  });

  it('stays a tab of the same pane where the layout keeps Details tab groups', async () => {
    const { screen, act, session, page } = await renderOpeners(null);
    try {
      const walkthrough = createSessionScmReviewDetailsTab({
        comparison: { kind: 'workingTree' },
      });
      await act(async () =>
        session().openDetailsTab(walkthrough, { intent: 'pinned' }),
      );
      const file = createWorkspaceFileDetailsTab('src/file-000.js');
      await act(async () => page().openDetailsTab(file));
      expect(page().scopeState?.details.tabs.map((tab) => tab.key)).toEqual([
        walkthrough.key,
        file.key,
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it('is placed by the same admission when a file opener inside the page opens it (go to definition)', async () => {
    const scopeId = createSessionPaneScopeId('s1', 'server-a');
    for (const presentation of ['phone', 'wide'] as const) {
      const presented: PanePresentationIntent[] = [];
      const commands: { session?: AppPaneScopeApi; files?: ReturnType<typeof useWorkspaceFileOpener> } = {};
      function Session() {
        commands.session = useAppPaneScope(scopeId);
        return null;
      }
      function Definition() {
        commands.files = useWorkspaceFileOpener();
        return null;
      }
      const screen = await renderScreen(
        <AppPaneProvider>
          <PanePresentationProvider value={presentation === 'phone' ? phoneRailPresentation(presented) : null}>
            <PaneRegionProvider region="main"><Session /></PaneRegionProvider>
            <PaneRegionProvider region="details"><Definition /></PaneRegionProvider>
          </PanePresentationProvider>
        </AppPaneProvider>,
      );
      const { act } = await import('react-test-renderer');
      try {
        const file = createWorkspaceFileDetailsTab('src/file-000.js');
        await act(async () => commands.session!.openDetailsTab(file, { intent: 'pinned' }));
        const anchor = { kind: 'fileLine' as const, startLine: 12 };
        let opened: boolean | null = null;
        await act(async () => {
          opened = await commands.files!.open({ kind: 'session', sessionId: 's1', serverId: 'server-a', path: 'src/util.js' },
            { intent: 'preview', anchor });
        });
        expect(opened).toBe(true);
        const keys = commands.session!.scopeState?.details.tabs.map((tab) => tab.key);
        if (presentation === 'phone') {
          // Its own tab: the pane keeps only the page it came from, and the layout gets the definition with its line.
          expect(keys).toEqual([file.key]);
          expect(presented.at(-1)).toMatchObject({ scopeId, pane: 'details', fromDetails: true,
            tab: { key: 'file:src/util.js', resource: { path: 'src/util.js', anchor } } });
        } else {
          expect(keys).toEqual([file.key, 'file:src/util.js']);
          expect(commands.session!.scopeState?.details.activeTabKey).toBe('file:src/util.js');
        }
      } finally {
        await screen.unmount();
      }
    }
  });
});
