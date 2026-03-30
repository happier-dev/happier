import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRouteRootCommonModuleMocks();

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
}));

const persistSnapshotMock = vi.fn(async (..._args: unknown[]) => {});
const persistIntentMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/utils/system/preRestartBugReportSnapshot', () => ({
  persistPreRestartBugReportSnapshot: persistSnapshotMock,
}));

vi.mock('@/utils/system/restartBugReportIntent', () => ({
  persistRestartBugReportIntent: persistIntentMock,
}));

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AppCrashRecoveryBoundary', () => {
  it('renders children when no error is thrown', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <>{React.createElement('ChildOk')}</>
        </AppCrashRecoveryBoundary>);
    expect(screen.findByType('ChildOk' as any)).toBeTruthy();
  });

  it('renders a crash fallback when a child throws during render', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    expect(screen.tree.toJSON()).not.toBeNull();
    expect(screen.findByTestId('app-blocking-logo')).toBeTruthy();
    expect(screen.findByTestId('app-crash-restart')).toBeTruthy();
    expect(screen.findByTestId('app-crash-report-bug')).toBeTruthy();
    expect(screen.findByTestId('app-crash-copy-details')).toBeTruthy();
  });

  it('renders the crash fallback inside a full-height scroll view', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const { ScrollView } = await import('react-native');
    const scrollView = screen.findByType(ScrollView);
    expect(scrollView.props.style).toEqual(expect.objectContaining({ flex: 1 }));
    expect(scrollView.props.contentContainerStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
  });

  it('invokes onRestart when the restart button is pressed', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };
    const onRestart = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const restartButton = screen.findByTestId('app-crash-restart');
    expect(restartButton).not.toBeNull();
    if (!restartButton) {
      throw new Error('missing restart button');
    }
    await act(async () => {
      restartButton.props.onPress?.();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('persists a pre-restart snapshot and restarts when the report bug button is pressed', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => {
      throw new Error('boom');
    };

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRestart = vi.fn();

    const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}>
          <Thrower />
        </AppCrashRecoveryBoundary>);
    consoleError.mockRestore();

    const reportBugButton = screen.findByTestId('app-crash-report-bug');
    expect(reportBugButton).not.toBeNull();
    if (!reportBugButton) {
      throw new Error('missing report bug button');
    }
    await act(async () => {
      reportBugButton.props.onPress?.();
      await flushPromises();
    });

    expect(persistSnapshotMock).toHaveBeenCalledTimes(1);
    expect(persistIntentMock).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
