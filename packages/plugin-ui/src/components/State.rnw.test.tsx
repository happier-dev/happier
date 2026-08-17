import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { HappierInfoState, HappierInfoTile } from '../presentation/state/InfoState.js';
import { HappierStatus } from '../presentation/status/Status.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { EmptyState, ErrorState, LoadingState, Spinner, State, Status } from './index.js';

/**
 * EU-7b, family `Spinner` / `LoadingState` / `EmptyState` / `ErrorState` /
 * `Status` — the §3.10.9.2 row that makes journey J1 ("shows loading / empty /
 * error / ready state") buildable through public API.
 *
 * RED at 2026-08-07: `State` rendered `createElement('happier-plugin-state', …)`
 * and the resolvable states had no components at all, so an author's surface
 * shipped an inert custom element in place of every non-ready state. React DOM
 * renders an unknown tag happily, which is why the assertions below are written
 * against a real React-Native-Web mount rather than a serialized tree.
 *
 * This mount is supporting evidence only (§7 excludes jsdom from layer 6); the
 * packed browser and device lanes own the gate.
 */
function mountSurface(children: ReactNode, context?: SurfaceContext) {
  const resolved = context ?? createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(resolved)} context={resolved}>
      {children}
    </PluginUiProvider>,
  );
}

