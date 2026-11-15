// @vitest-environment jsdom

import { act } from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ResourceContent, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
  type PluginUiTestkitHostHandlers,
  type PluginUiTestkitOpenSurfaceInput,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSurface } from './channelsGlance.js';

/**
 * The Channels column and Home widget (lab `channels` C1 column, W1 widget).
 * Both only read the Account's conversations and bots and send the reader to
 * the Channels page; they are asserted through what a reader sees and where a
 * press takes them.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TELEGRAM = 'com.example.telegram';
const DISCORD = 'com.example.discord';

function jsonResource(value: unknown, digestDigit: string): ResourceContent {
  return {
    contentType: 'application/json',
    digest: `sha256:${digestDigit.repeat(64)}`,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function connection(input: Readonly<{ id: string; provider: string; label: string; blocked?: boolean }>) {
  return {
    connectionId: input.id,
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: input.provider,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: input.label,
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      pollFailure: input.blocked === true
        ? { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'providerConflict' } }
        : null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false },
    },
  };
}

function binding(input: Readonly<{ id: string; connectionId: string; label: string; enabled?: boolean }>) {
  return {
    bindingId: input.id,
    revision: 1,
    connectionId: input.connectionId,
    endpoint: { audience: 'shared', label: input.label },
    target: { kind: 'session', summary: `session-for-${input.id}` },
    inputMode: 'addressedMessages',
    deliveryMode: 'repliesOnly',
    approval: { kind: 'off' },
    enabled: input.enabled ?? true,
    deletionState: 'none',
  };
}

const CONNECTIONS = jsonResource({
  connections: [
    connection({ id: 'tg-bot', provider: TELEGRAM, label: '@happier_ops_bot', blocked: true }),
    connection({ id: 'dc-bot', provider: DISCORD, label: 'Happier bot' }),
  ],
}, 'c');

const BINDINGS = jsonResource({
  bindings: [
    binding({ id: 'ops', connectionId: 'tg-bot', label: 'Ops on-call' }),
    binding({ id: 'dm', connectionId: 'tg-bot', label: 'Leeroy Brun' }),
    binding({ id: 'dev', connectionId: 'dc-bot', label: 'happier-dev' }),
    binding({ id: 'support', connectionId: 'dc-bot', label: 'support', enabled: false }),
    binding({ id: 'release', connectionId: 'dc-bot', label: 'release-0.3' }),
  ],
}, 'b');

function readResource(bindings: ResourceContent = BINDINGS): NonNullable<PluginUiTestkitHostHandlers['readResource']> {
  return async ({ resource }) => {
    if (typeof resource !== 'string' && 'hostRead' in resource) {
      throw new Error(`Unexpected host Resource: ${resource.hostRead}`);
    }
    const localId = typeof resource === 'string' ? resource : resource.localId;
    if (localId === 'bindings-v1') return bindings;
    if (localId === 'connections-v1') return CONNECTIONS;
    throw new Error(`Unexpected Resource: ${localId}`);
  };
}

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountGlance(input: Readonly<{
  view: 'column' | 'widget';
  subPath?: string;
  bindings?: ResourceContent;
  readResource?: NonNullable<PluginUiTestkitHostHandlers['readResource']>;
  sessionHandlers?: Pick<PluginUiTestkitHostHandlers, 'readSession' | 'watchSession'>;
  openSurface: (input: PluginUiTestkitOpenSurfaceInput) => void;
}>): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: `channels-glance-${input.view}`, mountNonce: `mount-${mounted.length}` },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        mount: input.view === 'column'
          ? {
            kind: 'destination',
            destination: { pluginId: 'happier.channels', localId: 'conversations' },
            container: 'appPage',
          }
          : { kind: 'embedded', role: 'widget', presentation: 'content' },
        target: { kind: 'app' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      ...(input.subPath === undefined ? {} : { subPath: input.subPath }),
      handlers: {
        readResource: input.readResource ?? readResource(input.bindings),
        openSurface: input.openSurface,
        ...input.sessionHandlers,
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

function viewName(open: PluginUiTestkitOpenSurfaceInput): string {
  return typeof open.view === 'string' ? open.view : open.view.localId;
}

describe('the Channels column', () => {
  it('groups conversations by the provider of their bot and speaks only for a state', async () => {
    const opened: PluginUiTestkitOpenSurfaceInput[] = [];
    const column = await mountGlance({ view: 'column', subPath: 'dev', openSurface: (open) => { opened.push(open); } });

    await vi.waitFor(async () => { await column.getByRole('button', { name: 'happier-dev' }); });
    const text = document.body.textContent ?? '';
    // One group per provider, each group's rows by name.
    expect(text.indexOf('Ops on-call')).toBeGreaterThan(-1);
    expect(text.indexOf('happier-dev')).toBeLessThan(text.indexOf('release-0.3'));
    // The Telegram bot's poll is blocked: the cause is said once, on its group.
    expect(text.match(/Bot needs you/gu)).toHaveLength(1);
    await expect(column.getByRole('button', { name: 'Ops on-call' })).resolves.toBeDefined();
    // A paused conversation says so in its name; a healthy one says nothing extra.
    await expect(column.getByRole('button', { name: 'support, Paused' })).resolves.toBeDefined();

    // The open conversation is the page location's; a press opens another one there.
    expect(document.querySelector('[data-testid="channels-column-row-dev"]')?.getAttribute('aria-current')).toBe('page');
    await act(async () => { await column.updatePageLocation('release'); });
    expect(document.querySelector('[data-testid="channels-column-row-dev"]')?.getAttribute('aria-current')).toBeNull();
    expect(document.querySelector('[data-testid="channels-column-row-release"]')?.getAttribute('aria-current')).toBe('page');
    await column.press(await column.getByRole('button', { name: 'release-0.3' }));
    expect(opened.map((open) => [viewName(open), open.subPath])).toEqual([['conversations', 'release']]);

    // The foot row leads to the bots' settings, and the header + to the link flow.
    await column.press(await column.getByRole('button', { name: 'Bots & connections' }));
    await column.press(await column.getByRole('button', { name: 'Link a conversation' }));
    expect(opened.map((open) => [viewName(open), open.subPath ?? ''])).toEqual([
      ['conversations', 'release'],
      ['connections', ''],
      ['conversations', 'link'],
    ]);
  });

  it('waits for its bots before grouping, so a conversation never moves between groups on arrival', async () => {
    let releaseConnections!: () => void;
    const connectionsArrive = new Promise<void>((resolve) => { releaseConnections = resolve; });
    const slowConnections = readResource();
    const column = await mountGlance({
      view: 'column',
      openSurface: () => undefined,
      readResource: async (request) => {
        const localId = typeof request.resource === 'string' ? request.resource : 'localId' in request.resource ? request.resource.localId : '';
        if (localId === 'connections-v1') await connectionsArrive;
        return slowConnections(request);
      },
    });
    // The bindings are in, but no row is drawn under a placeholder group while their bots are unknown.
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="channels-column"]')).not.toBeNull(); });
    expect(document.body.textContent).not.toContain('Other conversations');
    expect(document.body.textContent).not.toContain('happier-dev');
    await act(async () => { releaseConnections(); });
    await vi.waitFor(async () => { await column.getByRole('button', { name: 'happier-dev' }); });
    expect(document.body.textContent).not.toContain('Other conversations');
  });

  it('says once when nothing is linked yet', async () => {
    const column = await mountGlance({
      view: 'column',
      bindings: jsonResource({ bindings: [] }, 'e'),
      openSurface: () => undefined,
    });
    await vi.waitFor(async () => { await column.getByText('No conversations yet.'); });
  });
});

describe('the Channels glance activity and loading', () => {
  it('reads and watches only the four presented widget conversations out of 1000', async () => {
    const presented = 4;
    const count = 1000;
    const bindings = Array.from({ length: count }, (_, index) => {
      const id = String(index).padStart(4, '0');
      const row = binding({ id, connectionId: 'dc-bot', label: `Conversation ${id}` });
      return { ...row, target: { ...row.target, sessionId: `session-${id}` } };
    });
    const readIds: string[] = [];
    const watchedIds: string[] = [];
    let reply = 'The first reply';
    const surface = await mountGlance({
      view: 'widget',
      openSurface: () => undefined,
      readResource: async ({ resource }) => {
        const localId = typeof resource === 'string' ? resource : 'localId' in resource ? resource.localId : '';
        return localId === 'bindings-v1' ? jsonResource({ bindings }, 'b')
          : jsonResource({ connections: [connection({ id: 'dc-bot', provider: DISCORD, label: 'Happier bot' })] }, 'c');
      },
      sessionHandlers: {
        readSession: ({ sessionId }): SessionStateV1 => {
          readIds.push(sessionId);
          return { sessionId, lifecycle: 'active', runtime: 'idle', operational: 'none', pendingPermissions: [],
            workStatus: { state: 'waiting', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Idle' },
            latestActivity: { kind: 'ready', text: reply, createdAt: 1_700_000_000_000 } };
        },
        watchSession: ({ sessionId }) => { watchedIds.push(sessionId); },
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="channels-widget-row-"]')).toHaveLength(presented);
      expect(readIds.length).toBeGreaterThan(0);
    });
    const expected = bindings.slice(0, presented).map((row) => row.target.sessionId);
    expect(readIds).toEqual(expected);
    expect(watchedIds).toEqual(expected);

    // Invisible Session pushes cannot cause reads; a visible reply must still advance.
    await act(async () => {
      for (const row of bindings.slice(presented)) surface.invalidateSession(row.target.sessionId, `sha256:${'d'.repeat(64)}`);
    });
    expect(readIds).toHaveLength(presented);
    reply = 'The updated reply';
    await act(async () => { surface.invalidateSession('session-0000', `sha256:${'e'.repeat(64)}`); });
    await vi.waitFor(() => { expect(readIds).toHaveLength(presented + 1); });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="channels-widget-row-0000"]')?.textContent).toContain(reply);
    });
  });

  it('acquires activity only for mounted column rows and acquires newly presented rows on scroll', async () => {
    const bindings = Array.from({ length: 1000 }, (_, index) => {
      const id = String(index).padStart(4, '0');
      const row = binding({ id, connectionId: 'dc-bot', label: `Conversation ${id}` });
      return { ...row, target: { ...row.target, sessionId: `session-${id}` } };
    });
    const readIds: string[] = [];
    const watchedIds: string[] = [];
    const surface = await mountGlance({
      view: 'column', openSurface: () => undefined,
      readResource: async ({ resource }) => {
        const localId = typeof resource === 'string' ? resource : 'localId' in resource ? resource.localId : '';
        return localId === 'bindings-v1' ? jsonResource({ bindings }, 'b')
          : jsonResource({ connections: [connection({ id: 'dc-bot', provider: DISCORD, label: 'Happier bot' })] }, 'c');
      },
      sessionHandlers: {
        readSession: ({ sessionId }): SessionStateV1 => {
          readIds.push(sessionId);
          return { sessionId, lifecycle: 'active', runtime: 'idle', operational: 'none', pendingPermissions: [],
            workStatus: { state: 'waiting', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Idle' },
            latestActivity: { kind: 'ready', text: 'Current reply', createdAt: 1_700_000_000_000 } };
        },
        watchSession: ({ sessionId }) => { watchedIds.push(sessionId); },
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="channels-column-row-0000"]')).not.toBeNull();
      expect(readIds).toContain('session-0000');
    });
    expect(document.querySelector('[data-testid="channels-column-row-0999"]')).toBeNull();
    const initialRows = [...document.querySelectorAll('[data-testid^="channels-column-row-"]')]
      .map(row => `session-${row.getAttribute('data-testid')!.slice(-4)}`);
    expect(new Set(readIds)).toEqual(new Set(initialRows));
    expect(new Set(watchedIds)).toEqual(new Set(initialRows));
    expect(readIds).not.toContain('session-0100');

    // jsdom has no browser layout. Supply that OS boundary while retaining
    // RNW's real FlatList, render mask, spacer cells and scroll lifecycle.
    type LayoutNode = HTMLElement & { __reactLayoutHandler?: (event: Readonly<{ nativeEvent: Readonly<{
      layout: Readonly<{ x: number; y: number; width: number; height: number }>;
    }> }>) => void };
    const scroll = document.querySelector<LayoutNode>('[data-testid="channels-column-rows"]')!;
    expect(scroll).not.toBeNull();
    const content = scroll.firstElementChild as LayoutNode;
    const viewportHeight = 420;
    const rowHeight = 42;
    let contentHeight = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => viewportHeight },
      offsetHeight: { configurable: true, get: () => viewportHeight },
      clientWidth: { configurable: true, get: () => 320 },
      offsetWidth: { configurable: true, get: () => 320 },
      scrollHeight: { configurable: true, get: () => contentHeight },
    });
    const report = (node: LayoutNode, y: number, height: number) => node.__reactLayoutHandler?.({
      nativeEvent: { layout: { x: 0, y, width: 320, height } },
    });
    vi.useFakeTimers();
    try {
      const settle = async () => {
        for (let frame = 0; frame < 5; frame += 1) {
          await act(async () => {
            report(scroll, 0, viewportHeight);
            let y = 0;
            for (const child of Array.from(content.children) as LayoutNode[]) {
              const height = child.querySelector('[data-testid^="channels-column-row-"], [role="heading"]') !== null
                ? rowHeight : Number.parseFloat(child.style.height) || 0;
              report(child, y, height);
              y += height;
            }
            contentHeight = y;
            report(content, 0, contentHeight);
            await vi.advanceTimersByTimeAsync(100);
          });
        }
      };
      await settle();
      const initialReads = new Set(readIds);
      for (let step = 0; step < 8; step += 1) {
        await act(async () => {
          scroll.scrollTop = viewportHeight * 4;
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
          await vi.advanceTimersByTimeAsync(100);
        });
        await settle();
      }
      expect(document.querySelector('[data-testid="channels-column-row-0044"]')).not.toBeNull();
      expect(initialReads.has('session-0044')).toBe(false);
      expect(readIds).toContain('session-0044');
      expect(watchedIds).toContain('session-0044');
      expect(readIds).not.toContain('session-0999');
      const beforeHiddenPush = readIds.length;
      await act(async () => { surface.invalidateSession('session-0999', `sha256:${'d'.repeat(64)}`); });
      expect(readIds).toHaveLength(beforeHiddenPush);
      await act(async () => { surface.invalidateSession('session-0044', `sha256:${'e'.repeat(64)}`); });
      expect(readIds).toHaveLength(beforeHiddenPush + 1);
    } finally { vi.useRealTimers(); }

    const search = document.querySelector('[data-testid="channels-column-search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('Column search was not mounted');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('Browser input value setter missing');
    await act(async () => {
      setValue.call(search, 'Conversation 0999');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="channels-column-row-"]')).toHaveLength(1);
      expect(readIds).toContain('session-0999');
      expect(watchedIds).toContain('session-0999');
    });
    const readsAfterFilter = readIds.length;
    await act(async () => { surface.invalidateSession('session-0044', `sha256:${'f'.repeat(64)}`); });
    expect(readIds).toHaveLength(readsAfterFilter);
  });

  it.each(['connections-v1', 'bindings-v1'])('settles a completed %s refusal while the other Resource is still pending', async (refusedResource) => {
    let refuse!: (cause: unknown) => void;
    let finishOther!: (value: ResourceContent) => void;
    const refused = new Promise<ResourceContent>((_resolve, reject) => { refuse = reject; });
    const pending = new Promise<ResourceContent>((resolve) => { finishOther = resolve; });
    let refusedReads = 0;
    const widget = await mountGlance({ view: 'widget', openSurface: () => undefined,
      readResource: async ({ resource }) => {
        const localId = typeof resource === 'string' ? resource : 'localId' in resource ? resource.localId : '';
        if (localId === refusedResource) { refusedReads += 1; return await refused; }
        return await pending;
      },
    });
    expect(document.querySelector('[data-testid="channels-widget-loading"]')).not.toBeNull();
    await act(async () => { refuse(new PluginError({ code: 'collection_update_required',
      message: 'The saved Collection requires an updated declaration.', retryable: false })); });
    await vi.waitFor(async () => { await widget.getByText('Conversations can’t be read right now.'); });
    expect(document.querySelector('[data-testid="channels-widget-loading"]')).toBeNull();
    expect(refusedReads).toBe(1);
    await act(async () => { finishOther(refusedResource === 'connections-v1' ? BINDINGS : CONNECTIONS); });
    await widget.getByText('Conversations can’t be read right now.');
  });

  it('settles an empty linked-conversation read without retaining its loading skeleton', async () => {
    const widget = await mountGlance({ view: 'widget', bindings: jsonResource({ bindings: [] }, 'e'),
      openSurface: () => undefined });
    await vi.waitFor(async () => { await widget.getByText('Link a conversation to a session.'); });
    expect(document.querySelector('[data-testid="channels-widget-loading"]')).toBeNull();
  });

  it('puts a bot that needs you first, then paused conversations, then the rest, four rows in all', async () => {
    const opened: PluginUiTestkitOpenSurfaceInput[] = [];
    const widget = await mountGlance({ view: 'widget', openSurface: (open) => { opened.push(open); } });

    await vi.waitFor(async () => { await widget.getByText('Leeroy Brun · Ops on-call'); });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="channels-widget-row-"]')]
      .map((row) => row.getAttribute('data-testid'));
    // One row for the Telegram cause (both of its conversations), then #support
    // paused for review, then the rest by name until four rows.
    expect(rows).toEqual([
      'channels-widget-row-cause:provider:com.example.telegram',
      'channels-widget-row-support',
      'channels-widget-row-dev',
      'channels-widget-row-release',
    ]);
    await expect(widget.getByText('Connection needs attention')).resolves.toBeDefined();

    const support = document.querySelector<HTMLElement>('[data-testid="channels-widget-row-support"]');
    await act(async () => { support?.click(); });
    expect(opened.map((open) => [viewName(open), open.subPath])).toEqual([['conversations', 'support']]);
  });
});
