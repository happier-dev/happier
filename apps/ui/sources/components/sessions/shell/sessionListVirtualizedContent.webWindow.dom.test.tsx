// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';

import type { SessionListVirtualizedNode } from './sessionListVirtualizedContent';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();

// The browser list runtime is the boundary under test, so react-native resolves to react-native-web.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Keep graph loading outside the observable browser layout/focus test budgets.
await import('./sessionListVirtualizedContent');
const { useSessionListViewState } = await import('./useSessionListViewState');
const { SessionListRowFactsProvider } = await import('./sessionListRowFacts');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');

const VIEWPORT_HEIGHT = 400;
const ROW_COUNT = 240;
const PLACEHOLDER_ROW_HEIGHT = 34;
const HYDRATED_ROW_HEIGHT = 48;
const SCHEDULED_SECTION_HEIGHT = 1200;
// The list's bottom padding is the only content that may sit under the viewport without a row.
const MAX_UNCOVERED_GAP = 8;

/**
 * Minimal browser box model for jsdom. Heights come from `data-row-height` and explicit `height`
 * styles (spacers, content boxes); in-flow children stack; absolutely positioned children sit at their
 * `top`. A ResizeObserver reports a size change only, exactly as a browser does: it never reports a
 * cell that merely moved because content above it grew.
 */
function pixels(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && value.endsWith('px') ? parsed : null;
}

const scrollerByElement = new WeakMap<HTMLElement, boolean>();

function isScroller(element: HTMLElement): boolean {
  // React Native Web resolves its ScrollView styles to classes; Legend writes them inline.
  const known = scrollerByElement.get(element);
  if (known !== undefined) return known;
  const { overflowY } = window.getComputedStyle(element);
  const scroller = overflowY === 'auto' || overflowY === 'scroll';
  scrollerByElement.set(element, scroller);
  return scroller;
}

function isAbsolute(element: HTMLElement): boolean {
  return element.style.position === 'absolute';
}

function heightOf(element: HTMLElement): number {
  if (element.dataset.rowHeight) return Number(element.dataset.rowHeight);
  if (element.id === 'host') return VIEWPORT_HEIGHT;
  if (isScroller(element)) return VIEWPORT_HEIGHT;
  const explicit = pixels(element.style.height);
  if (explicit != null) return explicit;
  let sum = 0;
  for (const child of Array.from(element.children) as HTMLElement[]) {
    if (!isAbsolute(child)) sum += heightOf(child);
  }
  return sum;
}

function topOf(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;
  const parentTop = topOf(parent);
  if (isAbsolute(element)) {
    const top = pixels(element.style.top);
    const translate = /translateY\((-?[\d.]+)px\)/.exec(
      element.style.transform,
    )?.[1];
    return parentTop + (top ?? (translate ? Number(translate) : 0));
  }
  let before = 0;
  for (const sibling of Array.from(parent.children) as HTMLElement[]) {
    if (sibling === element) break;
    if (!isAbsolute(sibling)) before += heightOf(sibling);
  }
  return parentTop + before;
}

type ObserverRecord = {
  callback: ResizeObserverCallback;
  sizes: Map<Element, string>;
};
const observers = new Set<ObserverRecord>();

function sizeKey(element: HTMLElement): string {
  return `${heightOf(element)}`;
}

function flushResizeObservers(): void {
  for (const observer of observers) {
    const changed: ResizeObserverEntry[] = [];
    for (const [element, previous] of observer.sizes) {
      if (!element.isConnected) continue;
      const key = sizeKey(element as HTMLElement);
      if (key === previous) continue;
      observer.sizes.set(element, key);
      const height = heightOf(element as HTMLElement);
      changed.push({
        borderBoxSize: [],
        contentBoxSize: [],
        contentRect: {
          width: 360,
          height,
          top: 0,
          left: 0,
          bottom: height,
          right: 360,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        },
        devicePixelContentBoxSize: [],
        target: element,
      } as ResizeObserverEntry);
    }
    if (changed.length > 0) observer.callback(changed, {} as ResizeObserver);
  }
}

function rectOf(element: HTMLElement): DOMRectReadOnly {
  const height = heightOf(element);
  const top = topOf(element);
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    bottom: top + height,
    right: 360,
    width: 360,
    height,
    toJSON: () => ({}),
  };
}

type Phase = 'placeholders' | 'hydrated';

function buildNodes(count = ROW_COUNT): SessionListVirtualizedNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: buildSessionListIndexNodeId({
      type: 'session',
      sessionId: `s${index}`,
      serverId: 'home',
    }),
    kind: 'session' as const,
    rowViewModel: null,
  }));
}

