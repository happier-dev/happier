import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  flattenTestStyle,
  renderSettingsView,
  standardCleanup,
} from '@/dev/testkit';
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
afterEach(standardCleanup);

const { ThemeTryBar } = await import('./ThemeTryBar');
const {
  SessionCockpitChromeRegistryProvider,
  useSessionCockpitBottomChromeHeightSetter,
} =
  await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');

/** The app's floating bottom bar reports its measured height, as the mobile chrome host does. */
function BottomChrome(props: Readonly<{ height: number }>) {
  const setHeight = useSessionCockpitBottomChromeHeightSetter();
  React.useEffect(() => {
    setHeight(props.height);
  }, [props.height, setHeight]);
  return null;
}

it('stands the try bar above the floating bottom bar, so Revert and Install stay reachable', async () => {
  // Live 390 (DESIGN-LAB-1117 C2b): the floating tab bar covered Revert.
  const screen = await renderSettingsView(
    <SessionCockpitChromeRegistryProvider>
      <BottomChrome height={80} />
      <ThemeTryBar
        visible
        faceName="Atlas Light"
        miniature={null}
        here="this device"
        busy={null}
        installLabel="Apply"
        onRevert={() => {}}
        onInstall={() => {}}
        testID="try"
      />
    </SessionCockpitChromeRegistryProvider>,
  );
  await act(async () => {});
  const bar = screen.findByTestId('try')!;
  // How far up from the window's bottom the bar stands: the absolutely placed boxes around it.
  let lift = 0;
  for (let node = bar.parent; node; node = node.parent) {
    const style = flattenTestStyle(node.props?.style) as { position?: string; bottom?: unknown } | undefined;
    if (style?.position === 'absolute' && typeof style.bottom === 'number') lift = Math.max(lift, style.bottom);
  }
  expect(lift).toBeGreaterThan(80);
  expect(screen.getTextContent()).toContain('Apply');
});

it('keeps naming the tried theme while it leaves, so Revert never flashes the restored theme', async () => {
  // Live 1440 (ACCEPT-THEMES-1118): on Revert the leaving bar read "Trying Default theme" with Keep in place of Install.
  let settle: (next: { faceName: string; origin: 'store' | 'editor' } | null) => void = () => {};
  function Host() {
    const [preview, setPreview] = React.useState<{ faceName: string; origin: 'store' | 'editor' } | null>({ faceName: 'Ayu Light', origin: 'store' });
    settle = setPreview;
    return (
      <ThemeTryBar
        visible={preview !== null}
        faceName={preview?.faceName ?? 'Default theme'}
        origin={preview?.origin ?? 'editor'}
        miniature={null}
        here="this device"
        busy={null}
        onRevert={() => {}}
        onInstall={() => {}}
        testID="try"
      />
    );
  }
  const screen = await renderSettingsView(<Host />);
  await act(async () => {});
  const before = screen.getTextContent();
  expect(before).toContain('Ayu Light');
  await act(async () => { settle(null); });
  // Still on screen for its exit, with the words it had.
  expect(screen.findByTestId('try')).not.toBeNull();
  expect(screen.getTextContent()).toBe(before);
});
