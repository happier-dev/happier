import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  FloatingFrame,
  resolveFloatingFrameChromeHeight,
} from '@happier-dev/plugin-ui/presentation';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import {
  SessionCockpitChromeRegistryProvider,
  useReportSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import {
  useOptionalSessionViewerController,
  usePublishSessionViewerSourceFacts,
  type SessionViewerController,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerStickySlot } from './SessionViewerStickySlot';

/**
 * Phone Watch on a short phone (390 x 480): the docked frame sits between the Session header and the
 * composer. Its picture's own shape asks for more height than that room; the controls and the
 * who-acts footer must still stand above the composer, not under it.
 */
describe('SessionViewerStickySlot', () => {
  it('lets the picture yield height on a short phone so the controls and footer stay above the composer', async () => {
    const { Dimensions } = await import('react-native');
    const { width: windowWidth, height: windowHeight } =
      Dimensions.get('window');
    const slotTop = 96;
    const composerStart = slotTop + 150;
    const harness: { controller: SessionViewerController | null } = {
      controller: null,
    };
    function Composer() {
      const report = useReportSessionCockpitComposerChromeHeight(true);
      React.useEffect(() => {
        report(160, windowHeight - composerStart);
      }, [report]);
      return null;
    }
    function Source() {
      // A 16:10 picture: at the phone's width it would be far taller than the room left.
      usePublishSessionViewerSourceFacts('browser', {
        machineName: null,
        personInControl: false,
        watching: true,
        aspectRatio: 1.6,
      });
      harness.controller = useOptionalSessionViewerController();
      return null;
    }
    const result = await renderWithAppProviders(
      <SessionCockpitChromeRegistryProvider>
        <Composer />
        <SessionViewerControllerProvider
          sessionId="session-a"
          serverId="home-a"
          phone
          canPresentSource={() => true}
          openDocked={() => {}}
        >
          <Source />
          <SessionViewerStickySlot sessionId="session-a" serverId="home-a" />
        </SessionViewerControllerProvider>
      </SessionCockpitChromeRegistryProvider>,
      {
        createNodeMock: (element) =>
          element.props.testID === 'session-viewer-sticky'
            ? {
                measureInWindow: (
                  callback: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                  ) => void,
                ) => callback(0, slotTop, windowWidth, 0),
              }
            : null,
      },
    );
    try {
      await act(async () => {
        harness.controller!.port.apply({
          kind: 'viewer.open',
          source: 'browser',
        });
      });
      expect(harness.controller!.state.mode).toBe('docked');
      await act(async () => {
        invokeTestInstanceHandler(
          result.tree.root.findByProps({ testID: 'session-viewer-sticky' }),
          'onLayout',
          {
            nativeEvent: {
              layout: { x: 0, y: 0, width: windowWidth, height: 300 },
            },
          },
        );
      });
      const frame = result.tree.root.findByType(FloatingFrame);
      const sticky = result.tree.root.findByProps({
        testID: 'session-viewer-sticky',
      });
      const style = sticky.props.style as {
        paddingHorizontal: number;
        paddingTop: number;
        paddingBottom: number;
      };
      const width = windowWidth - style.paddingHorizontal * 2;
      const height =
        style.paddingTop +
        resolveFloatingFrameChromeHeight({ footer: false }) +
        width / (frame.props.aspectRatio as number) +
        style.paddingBottom;
      expect(slotTop + height).toBeLessThanOrEqual(composerStart + 0.5);
    } finally {
      await result.unmount();
    }
  });
});