describe('plugin-ui resource state renders real React Native semantics', () => {
  it('keeps state announcement semantics on the shared state owner', () => {
    const mount = mountSurface(
      <HappierInfoState
        testID="declarative-state"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        busy
      >
        <HappierInfoTile title="Repository sync failed" />
      </HappierInfoState>,
    );

    const state = mount.container.querySelector<HTMLElement>('[role="alert"]');
    expect(state, 'the shared state owner must expose the asserted announcement role').not.toBeNull();
    expect(state?.getAttribute('aria-live')).toBe('polite');
    expect(state?.getAttribute('aria-busy')).toBe('true');

    mount.unmount();
  });

  it('does not announce an idle state as busy', () => {
    const mount = mountSurface(
      <HappierInfoState testID="idle-state" busy={false}>
        <HappierInfoTile title="No repositories" />
      </HappierInfoState>,
    );

    expect(mount.container.querySelector('[aria-busy]')).toBeNull();

    mount.unmount();
  });

  it('never emits a happier-plugin-* marker element for any resource status', () => {
    for (const resource of [
      { status: 'loading' },
      { status: 'empty' },
      { status: 'error', message: 'Upstream refused the request' },
      { status: 'ready', value: 'Ready' },
    ] as const) {
      const mount = mountSurface(
        <State resource={resource}>{(value: string) => <Spinner accessibilityLabel={value} />}</State>,
      );

      expect(mount.container.innerHTML).not.toContain('happier-plugin-');
      mount.unmount();
    }
  });

  it('renders a real progressbar while the resource is loading', () => {
    const mount = mountSurface(<State resource={{ status: 'loading' }} />);

    const progressbar = mount.container.querySelector('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    // A marker element carries neither a role nor RNW's generated class, which
    // is what makes this discriminating against the predecessor.
    expect(progressbar?.className).toContain('css-view');

    mount.unmount();
  });

  it('resolves default loading, empty, and error copy through the host translation owner', () => {
    const context = createSurfaceContext({
      translations: {
        'happier.plugin-ui.state.loading': 'Chargement des éléments',
        'happier.plugin-ui.state.empty': 'Aucun élément à afficher',
        'happier.plugin-ui.state.error': 'Les éléments n’ont pas pu être chargés',
      },
    });
    const mount = mountSurface(
      <>
        <State resource={{ status: 'loading' }} />
        <State resource={{ status: 'empty' }} />
        <State resource={{ status: 'error' }} />
      </>,
      context,
    );

    expect(mount.container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
      'Chargement des éléments',
    );
    expect(mount.container.textContent).toContain('Aucun élément à afficher');
    expect(mount.container.textContent).toContain('Les éléments n’ont pas pu être chargés');

    mount.unmount();
  });

  it('announces an error state without turning loading or empty copy into an alert', () => {
    const mount = mountSurface(
      <>
        <LoadingState title="Loading reviews" />
        <EmptyState title="No reviews" />
        <ErrorState title="Reviews could not load" description="Try again." />
      </>,
    );

    const alerts = [...mount.container.querySelectorAll<HTMLElement>('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('Reviews could not load');
    expect(alerts[0]?.getAttribute('aria-live')).toBe('assertive');

    mount.unmount();
  });

  it('renders a status as one polite semantic region while keeping its dot decorative', () => {
    const mount = mountSurface(<Status tone="success" label="Connected" testID="connection-status" />);

    const status = mount.container.querySelector<HTMLElement>('[data-testid="connection-status"]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('Connected');
    expect(status?.querySelector('[role="img"]')).toBeNull();

    mount.unmount();
  });

  it('makes the shared status indicator more distinct in high-contrast mode', () => {
    const context = createSurfaceContext({ contrast: 'high' });
    const mount = mountSurface(<Status tone="success" label="Connected" testID="connection-status" />, context);
    const status = mount.container.querySelector<HTMLElement>('[data-testid="connection-status"]');
    const dot = [...(status?.querySelectorAll<HTMLElement>('*') ?? [])].find((candidate) => (
      normalizeColor(getComputedStyle(candidate).backgroundColor) === context.theme.colors.success.toLowerCase()
    ));

    expect(dot).toBeTruthy();
    expect(getComputedStyle(dot!).width).toBe('8px');
    expect(getComputedStyle(dot!).borderTopWidth).toBe('1px');
    expect(normalizeColor(getComputedStyle(dot!).borderTopColor)).toBe(context.theme.colors.text.toLowerCase());

    mount.unmount();
  });

  it('keeps the shared status hook order when explicit contrast is added after mount', async () => {
    const context = createSurfaceContext();
    const renderStatus = (contrast?: 'high') => (
      <HappierStatus
        label="Connected"
        tone="success"
        theme={context.theme}
        {...(contrast === undefined ? {} : { contrast })}
      />
    );
    const mount = mountThroughReactNativeWeb(renderStatus());

    try {
      await expect(mount.render(renderStatus('high'))).resolves.toBeUndefined();
      expect(mount.container.querySelector('[role="status"]')?.textContent).toContain('Connected');
    } finally {
      mount.unmount();
    }
  });

  it('paints the projected theme on translated default error copy without exposing diagnostics', () => {
    const context = createSurfaceContext({
      translations: {
        'happier.plugin-ui.state.error': 'Could not load the resource',
      },
    });
    const mount = mountSurface(
      <State resource={{ status: 'error', code: 'provider_response_invalid', message: 'provider_response_invalid' }} />,
      context,
    );

    expect(mount.container.textContent).toContain('Could not load the resource');
    expect(mount.container.textContent).not.toContain('provider_response_invalid');
    const painted = [...mount.container.querySelectorAll('*')].some((element) => {
      const color = (element as HTMLElement).style?.color;
      return color !== undefined && color !== '' && normalizeColor(color) === context.theme.colors.danger.toLowerCase();
    });
    expect(painted).toBe(true);

    mount.unmount();
  });

  it('renders the empty state title and description as real text', () => {
    const mount = mountSurface(
      <State
        resource={{ status: 'empty' }}
        empty={<EmptyState title="No findings" description="This project is clean." />}
      />,
    );

    expect(mount.container.textContent).toContain('No findings');
    expect(mount.container.textContent).toContain('This project is clean.');
    expect(mount.container.querySelector('happier-plugin-state')).toBeNull();

    mount.unmount();
  });

  it('renders Status, Spinner, LoadingState and ErrorState without any marker element', () => {
    const mount = mountSurface(
      <>
        <Status tone="success" label="Connected" />
        <Spinner accessibilityLabel="Loading" />
        <LoadingState title="Loading findings" />
        <ErrorState title="Could not load" description="Try again." />
      </>,
    );

    expect(mount.container.innerHTML).not.toContain('happier-plugin-');
    expect(mount.container.textContent).toContain('Connected');
    expect(mount.container.textContent).toContain('Loading findings');
    expect(mount.container.textContent).toContain('Could not load');
    expect(mount.container.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0);

    mount.unmount();
  });
});

function normalizeColor(color: string): string {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color.trim());
  if (!rgb) return color.trim().toLowerCase();
  const [, r, g, b] = rgb;
  return `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}
