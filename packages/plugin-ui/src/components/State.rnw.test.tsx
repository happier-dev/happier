import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import type { PluginUiResourceSnapshot } from '../hostApi/resourceStore.js';
import { usePluginResource } from '../hostApi/index.js';
import { HappierInfoState, HappierInfoTile } from '../presentation/state/InfoState.js';
import { HappierStatus } from '../presentation/status/Status.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { defineHappierScene, defineHappierSceneProp, type HappierSceneRenderRequest } from '../presentation/state/scenes.js';
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import { Button, EmptyState, ErrorState, FreshnessLine, LoadingState, Spinner, State, Status } from './index.js';
import { SceneArt } from './State.js';
import { PluginUiSurfaceNoticeContext } from '../presentationHost/surfaceNotice.js';

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

const INITIAL_RESOURCE = { freshness: 'unknown', pending: 'initial', subscription: 'unsupported' } as const satisfies PluginUiResourceSnapshot;
const READY_RESOURCE = {
  value: { contentType: 'text/plain', digest: `sha256:${'1'.repeat(64)}`, bytes: new TextEncoder().encode('Ready') },
  freshness: 'fresh', pending: 'idle', subscription: 'unsupported',
} as const satisfies PluginUiResourceSnapshot;
const FAILED_RESOURCE = { freshness: 'unknown', pending: 'idle', subscription: 'unsupported', error: { message: 'Upstream refused the request' } } as const satisfies PluginUiResourceSnapshot;

