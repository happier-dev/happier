import * as React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  SessionCockpitChromeRegistryProvider,
  useReportSessionCockpitFloatingBottomChromeHeight,
  useSessionCockpitBottomChromeHeightSetter,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import { WorkflowRunNeedsYouDock } from './WorkflowRunNeedsYouDock';

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

function ChromeMeasurement(props: Readonly<{ bar: number; floating: number }>) {
  const setBar = useSessionCockpitBottomChromeHeightSetter();
  const reportFloating = useReportSessionCockpitFloatingBottomChromeHeight(true);
  React.useEffect(() => { setBar(props.bar); }, [props.bar, setBar]);
  React.useEffect(() => { reportFloating(props.floating); }, [props.floating, reportFloating]);
  return null;
}

afterEach(standardCleanup);

describe('WorkflowRunNeedsYouDock', () => {
  it('keeps the dock and its scroll reservation above the shell bottom chrome as its measured clearance changes', async () => {
    const onHeight = vi.fn();
    const scene = (bar: number, floating: number, safeAreaBottom = 0) => (
      <SessionCockpitChromeRegistryProvider>
        <ChromeMeasurement bar={bar} floating={floating} />
        <SafeAreaInsetsContext.Provider value={{ top: 0, left: 0, right: 0, bottom: safeAreaBottom }}>
          <WorkflowRunNeedsYouDock count={1} steps={['Waiting for review']} onReview={() => {}}
            onHeight={onHeight} primary testIDPrefix="run-needs-you" />
        </SafeAreaInsetsContext.Provider>
      </SessionCockpitChromeRegistryProvider>
    );
    const screen = await renderScreen(scene(62, 70));
    const expectDockClearance = async (clearance: number, measure = false) => {
      const dock = screen.findByType(WorkflowRunNeedsYouDock);
      const frame = dock.find((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
      // The native layout engine measures the dock frame; its absolute parent provides bottom clearance.
      const positioner = frame.parent;
      expect(StyleSheet.flatten(positioner?.props.style).paddingBottom).toBe(clearance);
      if (measure) {
        await act(async () => {
          frame.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 62 } } });
        });
      }
      expect(onHeight).toHaveBeenLastCalledWith(62 + clearance);
    };
    await expectDockClearance(132, true);
    await screen.update(scene(44, 0, 34));
    await expectDockClearance(44);
    const changedReservationCount = onHeight.mock.calls.length;
    await screen.update(scene(44, 0, 34));
    expect(onHeight).toHaveBeenCalledTimes(changedReservationCount);
    await screen.update(scene(0, 0, 34));
    await expectDockClearance(34);
  });
});
