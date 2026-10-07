import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { HappierInfoState, HappierInfoTile } from '../presentation/state/InfoState.js';
import { HappierStatus } from '../presentation/status/Status.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { defineHappierScene, defineHappierSceneProp, type HappierSceneRenderRequest } from '../presentation/state/scenes.js';
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import { Button, EmptyState, ErrorState, FreshnessLine, LoadingState, Spinner, State, Status } from './index.js';

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
  it('honors explicit transition urgency on a compact failure line', () => {
    const mount = mountSurface(<ErrorState layout="line" title="Save failed" accessibilitySemantics="alert" />);
    const alert = mount.container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Save failed');
    expect(mount.container.querySelector('[role="alert"]')?.getAttribute('aria-live')).toBe('assertive');
    mount.unmount();
  });
  it('honors explicit status semantics on an unsized empty state', () => {
    const mount = mountSurface(<EmptyState title="All caught up" accessibilitySemantics="status" />);
    expect(mount.container.querySelector('[role="status"]')).not.toBeNull();
    expect(mount.container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    mount.unmount();
  });
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

  it('renders destination-shaped skeleton rows, named once, instead of a centered spinner', () => {
    const mount = mountSurface(
      <LoadingState title="Reading the list" rows={4} testID="rows-loading" />,
    );

    const progressbars = [...mount.container.querySelectorAll<HTMLElement>('[role="progressbar"]')];
    // One named busy region for the whole placeholder: a spinner beside the
    // rows would announce the same wait twice.
    expect(progressbars).toHaveLength(1);
    expect(progressbars[0]?.getAttribute('aria-label')).toBe('Reading the list');
    expect(progressbars[0]?.getAttribute('aria-busy')).toBe('true');
    // The placeholder draws the rows it stands in for, and no visible prose.
    expect(progressbars[0]?.children).toHaveLength(4);
    expect(mount.container.textContent).toBe('');

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

  it('keeps static failures quiet and announces only explicitly urgent failures', () => {
    const mount = mountSurface(
      <>
        <LoadingState title="Loading reviews" />
        <EmptyState title="No reviews" />
        <ErrorState title="Reviews could not load" description="Try again." />
        <ErrorState title="Save failed" accessibilitySemantics="alert" />
      </>,
    );

    const alerts = [...mount.container.querySelectorAll<HTMLElement>('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('Save failed');
    expect(alerts[0]?.getAttribute('aria-live')).toBe('assertive');

    mount.unmount();
  });

  it('supports unavailable and denied line states without exposing diagnostic detail or announcing', () => {
    const mount = mountSurface(
      <>
        <ErrorState kind="unavailable" layout="line" title="Machine offline" details="machine_offline" />
        <ErrorState kind="denied" layout="line" title="Ask an administrator" />
        <LoadingState layout="line" title="Reading reviews" />
      </>,
    );
    expect(mount.container.textContent).toContain('Machine offline');
    expect(mount.container.textContent).toContain('Ask an administrator');
    expect(mount.container.textContent).not.toContain('machine_offline');
    expect(mount.container.querySelector('[role="alert"], [aria-live="assertive"]')).toBeNull();
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

  it('speaks a composed status meaning once when the shared owner is given one', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <HappierStatus
          tone="danger"
          theme={context.theme}
          testID="declarative-status"
          // A neutral label plus a `danger` tone is the exact shape that reaches
          // sighted users as colour and assistive technology as nothing at all.
          label="Deployment"
          value="12 minutes"
          accessibilityLabel="Error: Deployment: 12 minutes"
        />
      </PluginUiProvider>,
    );

    const status = mount.container.querySelector<HTMLElement>('[data-testid="declarative-status"]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-label')).toBe('Error: Deployment: 12 minutes');
    // The dot stays decoration and nothing beneath the region repeats the
    // meaning: it is named exactly once, on the region itself.
    expect(status?.querySelector('[role="img"]')).toBeNull();
    expect(status?.querySelectorAll('[aria-label]')).toHaveLength(0);

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
    // The copy is painted from the projected theme, and calmly: the title is
    // ordinary text (the glyph carries the tone), never an alarm-red headline.
    const paintedColors = [...mount.container.querySelectorAll('*')].flatMap((element) => {
      const color = (element as HTMLElement).style?.color;
      return color !== undefined && color !== '' ? [normalizeColor(color)] : [];
    });
    expect(paintedColors).toContain(context.theme.colors.text.toLowerCase());
    expect(paintedColors).not.toContain(context.theme.colors.danger.toLowerCase());

    mount.unmount();
  });

  it('keeps an error calm and its diagnostic behind a collapsed Details disclosure', async () => {
    const context = createSurfaceContext({
      translations: { 'happier.plugin-ui.state.details': 'Details' },
    });
    const mount = mountSurface(
      <ErrorState
        title="The list could not be read"
        accessibilitySemantics="alert"
        description="Try again in a moment."
        details="unavailable · host_api_method_unavailable:executeAction"
      />,
      context,
    );

    // The sentence leads; the machine code is not on screen until asked for.
    expect(mount.container.textContent).toContain('The list could not be read');
    expect(mount.container.textContent).not.toContain('host_api_method_unavailable');
    const toggle = mount.container.querySelector<HTMLElement>('[aria-expanded="false"]');
    expect(toggle?.textContent).toBe('Details');
    // Expanding the disclosure is not part of the alert: the live region keeps
    // announcing only the failure itself.
    expect(mount.container.querySelector('[role="alert"]')?.contains(toggle ?? null)).toBe(false);

    await act(async () => { toggle?.click(); });
    expect(mount.container.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(mount.container.textContent).toContain('unavailable · host_api_method_unavailable:executeAction');

    mount.unmount();
  });

  it('offers a status notice its next action beside the sentence, outside the live region', () => {
    const mount = mountSurface(
      <Status
        tone="warning"
        label="Happier cannot reach your account right now, so pins and saved views cannot be changed."
        action={<Button title="Retry" variant="plain" onPress={() => undefined} />}
      />,
    );

    const region = mount.container.querySelector('[role="status"]');
    const action = [...mount.container.querySelectorAll('[role="button"]')]
      .find((node) => node.textContent === 'Retry');
    expect(region?.textContent).toContain('cannot reach your account');
    expect(action).toBeDefined();
    // Pressing Retry, or its busy state, is not news the status announces.
    expect(region?.contains(action ?? null)).toBe(false);
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

/** The readable measure a state's copy column is laid out in (`HappierInfoTile`). */
function measureOf(mount: ReturnType<typeof mountSurface>, title: string): string | null {
  const titleNode = Array.from(mount.container.querySelectorAll<HTMLElement>('div, span'))
    .find((element) => element.textContent === title && element.children.length === 0);
  for (let element = titleNode?.parentElement ?? null; element; element = element.parentElement) {
    if (element.style.maxWidth) return element.style.maxWidth;
  }
  return null;
}

function mountInHost(children: ReactNode, host: Partial<PluginUiPresentationHost>) {
  const context = createSurfaceContext();
  const presentationHost = {
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...host,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
      {children}
    </PluginUiProviderInternal>,
  );
}

describe('plugin states take the container they are mounted in (lab 5 host primitives)', () => {
  it('offers a quiet second way under the empty state\'s one primary action', () => {
    const mount = mountSurface(
      <EmptyState
        title="Nothing is linked yet"
        action={<Button testID="primary" title="Attach a PR or issue" onPress={() => {}} />}
        secondaryAction={<Button testID="secondary" variant="plain" title="Browse PRs & Issues" onPress={() => {}} />}
      />,
    );
    const primary = mount.container.querySelector('[data-testid="primary"]');
    const secondary = mount.container.querySelector('[data-testid="secondary"]');
    expect(primary).not.toBeNull();
    expect(secondary, 'the second way renders with the state').not.toBeNull();
    // The one primary leads; the second way follows it in reading order.
    expect(primary!.compareDocumentPosition(secondary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    mount.unmount();
  });

  it('sizes an unsized state by the host container, and an explicit size still wins', () => {
    const inPane = mountInHost(<EmptyState title="No conversations" />, { stateSize: 'pane' });
    expect(measureOf(inPane, 'No conversations')).toBe('272px');
    inPane.unmount();

    const explicit = mountInHost(<ErrorState title="Could not load" size="details" />, { stateSize: 'pane' });
    expect(measureOf(explicit, 'Could not load')).toBe('380px');
    explicit.unmount();

    const unsized = mountSurface(<LoadingState title="Loading" />);
    expect(measureOf(unsized, 'Loading')).toBe('520px');
    unsized.unmount();
  });

  it('draws a Daybreak scene through the host renderer in the glyph\'s place, and keeps text in a line', () => {
    const requests: HappierSceneRenderRequest[] = [];
    const host: Partial<PluginUiPresentationHost> = {
      stateSize: 'pane',
      renderIcon: (input) => <span data-testid={`glyph-${input.name}`} />,
      renderScene: (input) => {
        requests.push(input);
        return <span data-testid={`scene-${input.scene.name}-${input.size}`} />;
      },
    };
    const deploys = defineHappierScene({
      name: 'acme.no-deploys',
      base: 'nothingListening',
      props: [{ prop: defineHappierSceneProp({ name: 'acme.crate', marks: [{ shape: 'rect', x: -6, y: -8, width: 12, height: 8 }] }), x: 104 }],
    });

    const pane = mountInHost(<EmptyState testID="deploys" icon="search" scene={deploys} title="No deploys yet" />, host);
    expect(pane.container.querySelector('[data-testid="scene-acme.no-deploys-pane"]')).not.toBeNull();
    expect(pane.container.querySelector('[data-testid="glyph-search"]'), 'the scene replaces the glyph').toBeNull();
    expect(requests.at(-1)?.scene.layers.at(-1)).toMatchObject({ name: 'acme.crate', x: 104, y: 46 });
    expect(requests.at(-1)?.testID).toBe('deploys-scene');
    pane.unmount();

    const page = mountInHost(<EmptyState layout="page" scene="noMatch" title="Nothing matches" />, host);
    expect(page.container.querySelector('[data-testid="scene-noMatch-page"]')).not.toBeNull();
    page.unmount();

    const line = mountInHost(<EmptyState layout="line" scene="noMatch" title="Nothing matches" />, host);
    expect(line.container.querySelector('[data-testid^="scene-"]'), 'a compact line stays text only').toBeNull();
    line.unmount();

    // A host without a scene renderer keeps the author's glyph.
    const bare = mountInHost(<EmptyState icon="search" scene="noMatch" title="Nothing matches" />, { stateSize: 'pane', renderIcon: host.renderIcon });
    expect(bare.container.querySelector('[data-testid="glyph-search"]')).not.toBeNull();
    bare.unmount();
  });
});

describe('FreshnessLine: stale content told in one line', () => {
  it('says as of when and why, as one polite status, and offers the one recovery', async () => {
    let retried = 0;
    const asOf = new Date(2026, 8, 29, 10, 42).getTime();
    const mount = mountSurface(
      <FreshnessLine
        testID="fresh"
        asOf={asOf}
        now={new Date(2026, 8, 29, 11, 0).getTime()}
        reason="Channels isn't reachable on MacBook Pro"
        action={{ label: 'Retry', onPress: () => { retried += 1; } }}
      />,
    );
    const line = mount.container.querySelector<HTMLElement>('[data-testid="fresh"]');
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.getAttribute('aria-live')).toBe('polite');
    expect(line?.textContent).toMatch(/^As of 10:42.* · Channels isn't reachable on MacBook Pro/u);
    const retry = mount.container.querySelector<HTMLElement>('[data-testid="fresh-action"]');
    expect(retry?.getAttribute('role')).toBe('button');
    await act(async () => { retry?.click(); });
    expect(retried).toBe(1);
    mount.unmount();
  });

  it('shows a reconnect in flight with the reason alone and no stale time', () => {
    const mount = mountSurface(<FreshnessLine testID="fresh" reason="Reconnecting…" busy />);
    const line = mount.container.querySelector<HTMLElement>('[data-testid="fresh"]');
    expect(line?.textContent).toBe('Reconnecting…');
    expect(line?.getAttribute('aria-busy')).toBe('true');
    mount.unmount();
  });
});

function normalizeColor(color: string): string {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color.trim());
  if (!rgb) return color.trim().toLowerCase();
  const [, r, g, b] = rgb;
  return `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}
