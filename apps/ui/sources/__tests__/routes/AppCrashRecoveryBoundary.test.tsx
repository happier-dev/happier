import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRouteRootCommonModuleMocks();

vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemMock().module;
});

vi.mock('@/utils/web/reactNativeScreensCjs', () => ({
  requireReactNativeScreens: () => ({
    FullWindowOverlay: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('FullWindowOverlay', { testID: 'app-crash-recovery-full-window-overlay' }, children),
  }),
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => true),
}));

const crashRuntime = vi.hoisted(() => ({ version: '0.2.crashing-frontend' }));
vi.mock('expo-constants', () => ({ default: { get expoConfig() { return { version: crashRuntime.version }; } } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: null, nativeBuildVersion: null, applicationId: null }));
vi.mock('expo-updates', () => ({ updateId: 'crashing-update', runtimeVersion: 'crashing-runtime', createdAt: null, channel: null, isEmbeddedLaunch: false }));

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  crashRuntime.version = '0.2.crashing-frontend';
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

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

  it('hosts the native crash fallback in a full-window overlay without RN Modal', async () => {
    // iOS evidence (issue-2, T4h 2026-06-12): the boundary caught a FlashList crash, mounted its
    // fallback into the root view, but the screen kept showing the dead previous frame because a
    // natively-presented screen container stayed on top. Use the react-native-screens full-window
    // overlay to paint above stuck native view controllers without reintroducing RN Modal trees.
    const reactNative = await import('react-native');
    const platform = reactNative.Platform as { OS: string };
    const originalOs = platform.OS;
    platform.OS = 'ios';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
      const Thrower = () => {
        throw new Error('boom');
      };
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
            <Thrower />
          </AppCrashRecoveryBoundary>);

      expect(screen.findAll((node) => node.type === (reactNative.Modal as any))).toHaveLength(0);
      const overlay = screen.findByTestId('app-crash-recovery-full-window-overlay');
      expect(overlay).toBeTruthy();
      if (!overlay) throw new Error('Expected crash recovery overlay to render');
      // The recovery UI must live inside the overlay host, not next to it.
      expect(overlay.findByProps({ testID: 'app-crash-restart' })).toBeTruthy();
    } finally {
      platform.OS = originalOs;
      consoleError.mockRestore();
    }
  });

  it('uses the native overlay fallback on Android even when react-native-screens exports FullWindowOverlay', async () => {
    const reactNative = await import('react-native');
    const platform = reactNative.Platform as { OS: string };
    const originalOs = platform.OS;
    platform.OS = 'android';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
      const Thrower = () => {
        throw new Error('boom');
      };
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
            <Thrower />
          </AppCrashRecoveryBoundary>);

      expect(screen.findAllByTestId('app-crash-recovery-full-window-overlay')).toHaveLength(0);
      const fallback = screen.findByTestId('app-crash-recovery-native-overlay-fallback');
      expect(fallback).toBeTruthy();
      if (!fallback) throw new Error('Expected native crash recovery fallback to render');
      expect(fallback.findByProps({ testID: 'app-crash-restart' })).toBeTruthy();
    } finally {
      platform.OS = originalOs;
      consoleError.mockRestore();
    }
  });

  it('does not wrap the web crash fallback in a modal host', async () => {
    const reactNative = await import('react-native');
    expect((reactNative.Platform as { OS: string }).OS).toBe('web');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
      const Thrower = () => {
        throw new Error('boom');
      };
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}>
            <Thrower />
          </AppCrashRecoveryBoundary>);

      expect(screen.findAll((node) => node.type === (reactNative.Modal as any))).toHaveLength(0);
      expect(screen.findByTestId('app-crash-restart')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
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
    expect(saved.has('happier_pre_restart_bug_report_snapshot_v1')).toBe(true);
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

    const snapshot = JSON.parse(saved.get('happier_pre_restart_bug_report_snapshot_v1') ?? '{}');
    expect(snapshot.errorDetails).toContain('boom');
    expect(snapshot.errorDetails).toContain('Thrower');
    expect(snapshot.errorDetails).toContain('AppCrashRecoveryBoundary');
    expect(saved.has('happier_restart_bug_report_intent_v1')).toBe(true);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('retains the crashing frontend, wrapper and OS facts through persistence and sanitized local export', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const { peekPreRestartBugReportSnapshot } = await import('@/utils/system/preRestartBugReportSnapshot');
    let downloaded: Blob | undefined;
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', {
      scripts: [{ src: 'https://build.example/assets/frontend-748.js?token=private-canary#secret' }],
      createElement: () => anchor,
    });
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0; Win64; x64' });
    let resolveWrapper: (value: string) => void = () => { throw new Error('Wrapper read not started'); };
    const wrapperVersion = new Promise<string>((resolve) => { resolveWrapper = resolve; });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
      if (command === 'plugin:app|version') return wrapperVersion;
      throw new Error('Unexpected desktop command');
    } });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error('Expected a downloadable Blob');
      downloaded = blob;
      return 'blob:crash-748';
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRestart = vi.fn();
    const Thrower = () => { throw new Error('crash token=private-canary'); };
    try {
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}><Thrower /></AppCrashRecoveryBoundary>);
      crashRuntime.version = '0.2.after-crash';
      await act(async () => {
        screen.findByTestId('app-crash-save-diagnostics')?.props.onPress();
        await flushPromises();
      });
      expect(screen.findByTestId('app-crash-save-diagnostics')?.props.disabled).toBe(true);
      expect(screen.findByTestId('app-crash-save-diagnostics')?.props.accessibilityState.busy).toBe(true);
      expect(screen.findByTestId('app-crash-copy-details')?.props.disabled).not.toBe(true);
      expect(anchor.click).not.toHaveBeenCalled();
      await act(async () => { resolveWrapper('0.2.wrapper-748'); await flushPromises(); });
      expect(screen.findByTestId('app-crash-save-diagnostics')?.props.disabled).not.toBe(true);
      expect(anchor.click).toHaveBeenCalledOnce();
      const text = await downloaded?.text();
      expect(text).toContain('frontend-748.js');
      expect(text).toContain('0.2.crashing-frontend');
      expect(text).toContain('0.2.wrapper-748');
      expect(text).toContain('Windows');
      expect(text).toContain('Thrower');
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain('private-canary');
      expect(text).not.toContain('0.2.after-crash');
      expect(onRestart).not.toHaveBeenCalled();
      await act(async () => {
        screen.findByTestId('app-crash-report-bug')?.props.onPress();
        await flushPromises();
      });
      const snapshot = await peekPreRestartBugReportSnapshot();
      expect(JSON.stringify(snapshot)).toContain('0.2.crashing-frontend');
      expect(JSON.stringify(snapshot)).toContain('0.2.wrapper-748');
      expect(JSON.stringify(snapshot)).toContain('frontend-748.js');
      expect(onRestart).toHaveBeenCalledOnce();
    } finally { createUrl.mockRestore(); consoleError.mockRestore(); }
  });

  it('keeps the crash copyable and retries a failed local diagnostics export even when wrapper metadata is unavailable', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { scripts: [], createElement: () => anchor });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { throw new Error('Unsupported local metadata operation'); } });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('Download unavailable'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Thrower = () => { throw new Error('retryable crash'); };
    const onRestart = vi.fn();
    try {
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}><Thrower /></AppCrashRecoveryBoundary>);
      await act(async () => {
        screen.findByTestId('app-crash-save-diagnostics')?.props.onPress();
        await flushPromises();
      });
      expect(screen.findByTestId('app-crash-report-save-failed')).toBeTruthy();
      expect(screen.findByTestId('app-crash-copy-details')).toBeTruthy();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('wrapper version is unavailable'));
      createUrl.mockReturnValue('blob:retry');
      await act(async () => {
        screen.findByTestId('app-crash-save-diagnostics')?.props.onPress();
        await flushPromises();
      });
      expect(anchor.click).toHaveBeenCalled();
      expect(screen.findAllByTestId('app-crash-report-save-failed')).toHaveLength(0);
      expect(onRestart).not.toHaveBeenCalled();
    } finally { createUrl.mockRestore(); consoleError.mockRestore(); warning.mockRestore(); }
  });

  it('opens a fresh report intent even when the crash screen has been left open for over 30 minutes', async () => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const { consumeRestartBugReportIntent } = await import('@/utils/system/restartBugReportIntent');
    const { peekPreRestartBugReportSnapshot } = await import('@/utils/system/preRestartBugReportSnapshot');
    const crashTime = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(crashTime);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Thrower = () => { throw new Error('delayed report'); };
    try {
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={() => {}}><Thrower /></AppCrashRecoveryBoundary>);
      clock.mockReturnValue(crashTime + 31 * 60 * 1000);
      await act(async () => {
        const button = screen.findByTestId('app-crash-report-bug');
        if (!button) throw new Error('missing report action');
        button.props.onPress();
        await flushPromises();
      });
      expect(await consumeRestartBugReportIntent()).toBe(true);
      expect((await peekPreRestartBugReportSnapshot())?.createdAtMs).toBe(crashTime);
    } finally { clock.mockRestore(); consoleError.mockRestore(); }
  });

  it.each(['snapshot', 'intent'])('keeps the error and copy action available when %s storage fails', async (failedPart) => {
    const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
    const Thrower = () => { throw new Error('unsaved original crash'); };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRestart = vi.fn();
    try {
      const screen = await renderScreen(<AppCrashRecoveryBoundary onRestart={onRestart}><Thrower /></AppCrashRecoveryBoundary>);
      vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => {
        if (key.includes(failedPart)) throw new Error('quota exceeded');
        saved.set(key, value);
      } });
      await act(async () => {
        const button = screen.findByTestId('app-crash-report-bug');
        if (!button) throw new Error('missing report action');
        button.props.onPress();
        await flushPromises();
      });
      expect(onRestart).not.toHaveBeenCalled();
      expect(screen.findByTestId('app-crash-report-save-failed')).toBeTruthy();
      expect(screen.findByTestId('app-crash-copy-details')).toBeTruthy();
    } finally { consoleError.mockRestore(); }
  });
});
