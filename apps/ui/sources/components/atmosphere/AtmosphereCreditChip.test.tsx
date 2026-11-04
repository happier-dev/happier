import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import Color from 'color';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import Constants from 'expo-constants';
import { commitRemoteManifest, resetManifestRuntimeCacheForTests } from '@/changelog/releaseNotes/manifestRuntime';
import { clearCachedManifest, clearLastSeenReleaseId, setLastSeenReleaseId } from '@/changelog/releaseNotes/storage';
import { AtmosphereTopChips } from './AtmosphereCreditChip';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const presentation = vi.hoisted(() => ({ renders: 0 }));
// The Android renderer and Unistyles adapter are platform boundaries; material decisions stay real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  const native = await createReactNativeNativeMock({ platformOS: 'android' });
  const React = await import('react');
  return { ...native, View: React.forwardRef<import('react-native').View, import('react-native').ViewProps>((props, ref) => {
    // Count work delivered to the native anchor boundary, including the slot and Look anchor.
    if (props.collapsable === false) presentation.renders++;
    return React.createElement(native.View, { ...props, ref });
  }) };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: routerMock.push } }).module;
});

// The installed app's version is a platform constant (an environment boundary).
vi.mock('@/sync/runtime/readCurrentAppRuntimeInfo', () => ({
  readCurrentAppRuntimeInfo: () => ({ appVersion: '0.3.4' }),
}));

// The portal host and the overlay surface are platform presentation boundaries; the caption,
// the release-notes launcher and the Look popover's content render for real beneath them.
vi.mock('@/components/ui/popover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/popover')>()),
  Popover: (
    props: Record<string, unknown> & {
      children: (layout: { maxHeight: number; maxWidth: number; presentation: 'popover' }) => React.ReactNode;
    },
  ) => React.createElement('Popover', props, props.children({ maxHeight: 700, maxWidth: 400, presentation: 'popover' })),
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/overlays/FloatingOverlay')>()),
  FloatingOverlay: (props: Record<string, unknown>) =>
    React.createElement('FloatingOverlay', props, props.children as React.ReactNode),
}));

// The device picture store's storage boundary: the browser store over fake IndexedDB.
vi.mock(
  '@/components/atmosphere/pictureStore',
  async () => import('@/components/atmosphere/pictureStore.web'),
);

const photo = ATMOSPHERE_PICTURES.find((picture) => picture.kind === 'photo')!;

async function renderChips(releaseCaption: boolean) {
  storage.getState().applySettingsLocal({
    homeAtmosphere: {
      ...DEFAULT_HOME_ATMOSPHERE,
      source: 'picture',
      picture: { ref: { kind: 'builtin', id: photo.id }, layout: 'horizon' },
      moments: { ...DEFAULT_HOME_ATMOSPHERE.moments, releaseCaption },
    },
  });
  return renderScreen(
    <AtmosphereTopChips picture={photo} lookTarget={{ surface: 'home' }} />,
  );
}

