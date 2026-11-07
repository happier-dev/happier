// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TriageLinkedSessions } from './linkedSessions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: Array<Readonly<{ action: string; input: unknown }>> = [];
let openFails = false;
let releaseOpen: (() => void) | null = null;
let blockOpen = false;
let selectedSessionId: string | null = null;

const renderHeader = defineUiSurface(function LinkedSessionHeader(_context: RenderContext): React.ReactElement {
  return (
    <TriageLinkedSessions
      sessions={[
        { sessionId: 'session-linked', displayTitle: 'Route repair' },
        { sessionId: 'session-other', displayTitle: 'Parser cleanup' },
      ]}
      hasMore
      onSelect={(sessionId) => { selectedSessionId = sessionId; }}
      onLoadMore={() => {}}
    />
  );
});

const mounted: PluginUiTestkit[] = [];

async function mountHeader(titles = ['Route repair', 'Parser cleanup'], options: Readonly<{
  surface?: typeof renderHeader;
  onRead?: (sessionId: string) => void;
  onWatch?: (sessionId: string, signal: AbortSignal) => void;
}> = {}) {
  calls.length = 0;
  openFails = false;
  releaseOpen = null;
  blockOpen = false;
  selectedSessionId = null;
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'fixture-instance-175', mountNonce: 'fixture-mount-175' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: options.surface ?? renderHeader,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      readSession: ({ sessionId }) => {
        options.onRead?.(sessionId);
        return {
          sessionId, title: titles[sessionId === 'session-linked' ? 0 : sessionId === 'session-other' ? 1 : 2],
          lifecycle: 'active', runtime: 'waiting', operational: 'ready',
          workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' }, pendingPermissions: [],
        };
      },
      ...(options.onWatch === undefined ? {} : {
        watchSession: ({ sessionId, signal }) => { options.onWatch?.(sessionId, signal); },
      }),
      executeAction: async ({ action, input }) => {
        calls.push({ action: String(action), input });
        if (blockOpen) {
          await new Promise<void>((resolve) => { releaseOpen = resolve; });
        }
        if (openFails) throw new Error('open failed');
        return {};
      },
    },
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('common-header linked Sessions', () => {
  it('retains each existing Session read and watch while a page appends, follows title invalidation, and retires removed rows', async () => {
    const reads: string[] = [];
    const watches = new Map<string, AbortSignal>();
    const titles = ['Route repair', 'Parser cleanup', 'Another investigation'];
    let append!: () => void;
    let removeFirst!: () => void;
    const onSelect = (sessionId: string) => { selectedSessionId = sessionId; };
    const surface = defineUiSurface(function PagingHeader() {
      const [sessions, setSessions] = React.useState([{ sessionId: 'session-linked' }, { sessionId: 'session-other' }]);
      append = () => setSessions((previous) => [...previous, { sessionId: 'session-third' }]);
      removeFirst = () => setSessions((previous) => previous.filter((session) => session.sessionId !== 'session-linked'));
      return <TriageLinkedSessions sessions={sessions} hasMore onSelect={onSelect} />;
    });
    const header = await mountHeader(titles, { surface, onRead: (id) => reads.push(id),
      onWatch: (id, signal) => { watches.set(id, signal); } });
    const firstWatch = watches.get('session-linked');
    const otherWatch = watches.get('session-other');
    expect(reads).toEqual(['session-linked', 'session-other']);
    await act(async () => { append(); });
    await expect(header.getByRole('button', { name: 'Another investigation' })).resolves.toBeDefined();
    expect(reads).toEqual(['session-linked', 'session-other', 'session-third']);
    expect(watches.get('session-linked')).toBe(firstWatch);
    expect(watches.get('session-other')).toBe(otherWatch);
    expect(firstWatch?.aborted).toBe(false);

    titles[0] = 'Current investigation';
    await act(async () => { header.invalidateSession('session-linked', `sha256:${'2'.repeat(64)}`); });
    await expect(header.getByRole('button', { name: 'Current investigation' })).resolves.toBeDefined();
    expect(reads).toEqual(['session-linked', 'session-other', 'session-third', 'session-linked']);
    await act(async () => { removeFirst(); });
    await expect(header.queryByRole('button', { name: 'Current investigation' })).resolves.toBeUndefined();
    // The semantic host's establishment signal ends with admission, so prove
    // withdrawal through the real watch event boundary rather than that signal.
    await act(async () => { header.invalidateSession('session-linked', `sha256:${'3'.repeat(64)}`); });
    expect(reads).toEqual(['session-linked', 'session-other', 'session-third', 'session-linked']);
    expect(watches.get('session-other')).toBe(otherWatch);
    await expect(header.getByRole('button', { name: 'Parser cleanup' })).resolves.toBeDefined();
  });
  it('names linked Session controls from the current public host snapshot', async () => {
    const header = await mountHeader(['Current investigation', 'Current parser cleanup']);
    await expect(header.getByRole('button', { name: 'Current investigation' })).resolves.toBeDefined();
    await expect(header.queryByRole('button', { name: 'Route repair' })).resolves.toBeUndefined();
    await act(async () => { await header.press(await header.getByRole('button', { name: 'Open Current investigation' })); });
    expect(calls).toEqual([{ action: 'session.open', input: { sessionId: 'session-linked' } }]);
  });
  it('selects the inline Session independently from the explicit Open operation and its retryable failure', async () => {
    const header = await mountHeader();
    openFails = true;

    await expect(header.getByRole('button', { name: 'Load more' })).resolves.toBeDefined();

    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Route repair' }));
    });

    expect(selectedSessionId).toBe('session-linked');
    expect(calls).toEqual([]);
    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open Route repair' }));
    });

    expect(calls).toEqual([{ action: 'session.open', input: { sessionId: 'session-linked' } }]);
    // The failure stays on that Session's card, which keeps its name.
    await expect(header.getByRole('button', { name: 'Route repair' })).resolves.toBeDefined();
    await expect(header.getByText('This Session could not be opened.')).resolves.toBeDefined();

    openFails = false;
    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open Route repair' }));
    });
    expect(calls).toHaveLength(2);
    await expect(header.queryByText('This Session could not be opened.')).resolves.toBeUndefined();
  });

  it('describes unavailable rows while another Session is opening', async () => {
    const header = await mountHeader();
    blockOpen = true;

    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open Route repair' }));
      await Promise.resolve();
    });

    // Another Session's card cannot open or be selected meanwhile, and says why.
    const unavailable = await header.getByRole('button', { name: 'Open Parser cleanup', state: { disabled: true } });
    expect(unavailable.state?.disabled).toBe(true);
    await expect(header.queryByRole('button', { name: 'Parser cleanup' })).resolves.toBeUndefined();
    await expect(header.getByText('Another Session is opening.')).resolves.toBeDefined();

    const release = releaseOpen;
    if (release === null) throw new Error('the Session open did not reach the host');
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });
});
