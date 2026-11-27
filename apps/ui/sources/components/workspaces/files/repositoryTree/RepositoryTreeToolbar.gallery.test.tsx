/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { RepositoryTreeToolbar } = await import('./RepositoryTreeToolbar');

/** The toolbar on the one browser-state owner, the way the Files pane wires it. */
function FilesToolbar(props: Readonly<{ scopeKey: string; withMedia: boolean }>) {
  const state = useRepositoryTreeBrowserState(props.scopeKey);
  return (
    <>
      <RepositoryTreeToolbar
        testIDPrefix="repository-tree"
        searchValue=""
        onSearchValueChange={() => {}}
        changedOnly={state.changedOnly}
        changedCount={4}
        onChangedOnlyChange={(next) => { if (state.view === 'media') state.setView('list'); state.setChangedOnly(next); }}
        detailsMode={false}
        onDetailsModeChange={() => {}}
        onCollapseAll={null}
        onRefresh={() => {}}
        refreshing={false}
        galleryView={{ mode: state.view === 'gallery' ? 'gallery' : 'list',
          onChange: (mode) => (mode === 'gallery' ? state.showGallery(state.galleryPath) : state.setView('list')) }}
        media={props.withMedia ? { selected: state.view === 'media', onSelect: () => state.setView('media') } : null}
      />
      <Probe view={state.view} changedOnly={state.changedOnly} />
    </>
  );
}
function Probe(_props: Readonly<{ view: string; changedOnly: boolean }>) { return null; }
const read = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findByType(Probe).props as { view: string; changedOnly: boolean };
function select(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return act(async () => { screen.pressByTestId(testID); });
}

describe('Files toolbar: List | Gallery and Media (lab pr974 SG1, SM1)', () => {
  it('toggles the folder in view between list and gallery, drawn only while All shows the files', async () => {
    const screen = await renderScreen(<FilesToolbar scopeKey="toggle" withMedia={false} />);
    expect(screen.findByTestId('repository-tree-view-gallery')).toBeTruthy();
    await select(screen, 'repository-tree-view-gallery');
    expect(read(screen).view).toBe('gallery');
    // Changed is always a diff list: choosing it returns the gallery to the list and hides the toggle.
    await select(screen, 'repository-tree-show-changed');
    expect(read(screen)).toEqual({ view: 'list', changedOnly: true });
    expect(screen.findByTestId('repository-tree-view-gallery')).toBeFalsy();
    await screen.unmount?.();
  });

  it('offers Media as the segment’s last option, uncounted, and All leaves it for the list', async () => {
    const screen = await renderScreen(<FilesToolbar scopeKey="media" withMedia />);
    await select(screen, 'repository-tree-show-media');
    expect(read(screen).view).toBe('media');
    // Media is always a gallery: no List | Gallery toggle.
    expect(screen.findByTestId('repository-tree-view-gallery')).toBeFalsy();
    await select(screen, 'repository-tree-show-all');
    expect(read(screen)).toEqual({ view: 'list', changedOnly: false });
    await screen.unmount?.();
  });
});
