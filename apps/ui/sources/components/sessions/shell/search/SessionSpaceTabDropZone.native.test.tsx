import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDropAdmissionV1 } from '@happier-dev/protocol/plugins/ui';
import {
  SessionSpaceTabDropZone,
  type SessionSpaceDrop,
} from './SessionSpaceTabDropZone';

installPanelCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { View: 'View' });
  },
});

const scope = { serverId: 'home', accountId: 'account' };

describe('a space tab as a Session drop target', () => {
  it('admits a carried Session through the list owner and runs its Add to space effect on release', async () => {
    const runtime = useEntityDragDropRuntime();
    // The list owner's binding: its admission and its mounted Action executor.
    const execute = vi.fn(async () => ({ status: 'applied' as const }));
    const resolve = vi.fn((_context, spaceId: string): EntityDropAdmissionV1 =>
      spaceId === 'release'
        ? {
            status: 'allowed',
            effect: {
              actionId: 'session.space_membership.set',
              input: {
                sessionId: 'carried',
                operation: 'add',
                spaceId,
                spaceSettingsTarget: scope,
              },
              preview: { verb: 'Add to', target: 'Release' },
            },
          }
        : {
            status: 'refused',
            reason: { code: 'already-placed', message: 'already-placed' },
          },
    );
    const spaceDrop: SessionSpaceDrop = { resolve, execute };
    const retire = runtime.registerSource({
      id: 'space-tab-source',
      scope,
      isCurrent: () => true,
      getItem: () => ({
        kind: 'session',
        scope,
        address: { serverId: 'home', sessionId: 'carried' },
      }),
    });
    const screen = await renderScreen(
      <>
        <SessionSpaceTabDropZone
          spaceId="release"
          spaceDrop={() => spaceDrop}
          testID="tab-release"
        >
          <React.Fragment />
        </SessionSpaceTabDropZone>
        <SessionSpaceTabDropZone
          spaceId="mine"
          spaceDrop={() => spaceDrop}
          testID="tab-mine"
        >
          <React.Fragment />
        </SessionSpaceTabDropZone>
      </>,
      {
        createNodeMock: (element) => {
          const testID =
            typeof element.props === 'object' &&
            element.props !== null &&
            'testID' in element.props
              ? element.props.testID
              : null;
          const x =
            testID === 'tab-release' ? 0 : testID === 'tab-mine' ? 100 : null;
          return x === null
            ? null
            : {
                measureInWindow: (
                  callback: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                  ) => void,
                ) => callback(x, 0, 40, 28),
              };
        },
      },
    );
    await act(async () => {
      screen.findByTestId('tab-release')?.props.onLayout();
      screen.findByTestId('tab-mine')?.props.onLayout();
    });
    let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
    await act(async () => {
      carry = runtime.begin('space-tab-source')!;
    });
    // Over the space it is already in: a quiet no-change, no highlight.
    await act(async () => {
      carry.move({ x: 120, y: 10 });
    });
    expect(runtime.getSnapshot().admission).toMatchObject({
      status: 'refused',
      reason: { code: 'already-placed' },
    });
    expect(screen.findByTestId('tab-mine-drop')).toBeNull();
    // Over another space: admitted, highlighted, and released into the list owner's effect.
    await act(async () => {
      carry.move({ x: 20, y: 10 });
    });
    expect(runtime.getSnapshot().admission?.status).toBe('allowed');
    expect(screen.findByTestId('tab-release-drop')).not.toBeNull();
    await act(async () => {
      expect(await carry.release()).toEqual({ status: 'applied' });
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'session.space_membership.set',
        input: expect.objectContaining({
          operation: 'add',
          spaceId: 'release',
          sessionId: 'carried',
        }),
      }),
      expect.anything(),
    );
    await act(async () => {
      retire();
    });
  });
});