describe('the release caption on Home', () => {
  beforeEach(async () => {
    routerMock.push.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await storage
      .getState()
      .activateSettingsScope({
        serverId: 'caption-home',
        accountId: 'caption-account',
      });
    storage.getState().applySettings(settingsDefaults, 1);
    storage.setState({ isDataReady: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does no stable chip presentation work for 50 unrelated parent renders while caption and Look state stay live', async () => {
    const lookTarget = { surface: 'home' } as const;
    const scene = (revision: number) => <React.Fragment>
      {revision}<AtmosphereTopChips picture={photo} lookTarget={lookTarget} />
    </React.Fragment>;
    const screen = await renderScreen(scene(0));
    presentation.renders = 0;
    for (let revision = 1; revision <= 50; revision++) await screen.update(scene(revision));
    expect(presentation.renders).toBe(0);
    await act(async () => {
      const atmosphere = storage.getState().settings.homeAtmosphere;
      storage.getState().applySettingsLocal({ homeAtmosphere: {
        ...atmosphere, moments: { ...atmosphere.moments, releaseCaption: false },
      } });
    });
    expect(screen.findByTestId('atmosphere.caption')).toBeNull();
    expect(screen.findByTestId('atmosphere.credit')).not.toBeNull();
    await screen.pressByTestIdAsync('atmosphere.credit');
    await screen.pressByTestIdAsync('atmosphere.caption.backdrop');
    expect(screen.findByTestId('look-popover')).not.toBeNull();
    await screen.unmount();
  });

  it('paints the caption with Elements rather than the menu coat, keeping Solid opaque', async () => {
    const scene = (solid: boolean) => <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: solid ? glassPresetMaterials('solid') : {
        ...glassPresetMaterials('clear'), card: { blur: 'off', opacity: 0.347 }, floating: { blur: 'off', opacity: 0.02 },
      } }}>
        <AtmosphereTopChips picture={photo} lookTarget={{ surface: 'home' }} />
      </GlassMaterialSettingsProvider>
    </GlassRuntimeEnvironmentProvider>;
    const screen = await renderScreen(scene(false));
    const captionAlphas = () => screen.findByTestId('atmosphere.credit')!.findAllByType('View')
      .map(view => flattenTestStyle(view.props.style).backgroundColor)
      .filter((color): color is string => typeof color === 'string')
      .map(color => Color(color).alpha());
    expect(captionAlphas()[0]).toBe(0.347);
    await screen.update(scene(true));
    expect(captionAlphas()[0]).toBe(1);
    await screen.unmount();
  });

  it('says this version on the chip only while its release is unread', async () => {
    const originalExpoConfig = Constants.expoConfig;
    // The installed version is an Expo/platform boundary; the manifest enters through its real owner.
    Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: { ...originalExpoConfig, version: '0.3.4' } });
    clearLastSeenReleaseId();
    clearCachedManifest();
    resetManifestRuntimeCacheForTests();
    try {
      expect(commitRemoteManifest(JSON.stringify({ schemaVersion: 'v1', latestReleaseId: 'v0.3.4', generatedAt: '2026-01-01T00:00:00.000Z',
        assetBaseUrl: 'https://cdn.example/releases/', releases: [{ releaseId: 'v0.3.4', versionLabel: 'v0.3.4', publishedAt: '2026-01-01T00:00:00.000Z',
          titleKey: 'releaseNotes.title', cards: [{ kind: 'list', titleKey: 'releaseNotes.cards.0.title', rows: [{ iconId: 'sparkles', titleKey: 'a', bodyKey: 'b' }] }] }] }))).not.toBeNull();
      const screen = await renderChips(true);
      expect(screen.findByTestId('atmosphere.caption')?.props.accessibilityLabel).toContain('0.3.4');
      await act(async () => { setLastSeenReleaseId('v0.3.4'); });
      expect(screen.findByTestId('atmosphere.caption')).toBeNull();
      expect(screen.findByTestId('atmosphere.credit')?.props.accessibilityLabel).not.toContain('0.3.4');
    } finally {
      clearLastSeenReleaseId();
      clearCachedManifest();
      resetManifestRuntimeCacheForTests();
      Object.defineProperty(Constants, 'expoConfig', { configurable: true, value: originalExpoConfig });
    }
  });

  it("keeps What's new in the card once the release has been read, and opens the existing release notes", async () => {
    const screen = await renderChips(true);
    expect(screen.getTextContent()).toContain(photo.title);
    expect(screen.getTextContent()).not.toContain('0.3.4');

    await screen.pressByTestIdAsync('atmosphere.credit');
    expect(screen.getTextContent()).toContain(photo.credit.author);

    // No unread release story here, so What's new is the full release notes.
    await screen.pressByTestIdAsync('atmosphere.caption.whats-new');
    expect(routerMock.push).toHaveBeenCalledWith('/(app)/changelog');
  });

  it('opens the Look popover from Backdrop', async () => {
    const screen = await renderChips(true);
    expect(screen.findByTestId('look-popover')).toBeNull();

    await screen.pressByTestIdAsync('atmosphere.credit');
    await screen.pressByTestIdAsync('atmosphere.caption.backdrop');
    expect(screen.findByTestId('look-popover')).not.toBeNull();
    expect(screen.findByTestId('atmosphere.caption.whats-new')).toBeNull();
  });

  it('is the plain credit chip when its moment is off', async () => {
    const screen = await renderChips(false);
    expect(screen.findByTestId('atmosphere.caption')).toBeNull();
    expect(screen.findByTestId('atmosphere.credit')).not.toBeNull();
    expect(screen.getTextContent()).toContain(photo.title);
    expect(screen.getTextContent()).not.toContain('0.3.4');
  });

  it('opens the same card from the plain credit chip, with the credit and Backdrop but no What\'s new', async () => {
    const screen = await renderChips(false);
    await screen.pressByTestIdAsync('atmosphere.credit');
    expect(screen.findByTestId('atmosphere.caption.credit')).not.toBeNull();
    expect(screen.getTextContent()).toContain(photo.credit.author);
    expect(screen.findByTestId('atmosphere.caption.whats-new')).toBeNull();
    await screen.pressByTestIdAsync('atmosphere.caption.backdrop');
    expect(screen.findByTestId('look-popover')).not.toBeNull();
  });
});
