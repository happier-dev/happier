import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATMOSPHERE_PICTURES,
  releaseLook,
} from '@happier-dev/brand/atmosphere';
import {
  DEFAULT_HOME_ATMOSPHERE,
  type ProjectAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { AtmosphereEditor } from './atmosphereEditor';
import { LookPanel } from './LookPanel';
import { PictureControls } from './LookControls';

// This suite includes the browser Look contract. The default Node platform has no blur control.
// Substitute only the platform boundary; the shared glass controls and capability owner stay real.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// The device picture store's storage boundary: the browser store over fake IndexedDB (as the Settings Action tests do).
vi.mock(
  '@/components/atmosphere/pictureStore',
  async () => import('@/components/atmosphere/pictureStore.web'),
);

const { moments: _moments, ...HOME } = DEFAULT_HOME_ATMOSPHERE;
const painting = ATMOSPHERE_PICTURES.find(
  (picture) => picture.kind === 'painting',
)!;
const otherLook =
  releaseLook(painting).effect === 'halftone' ? 'mosaic' : 'halftone';

/** A real editor over local state: the panel's writes land exactly as an Account or project owner would get them. */
function Harness(
  props: Readonly<{
    initial: ProjectAtmosphere;
    written: ProjectAtmosphere[];
    presentation?: 'panel' | 'page';
  }>,
) {
  const [value, setValue] = React.useState(props.initial);
  const editor = React.useMemo<AtmosphereEditor>(
    () => ({
      value,
      update: (edit) =>
        setValue((current) => {
          const next = { ...current, ...edit(current) };
          props.written.push(next);
          return next;
        }),
    }),
    [props.written, value],
  );
  if (props.presentation === 'page') return <PictureControls editor={editor} presentation="page" pictures={ATMOSPHERE_PICTURES} />;
  return (
    <LookPanel editor={editor} />
  );
}

async function renderPanel(
  initial: ProjectAtmosphere,
) {
  const written: ProjectAtmosphere[] = [];
  const screen = await renderScreen(
    <Harness
      initial={initial}
      written={written}
    />,
  );
  return { screen, written, last: () => written.at(-1) };
}

describe('Look panel writes', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('places the right panels from Look, writing the one device setting the Appearance row writes', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyLocalSettings({ rightPanelPlacement: 'separate' });
    const { screen } = await renderPanel(HOME);
    expect(screen.findByTestId('look-right-panel-placement')).not.toBeNull();
    for (const value of ['line', 'shadow', 'separate'] as const) {
      await screen.pressByTestIdAsync(`look-right-panel-placement:${value}`);
      expect(storage.getState().localSettings.rightPanelPlacement).toBe(value);
    }
  });

  it('sets the planet placement, style and digits from their own controls', async () => {
    const { screen, last } = await renderPanel(HOME);
    await screen.pressByTestIdAsync('look-placement:rise');
    expect(last()?.planet).toEqual({ ...HOME.planet, placement: 'rise' });
    await screen.pressByTestIdAsync('look-style:rich');
    expect(last()?.planet.style).toBe('rich');
    await screen.pressByTestIdAsync('look-digits');
    expect(last()?.planet.digits).toBe(false);
    expect(last()?.source).toBe('planet');
  });

  it('switches the source and remembers only how this picture differs from its release look', async () => {
    const { screen, last } = await renderPanel({
      ...HOME,
      picture: { ...HOME.picture, ref: { kind: 'builtin', id: painting.id } },
    });
    await screen.pressByTestIdAsync('look-source:picture');
    expect(last()?.source).toBe('picture');
    await screen.pressByTestIdAsync(`look-effect:${otherLook}`);
    expect(last()?.looks).toEqual({ [painting.id]: { look: otherLook } });
    // Choosing the picture's own release look again leaves nothing to remember.
    await screen.pressByTestIdAsync(`look-effect:${releaseLook(painting).effect}`);
    expect(last()?.looks).toEqual({});
    await screen.pressByTestIdAsync(`look-effect:${otherLook}`);
    await screen.pressByTestIdAsync('look-fade:rows');
    expect(last()?.looks).toEqual({
      [painting.id]: { look: otherLook, dissolve: 'rows' },
    });
    await screen.pressByTestIdAsync('look-reset');
    expect(last()?.looks).toEqual({});
    await screen.pressByTestIdAsync('look-source:none');
    expect(last()?.source).toBe('none');
  });

  it.each(['panel', 'page'] as const)('selects Wallpaper from the %s without changing the authored layout', async (presentation) => {
    const initial: ProjectAtmosphere = {
      ...HOME,
      source: 'picture',
      picture: { ref: { kind: 'builtin', id: painting.id }, layout: 'horizon' },
    };
    const written: ProjectAtmosphere[] = [];
    const screen = await renderScreen(<Harness initial={initial} written={written} presentation={presentation} />);
    await screen.pressByTestIdAsync('look-layout:wallpaper');
    expect(written.at(-1)?.picture.layout).toBe('wallpaper');
    expect(screen.findByTestId('look-layout:wallpaper')?.props.accessibilityState?.checked).toBe(true);
  });
  it('keeps the glass block to the choice: no browser explanation or desktop download inside Look', async () => {
    const { screen } = await renderPanel(HOME);
    expect(screen.findByTestId('appearance-material:clear')).not.toBeNull();
    expect(screen.findByTestId('appearance-blur:strong')).not.toBeNull();
    expect(screen.findByTestId('appearance-effective-state')).toBeNull();
    expect(screen.findByTestId('appearance-desktop-download')).toBeNull();
  });

  it('says what Same as Home means and copies Home into the project when turned off', async () => {
    const written: ProjectAtmosphere[] = [];
    function Project() {
      const [same, setSame] = React.useState(true);
      const editor = React.useMemo<AtmosphereEditor>(() => ({
        value: HOME, sameAsHome: same, resetToHome: () => setSame(true),
        update: (edit) => { written.push({ ...HOME, ...edit(HOME) }); setSame(false); },
      }), [same]);
      return <LookPanel editor={editor} />;
    }
    const screen = await renderScreen(<Project />);
    expect(screen.getTextContent()).toContain(t('settingsAppearance.glassControls.sameAsHomeOn'));
    await screen.pressByTestIdAsync('look-same-as-home');
    expect(written).toEqual([HOME]);
    expect(screen.getTextContent()).toContain(t('settingsAppearance.glassControls.sameAsHomeOff'));
    expect(screen.getTextContent()).not.toContain(t('settingsAppearance.glassControls.sameAsHomeOn'));
  });

  it.each(['panel', 'page'] as const)('allows a Fade-only choice to reset and Shuffle on the %s', async (presentation) => {
    const initial: ProjectAtmosphere = { ...HOME, source: 'picture',
      picture: { ...HOME.picture, ref: { kind: 'builtin', id: painting.id } },
      looks: { [painting.id]: { dissolve: 'rows' } } };
    const written: ProjectAtmosphere[] = [];
    const screen = await renderScreen(<Harness initial={initial} written={written} presentation={presentation} />);
    await screen.pressByTestIdAsync('look-reset');
    expect(written.at(-1)?.looks).toEqual({});
    await screen.pressByTestIdAsync('look-shuffle');
    expect(written.at(-1)?.picture.ref).not.toEqual(initial.picture.ref);
  });
});