function rowHeightFor(phase: Phase, index: number): number {
  // Hydration turns some encrypted placeholders into titled rows with a subtitle line.
  return phase === 'hydrated' && index % 3 !== 0
    ? HYDRATED_ROW_HEIGHT
    : PLACEHOLDER_ROW_HEIGHT;
}

describe('session list web window while row and header heights change', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    // RNW retains its one useElementLayout ResizeObserver across mounted lists.
    // Keep that real observer registered; unmount retires its individual targets.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    class TestResizeObserver implements ResizeObserver {
      private readonly record: ObserverRecord = {
        callback: () => {},
        sizes: new Map(),
      };
      constructor(callback: ResizeObserverCallback) {
        this.record.callback = callback;
        observers.add(this.record);
      }
      disconnect(): void {
        this.record.sizes.clear();
        observers.delete(this.record);
      }
      observe(target: Element): void {
        this.record.sizes.set(target, '');
      }
      unobserve(target: Element): void {
        this.record.sizes.delete(target);
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectOf(this);
      },
    );
    const geometry = {
      offsetHeight: (element: HTMLElement) => heightOf(element),
      offsetWidth: () => 360,
      offsetTop: (element: HTMLElement) => topOf(element),
      offsetLeft: () => 0,
      offsetParent: () => null,
      clientHeight: (element: HTMLElement) => heightOf(element),
      clientWidth: () => 360,
      clientTop: () => 0,
      clientLeft: () => 0,
      scrollHeight: (element: HTMLElement) =>
        Math.max(
          heightOf(element),
          (Array.from(element.children) as HTMLElement[]).reduce(
            (sum, child) => sum + (isAbsolute(child) ? 0 : heightOf(child)),
            0,
          ),
        ),
    };
    for (const [name, read] of Object.entries(geometry)) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return read(this);
        },
      });
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value() {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const name of [
      'offsetHeight',
      'offsetWidth',
      'offsetTop',
      'offsetLeft',
      'offsetParent',
      'clientHeight',
      'clientWidth',
      'clientTop',
      'clientLeft',
      'scrollHeight',
    ]) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      await act(async () => {
        flushResizeObservers();
        await vi.runOnlyPendingTimersAsync();
      });
    }
  }

  async function renderList(
    params: Readonly<{ phase: Phase; scheduledHeight: number; count?: number }>,
  ) {
    const { SessionListVirtualizedContent, SESSION_LIST_SUPPORTING_SECTIONS_NODE } =
      await import('./sessionListVirtualizedContent');
    const nodes = buildNodes(params.count);
    const indexById = new Map(nodes.map((node, index) => [node.id, index]));
    await act(async () => {
      root.render(
        <div id="host">
          <SessionListVirtualizedContent
            nodes={[SESSION_LIST_SUPPORTING_SECTIONS_NODE, ...nodes]}
            rowHeight={PLACEHOLDER_ROW_HEIGHT}
            safeAreaBottom={0}
            renderItem={({ item }) => (
              <div
                data-session-row=""
                data-row-height={rowHeightFor(
                  params.phase,
                  indexById.get(item.id) ?? 0,
                )}
              />
            )}
            rowExtraData={params.phase}
            onStopScrollEventPropagationOnWeb={() => {}}
            showDrafts={false}
            showReminders={false}
            scheduledSection={<div data-row-height={params.scheduledHeight} />}
          />
        </div>,
      );
    });
    await settle();
  }

  async function scrollTo(offset: number): Promise<void> {
    const scroller = Array.from(
      container.querySelectorAll<HTMLElement>('div'),
    ).find(isScroller);
    expect(scroller).toBeDefined();
    Object.defineProperty(scroller!, 'scrollTop', {
      configurable: true,
      writable: true,
      value: offset,
    });
    await act(async () => {
      scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await settle();
  }

  it('updates mounted row context, identity and status words from current Account choices without a reload', async () => {
    // IndexedDB preparation owns real browser tasks; virtual-list layout below uses the shared fake clock.
    vi.useRealTimers();
    const { storage } = await import('@/sync/domains/state/storage');
    const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const previous = storage.getState();
    await home.reset();
    await loadSyncSingletonForTests();
    const serverId = await home.addHome({ name: 'Web row choices', serverUrl: 'https://web-row-choices.test', accountId: 'u1' });
    const now = Date.now();
    const session = createSessionFixture({ id: 'web-choices', serverId, owner: 'u1', seq: 1,
      projectKey: 'row-choices', active: true, activeAt: now, presence: 'online', thinking: true, thinkingAt: now,
      latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now, updatedAt: now,
      metadata: { host: 'dev', name: 'Live choices', path: '/repo/choices', machineId: 'machine-choices', branch: 'live-branch', flavor: 'claude' } });
    const settings = { sessionListLayoutV1: 'projects', sessionListAttentionPlacementV1: 'inPlace',
      sessionListDensity: 'narrow', sessionListRowContextV1: true, sessionListIdentityDisplay: 'avatar',
      sessionListStatusWords: false, hideInactiveSessions: false } as const;
    const http = createHomeHubArtifactHttpBoundary('u1');
    const account = await restoreServerAccountForTest({ serverUrl: 'https://web-row-choices.test', accountId: 'u1', request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
      if (path === '/v2/sessions') return Response.json({ sessions: [{ ...createPlainSessionByIdResponseFixture(session).session,
        viewer: createSessionOwnerViewerFixture(session) }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
      if (['/v2/sessions/active', '/v2/sessions/attention'].includes(path)) return Response.json({ sessions: [], nextCursor: null, hasNext: false });
      return createEmptyAccountBootstrapHttpResponse(path, init) ?? http.request(input, init);
    } });
    const occurrence = buildSessionListIndexNodeId({ type: 'session', serverId, sessionId: session.id });
    // RNW maps testID to data-testid; the canonical native-SVG boundary preserves its authored testID.
    const query = (kind: string, suffix = '') => Array.from(container.querySelectorAll<HTMLElement>('[data-testid], [testid]'))
      .find(element => (element.dataset.testid ?? element.getAttribute('testid')) === `${kind}-${occurrence}${suffix}`) ?? null;
    function CurrentList() {
      const state = useSessionListViewState('all', { pathname: '/' });
      return <div id="host"><SessionListRowFactsProvider value={state.rowFacts}><SessionListVirtualizedContent nodes={state.nodes} rowHeight={48} safeAreaBottom={0}
        renderItem={state.renderVirtualizedItem} rowExtraData={state.virtualizedRowExtraData}
        onStopScrollEventPropagationOnWeb={() => {}} showDrafts={false} showReminders={false} /></SessionListRowFactsProvider></div>;
    }
    try {
      await storage.getState().activateSettingsScope({ serverId, accountId: 'u1' });
      storage.getState().applySettingsLocal(settings);
      storage.getState().applySessions([session]);
      storage.getState().applyServerScopedSessionListRows(serverId,
        [storage.getState().sessionListRowsByServerId[serverId]![session.id]!], { source: 'ordinary', mode: 'replace' });
      vi.useFakeTimers();
      await act(async () => root.render(<InjectedAuthProvider credentials={account.credentials}>
        <InboxSummaryProvider><AppPaneProvider><CommandPaletteProvider><CurrentList /></CommandPaletteProvider></AppPaneProvider></InboxSummaryProvider>
      </InjectedAuthProvider>));
      await settle();
      const row = query('session-list-item');
      expect(row).not.toBeNull();
      row!.focus();
      expect(document.activeElement).toBe(row);
      expect(query('session-list-row-context-checkout')?.textContent).toContain('live-branch');
      expect(query('session-list-agent-logo')).toBeNull();
      expect(query('session-list-status-word')).toBeNull();
      await act(async () => { storage.getState().applySettingsLocal({ sessionListRowContextV1: false }); });
      await settle();
      expect(query('session-list-row-context-checkout')).toBeNull();
      await act(async () => { storage.getState().applySettingsLocal({ sessionListRowContextV1: true,
        sessionListIdentityDisplay: 'projectWithAgent', sessionListStatusWords: true }); });
      await settle();
      expect(query('session-list-row-context-checkout')?.textContent).toContain('live-branch');
      expect(query('session-list-agent-logo', '-project-fallback')).not.toBeNull();
      expect(query('session-list-agent-logo', '-agent-badge')).not.toBeNull();
      expect(query('session-list-status-word')).not.toBeNull();
      expect(query('session-list-item')).toBe(row);
      expect(document.activeElement).toBe(row);
    } finally {
      await act(async () => root.render(null));
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      await disconnectActiveServerConnection();
      await account.dispose();
      storage.setState(previous, true);
      await home.reset();
    }
  });

  /** The longest stretch of the viewport, [offset, offset + viewport), that no mounted row covers. */
  function longestUncoveredGap(offset: number): number {
    const spans = Array.from(
      container.querySelectorAll<HTMLElement>('[data-session-row]'),
    )
      .map((row) => [topOf(row), topOf(row) + heightOf(row)] as const)
      .sort((left, right) => left[0] - right[0]);
    let cursor = offset;
    let longest = 0;
    for (const [top, bottom] of spans) {
      if (bottom <= cursor) continue;
      longest = Math.max(longest, top - cursor);
      cursor = Math.max(cursor, bottom);
      if (cursor >= offset + VIEWPORT_HEIGHT) return longest;
    }
    return Math.max(longest, offset + VIEWPORT_HEIGHT - cursor);
  }

  it('measures an empty supporting slot without reserving a Session height', async () => {
    await renderList({ phase: 'placeholders', scheduledHeight: 0, count: 2 });
    // An admitted presentation slot whose children draw nothing has no estimated-row gap.
    expect(topOf(container.querySelector<HTMLElement>('[data-session-row]')!)).toBe(0);
    await renderList({ phase: 'placeholders', scheduledHeight: 96, count: 2 });
    expect(container.querySelector('[data-row-height="96"]')).not.toBeNull();
    expect(topOf(container.querySelector<HTMLElement>('[data-session-row]')!)).toBe(96);
    await renderList({ phase: 'placeholders', scheduledHeight: 0, count: 2 });
    expect(topOf(container.querySelector<HTMLElement>('[data-session-row]')!)).toBe(0);
  });

  it('keeps a row under every part of the viewport after the header grows and rows hydrate', async () => {
    await renderList({ phase: 'placeholders', scheduledHeight: 0 });
    // The reader scrolls through the list, so every window is measured at its placeholder layout.
    for (
      let offset = 0;
      offset <= ROW_COUNT * PLACEHOLDER_ROW_HEIGHT - VIEWPORT_HEIGHT;
      offset += 300
    ) {
      await scrollTo(offset);
    }
    await scrollTo(0);

    // Upcoming work hydrates above the rows and the placeholders become titled rows.
    await renderList({
      phase: 'hydrated',
      scheduledHeight: SCHEDULED_SECTION_HEIGHT,
    });

    const contentHeight =
      SCHEDULED_SECTION_HEIGHT +
      Array.from({ length: ROW_COUNT }, (_, index) =>
        rowHeightFor('hydrated', index),
      ).reduce((a, b) => a + b, 0);
    const gaps: Array<readonly [number, number]> = [];
    for (
      let offset = SCHEDULED_SECTION_HEIGHT;
      offset <= contentHeight - VIEWPORT_HEIGHT;
      offset += 250
    ) {
      await scrollTo(offset);
      gaps.push([offset, longestUncoveredGap(offset)]);
    }

    expect(gaps.filter(([, gap]) => gap > MAX_UNCOVERED_GAP)).toEqual([]);
  });

  it('preserves focused supporting content when attention changes its measured cell index', async () => {
    const { SessionListVirtualizedContent, SESSION_LIST_SUPPORTING_SECTIONS_NODE } =
      await import('./sessionListVirtualizedContent');
    const needs = { id: buildSessionListIndexNodeId({ type: 'session', sessionId: 'needs', serverId: 'home',
      occurrenceRole: 'needsYou' }), kind: 'session' as const };
    const working = { id: buildSessionListIndexNodeId({ type: 'session', sessionId: 'working', serverId: 'home',
      occurrenceRole: 'working' }), kind: 'session' as const };
    const ordinary = { id: buildSessionListIndexNodeId({ type: 'session', sessionId: 'ordinary', serverId: 'home' }),
      kind: 'session' as const };
    const render = async (withWorking: boolean) => {
      await act(async () => root.render(<div id="host">
        <SessionListVirtualizedContent nodes={[needs, ...(withWorking ? [working] : []),
          SESSION_LIST_SUPPORTING_SECTIONS_NODE, ordinary]} rowHeight={48} safeAreaBottom={0}
          renderItem={({ item }) => <div data-row-height="48" data-order={item.id} />}
          rowExtraData={null} onStopScrollEventPropagationOnWeb={() => {}} showDrafts={false} showReminders={false}
          scheduledSection={<div data-row-height="48" data-order="scheduled"><button data-support-focus="">Keep focus</button></div>} />
      </div>));
      await settle();
    };
    const renderedOrder = () => Array.from(container.querySelectorAll<HTMLElement>('[data-order]'))
      .sort((left, right) => topOf(left) - topOf(right)).map(node => node.dataset.order);
    await render(false);
    expect(renderedOrder()).toEqual([needs.id, 'scheduled', ordinary.id]);
    const focused = container.querySelector<HTMLButtonElement>('[data-support-focus]')!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    await render(true);
    expect(renderedOrder()).toEqual([needs.id, working.id, 'scheduled', ordinary.id]);
    expect(container.querySelector('[data-support-focus]')).toBe(focused);
    expect(document.activeElement).toBe(focused);
  });
});