describe('plugin-ui resource state renders real React Native semantics', () => {
  it('renders real Resource hook initial failure, retry and retained refresh failure', async () => {
    const context = createSurfaceContext();
    let available = false;
    const hostApi = createHostApiStub(context, {
      readResource: async () => {
        if (!available) throw new PluginError({ code: 'unavailable', message: 'Machine offline' });
        return READY_RESOURCE.value;
      },
    });
    function Harness() {
      const { resource, refresh } = usePluginResource('reviews');
      return <State resource={resource} onRetry={refresh}>
        {(content) => <span data-testid="hook-content">{new TextDecoder().decode(content.bytes)}</span>}
      </State>;
    }
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={hostApi} context={context}><Harness /></PluginUiProvider>);
    try {
      expect(mount.container.querySelector('[role="progressbar"]')).not.toBeNull();
      await act(async () => {});
      expect(mount.container.querySelector('[role="progressbar"]')).toBeNull();
      expect(mount.container.querySelector('[data-testid="hook-content"]')).toBeNull();
      available = true;
      await act(async () => { mount.container.querySelector<HTMLElement>('[role="button"]')?.click(); });
      expect(mount.container.querySelector('[data-testid="hook-content"]')?.textContent).toBe('Ready');
      available = false;
      // A consumer owns the refresh trigger; State renders the canonical resulting snapshot.
      await mount.render(<PluginUiProvider hostApi={hostApi} context={context}><Harness /><Refresh /></PluginUiProvider>);
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="refresh-resource"]')?.click(); });
      expect(mount.container.querySelector('[data-testid="hook-content"]')?.textContent).toBe('Ready');
      expect(mount.container.textContent).toContain('Machine offline');
    } finally { mount.unmount(); }
    function Refresh() {
      const { refresh } = usePluginResource('reviews');
      return <Button title="Refresh" testID="refresh-resource" onPress={refresh} />;
    }
  });
  it('retains admitted content through refresh, failure and graceful subscription completion', async () => {
    const value = { contentType: 'text/plain', digest: 'sha256:retained', bytes: new TextEncoder().encode('Last known reviews') };
    const context = createSurfaceContext({ translations: {
      'happier.plugin-ui.state.refreshing': 'Actualisation en cours',
      'happier.plugin-ui.state.stale': 'Contenu à actualiser',
    } });
    const render = (resource: PluginUiResourceSnapshot) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <State resource={resource}>{(content) => <span data-testid="retained">{new TextDecoder().decode(content.bytes)}</span>}</State>
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(render({ value, freshness: 'fresh', pending: 'idle', subscription: 'live' }));
    try {
      expect(mount.container.querySelector('[data-testid="retained"]')?.textContent).toBe('Last known reviews');
      const retained = mount.container.querySelector('[data-testid="retained"]');
      await mount.render(render({ value, freshness: 'stale', pending: 'refresh', subscription: 'reconnecting' }));
      expect(mount.container.querySelector('[data-testid="retained"]')).toBe(retained);
      expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(mount.container.textContent).toContain('Actualisation en cours');
      await mount.render(render({ value, freshness: 'stale', pending: 'idle', subscription: 'unsupported' }));
      expect(mount.container.querySelector('[data-testid="retained"]')).toBe(retained);
      expect(mount.container.textContent).toContain('Contenu à actualiser');
      await mount.render(render({ value, freshness: 'stale', pending: 'idle', subscription: 'reconnecting', error: { code: 'unavailable', message: 'Machine offline' } }));
      expect(mount.container.querySelector('[data-testid="retained"]')).toBe(retained);
      expect(mount.container.textContent).toContain('Machine offline');
      expect(mount.container.querySelector('[role="progressbar"]')).toBeNull();
      await mount.render(render({ value, freshness: 'fresh', pending: 'idle', subscription: 'ended' }));
      expect(mount.container.querySelector('[data-testid="retained"]')).toBe(retained);
      expect(mount.container.textContent).toBe('Last known reviews');
    } finally { mount.unmount(); }
  });
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
    for (const resource of [INITIAL_RESOURCE, FAILED_RESOURCE, READY_RESOURCE]) {
      const mount = mountSurface(
        <State resource={resource}>{(value) => <Spinner accessibilityLabel={new TextDecoder().decode(value.bytes)} />}</State>,
      );

      expect(mount.container.innerHTML).not.toContain('happier-plugin-');
      mount.unmount();
    }
  });

  it('renders a real progressbar while the resource is loading', () => {
    const mount = mountSurface(<State resource={INITIAL_RESOURCE} />);

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
        <State resource={INITIAL_RESOURCE} />
        <State resource={READY_RESOURCE} isEmpty />
        <State resource={FAILED_RESOURCE} />
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

  it('carries a second quiet line and the next action in one notice, so no banner has to repeat the reason', () => {
    const mount = mountSurface(
      <Status
        tone="warning" label="Showing the list from 10:42" value="Could not be reached just now."
        action={<Button title="Retry" onPress={() => undefined} testID="retry" />} testID="offline-status"
      />,
    );
    const status = mount.container.querySelector('[data-testid="offline-status"]')!;
    expect(status.textContent).toContain('Showing the list from 10:42');
    expect(status.textContent).toContain('Could not be reached just now.');
    expect(mount.container.querySelector('[data-testid="retry"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps inline collection states readable without announcing each cell', async () => {
    const content = (label: string) => <Status tone="warning" label={label} presentation="inline" testID="cell-status" />;
    const mount = mountSurface(content('Checks pending'));
    try {
      const cell = mount.container.querySelector<HTMLElement>('[data-testid="cell-status"]');
      expect(cell?.textContent).toBe('Checks pending');
      expect(cell?.getAttribute('role')).toBeNull();
      expect(cell?.getAttribute('aria-live')).toBeNull();
      expect(cell?.querySelector('[role="status"], [aria-live]')).toBeNull();
      await mount.render(<PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        {content('Checks passed')}
      </PluginUiProvider>);
      expect(cell?.textContent).toBe('Checks passed');
      expect(cell?.querySelector('[role="img"]')).toBeNull();
    } finally { mount.unmount(); }
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
      <State resource={{ ...FAILED_RESOURCE, error: { code: 'provider_response_invalid', message: 'provider_response_invalid' } }} />,
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

  it('draws the Details disclosure with the host caret at its compact density, turning with the open state', async () => {
    const mount = mountInHost(
      <ErrorState title="The list could not be read" details="host_api_method_unavailable" />,
      {
        renderDisclosureCaret: ({ expanded, density }) => (
          <i data-testid="host-caret" data-expanded={String(expanded)} data-density={density} />
        ),
      },
    );
    try {
      const toggle = mount.container.querySelector<HTMLElement>('[aria-expanded="false"]')!;
      const caret = () => toggle.querySelector('[data-testid="host-caret"]');
      expect(caret()?.getAttribute('data-density')).toBe('compact');
      expect(caret()?.getAttribute('data-expanded')).toBe('false');
      await act(async () => { toggle.click(); });
      expect(caret()?.getAttribute('data-expanded')).toBe('true');
    } finally {
      mount.unmount();
    }
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
        resource={READY_RESOURCE}
        isEmpty
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
  it('offers standalone scene art through the same host scene renderer', () => {
    expect(typeof SceneArt).toBe('function');
    const requests: HappierSceneRenderRequest[] = [];
    const mount = mountInHost(<SceneArt scene="noMatch" size="thumb" still testID="standalone-art" />, {
      renderScene: (request) => {
        requests.push(request);
        return <span data-testid={request.testID}>{request.scene.name}</span>;
      },
    });
    try {
      expect(mount.container.querySelector('[data-testid="standalone-art"]')?.textContent).toBe('noMatch');
      expect(requests.at(-1)).toMatchObject({ size: 'thumb', still: true });
      expect(requests.at(-1)?.scene.layers.length).toBeGreaterThan(0);
    } finally { mount.unmount(); }
  });
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

  it('draws one quiet line, not a centred column, in a line container (an inspector section, a narrow column)', () => {
    for (const element of [
      <LoadingState key="loading" testID="state" title="Loading conversations" />,
      <EmptyState key="empty" testID="state" title="No conversations" />,
      <ErrorState key="error" testID="state" title="Could not load" />,
    ]) {
      const mount = mountInHost(element, { stateSize: 'line' });
      const title = mount.container.querySelector('[data-testid="state"]')?.textContent ?? '';
      expect(title).toMatch(/Loading conversations|No conversations|Could not load/u);
      expect(measureOf(mount, title.trim()), 'a line has no centred measure').toBeNull();
      mount.unmount();
    }
    const explicit = mountInHost(<EmptyState title="No conversations" size="pane" />, { stateSize: 'line' });
    expect(measureOf(explicit, 'No conversations'), 'an explicit size still wins').toBe('272px');
    explicit.unmount();
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

  it('keeps the time and the reason as two clauses, the dot riding the first, so a narrow line stacks without a dangling dot', () => {
    const asOf = new Date(2026, 8, 29, 10, 42).getTime();
    const reason = "MacBook Pro isn't answering";
    const mount = mountSurface(<FreshnessLine testID="fresh" asOf={asOf} now={new Date(2026, 8, 29, 11, 0).getTime()} reason={reason} />);
    const line = mount.container.querySelector<HTMLElement>('[data-testid="fresh"]');
    const texts = [...(line?.querySelectorAll('*') ?? [])].filter((node) => node.children.length === 0).map((node) => node.textContent);
    // The reason is its own run; it never begins with the separator, which belongs to the time's run.
    expect(texts).toContain(reason);
    expect(texts.some((text) => text?.trim() === '·')).toBe(true);
    expect(texts.some((text) => text?.startsWith('·') && text.includes(reason))).toBe(false);
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

describe('a host sentence about a part that cannot run now', () => {
  it('is said once, in the failure state of the part that failed, with that state\'s own action; other content stays', () => {
    const claims: string[] = [];
    const notice = { sentence: 'This operation is unavailable on Studio Mac.', claim: (id: string) => {
      claims.push(id);
      return () => { claims.splice(claims.indexOf(id), 1); };
    } };
    let retried = 0;
    const mount = mountSurface(
      <PluginUiSurfaceNoticeContext.Provider value={notice}>
        <Status tone="success" label="Account rows" />
        <ErrorState title="The latest entries could not be read" details="host_api_method_unavailable:readResource" onRetry={() => { retried += 1; }} />
      </PluginUiSurfaceNoticeContext.Provider>,
    );
    const text = mount.container.textContent ?? '';
    expect(text).toContain('Account rows');
    expect(text.split('This operation is unavailable on Studio Mac.')).toHaveLength(2);
    expect(text).not.toContain('could not be read');
    expect(text).not.toContain('host_api_method_unavailable');
    expect(claims).toHaveLength(1);
    const buttons = mount.container.querySelectorAll('[role="button"]');
    expect(buttons).toHaveLength(1);
    act(() => { (buttons[0] as HTMLElement).click(); });
    expect(retried).toBe(1);
    mount.unmount();
    expect(claims).toHaveLength(0);
  });

  it('draws the host\'s way forward in place of the failure state\'s own retry when retrying cannot help', () => {
    let opened = 0;
    let retried = 0;
    const notice = {
      sentence: 'Add or connect a machine to use this here.',
      action: { label: 'Add a machine', onPress: () => { opened += 1; } },
      claim: () => () => undefined,
    };
    const mount = mountSurface(
      <PluginUiSurfaceNoticeContext.Provider value={notice}>
        <ErrorState title="The latest entries could not be read" onRetry={() => { retried += 1; }} />
      </PluginUiSurfaceNoticeContext.Provider>,
    );
    const buttons = mount.container.querySelectorAll('[role="button"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Add a machine');
    act(() => { (buttons[0] as HTMLElement).click(); });
    expect({ opened, retried }).toEqual({ opened: 1, retried: 0 });
    mount.unmount();
  });

  it('leaves a non-failure state and every state outside such a host untouched', () => {
    const mount = mountSurface(
      <>
        <PluginUiSurfaceNoticeContext.Provider value={{ sentence: 'This operation is unavailable on Studio Mac.', claim: () => () => undefined }}>
          <EmptyState title="Nothing new right now" />
        </PluginUiSurfaceNoticeContext.Provider>
        <ErrorState title="The latest entries could not be read" />
      </>,
    );
    const text = mount.container.textContent ?? '';
    expect(text).toContain('Nothing new right now');
    expect(text).toContain('The latest entries could not be read');
    expect(text).not.toContain('Studio Mac');
    mount.unmount();
  });
});
