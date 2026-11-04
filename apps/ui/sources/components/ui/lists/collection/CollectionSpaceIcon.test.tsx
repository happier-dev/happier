import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The Machine RPC is the system boundary; the favicon cache, Project rows, baseline election and mark stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: machineRpc,
  }),
);

import { storage } from '@/sync/domains/state/storage';
import {
  clearWorkspaceFaviconCacheForTests,
  resolveWorkspaceFavicon,
} from '@/sync/ops/workspaceFavicon';
import { CollectionSpaceIcon } from './CollectionSpaceIcon';

describe("a Space's mark", () => {
  it('draws a glyph space with its glyph and a Project space with its folder until a favicon is held', async () => {
    const screen = await renderScreen(
      <>
        <CollectionSpaceIcon
          testID="glyph"
          icon={{ kind: 'icon', name: 'review' }}
          size={16}
          color="#888"
        />
        <CollectionSpaceIcon
          testID="project"
          icon={{
            kind: 'project',
            project: { serverId: 'home-a', projectKey: 'happier' },
          }}
          size={16}
          color="#888"
        />
      </>,
    );
    expect(screen.findByTestId('glyph')).not.toBeNull();
    // No held favicon for this Project: the mark falls back without asking any Machine for one.
    expect(screen.findByTestId('project-project-fallback')).not.toBeNull();
    expect(screen.findByTestId('project-project-favicon')).toBeNull();
  });

  it('draws the favicon its Project baseline already holds, and drawing never asks a Machine', async () => {
    const original = storage.getState();
    clearWorkspaceFaviconCacheForTests();
    machineRpc.mockReset();
    machineRpc.mockResolvedValue({
      success: true,
      found: true,
      relativePath: 'public/favicon.svg',
      mimeType: 'image/svg+xml',
      contentBase64: 'PHN2Zy8+',
      sizeBytes: 6,
    });
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const workspaceRefs = [
      {
        id: 'newer',
        serverId: 'home-a',
        machineId: 'machine-b',
        rootPath: '/newer',
        projectKey: 'happier',
        createdAtMs: 9,
      },
      {
        id: 'baseline',
        serverId: 'home-a',
        machineId: 'machine-a',
        rootPath: '/repo',
        projectKey: 'happier',
        createdAtMs: 1,
      },
    ];
    storage.setState({
      profileScope: scope,
      projectAccountRows: {
        scope,
        status: 'ready',
        coverage: 'complete',
        workspaceRefs,
        relationships: [],
        organizations: [],
        revisionsByPhysicalKey: {},
      },
    } as never);
    try {
      const screen = await renderScreen(
        <CollectionSpaceIcon
          testID="mark"
          icon={{
            kind: 'project',
            project: { serverId: 'home-a', projectKey: 'happier' },
          }}
          size={16}
          color="#888"
        />,
      );
      expect(screen.findByTestId('mark-project-fallback')).not.toBeNull();
      expect(machineRpc).toHaveBeenCalledTimes(0);

      // A list header or row owns the demand, on the Project's baseline (the oldest ref, not the newer one).
      await resolveWorkspaceFavicon({
        serverId: 'home-a',
        machineId: 'machine-a',
        workspacePath: '/repo',
        enabled: true,
      });
      expect(machineRpc).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('mark-project-favicon')?.props.source,
        ).toEqual({
          uri: 'data:image/svg+xml;base64,PHN2Zy8+',
        }),
      );
      expect(machineRpc).toHaveBeenCalledTimes(1);
    } finally {
      storage.setState(original, true);
      clearWorkspaceFaviconCacheForTests();
    }
  });
});
