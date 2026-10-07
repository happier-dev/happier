// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface, EmptyState } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageActivityTimeline, type TriageActivityEventV1 } from './activityTimeline.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 3_600_000;
const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(Body: () => React.ReactElement): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'activity-fixture', mountNonce: 'activity-mount' },
      authorPlugin: { id: 'happier.example.source', version: '0.0.0' },
      surface: defineUiSurface(() => <Body />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: null,
    });
  });
  mounted.push(fixture);
  return fixture;
}

const EMPTY = <EmptyState title="Nothing happened yet" description="The provider recorded no activity." />;

function event(id: string, hoursAgo: number | null, summary: string, extra: Partial<TriageActivityEventV1> = {}): TriageActivityEventV1 {
  return { id, atMs: hoursAgo === null ? null : NOW_MS - hoursAgo * HOUR_MS, kind: 'other', summary, ...extra };
}

describe('TriageActivityTimeline', () => {
  it('reads every merged collection as one chronological stream, undated last', async () => {
    // Two collections handed over back to back, each in its own order, as a source merges them.
    const events = [
      event('event:closed', 1, 'Closed the issue'),
      event('event:undated', null, 'Added a label'),
      event('note:first', 30, 'Commented', { kind: 'comment', actor: 'Mara', quote: 'Can we keep the flag for one release?' }),
      event('event:pushed', 5, 'Pushed a commit', { kind: 'change', detail: 'flag client rounding' }),
    ];
    const page = await mount(() => (
      <TriageActivityTimeline events={events} locale="en" nowMs={NOW_MS}
        accessibilityLabel="Activity" empty={EMPTY} />
    ));

    await expect(page.getByText('Mara')).resolves.toBeDefined();
    // A remark's own words are quoted under its sentence, not folded into it.
    await expect(page.getByText('Can we keep the flag for one release?')).resolves.toBeDefined();
    await expect(page.getByText('flag client rounding')).resolves.toBeDefined();
    const text = document.body.textContent ?? '';
    const order = ['Commented', 'Pushed a commit', 'Closed the issue', 'Added a label'].map((summary) => text.indexOf(summary));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    await expect(page.queryByText('Nothing happened yet')).resolves.toBeUndefined();
  });

  it('keeps each collection\'s own continuation and merges the next page into the same stream', async () => {
    const calls: string[] = [];
    function Paged(): React.ReactElement {
      const [events, setEvents] = React.useState<readonly TriageActivityEventV1[]>([
        event('note:recent', 2, 'Commented recently', { kind: 'comment', actor: 'Jonas' }),
      ]);
      const [more, setMore] = React.useState(true);
      return (
        <TriageActivityTimeline events={events} locale="en" nowMs={NOW_MS}
          accessibilityLabel="Activity" empty={EMPTY}
          continuations={more ? [{
            key: 'notes', title: 'Show earlier notes', pending: false, reads: 'earlier',
            onLoadMore: () => {
              calls.push('notes');
              setMore(false);
              setEvents((current) => [...current, event('note:earlier', 20, 'Opened the issue', { kind: 'state', actor: 'Priya' })]);
            },
          }] : []}
        />
      );
    }
    const page = await mount(Paged);
    // Newest-first notes read EARLIER remarks next, so the control sits above the stream.
    const before = document.body.textContent ?? '';
    expect(before.indexOf('Show earlier notes')).toBeGreaterThanOrEqual(0);
    expect(before.indexOf('Show earlier notes')).toBeLessThan(before.indexOf('Commented recently'));

    await act(async () => { await page.press(await page.getByRole('button', { name: 'Show earlier notes' })); });

    expect(calls).toEqual(['notes']);
    await expect(page.queryByRole('button', { name: 'Show earlier notes' })).resolves.toBeUndefined();
    const text = document.body.textContent ?? '';
    // The earlier page lands before the remark already on screen, not stapled after it.
    expect(text.indexOf('Opened the issue')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Opened the issue')).toBeLessThan(text.indexOf('Commented recently'));
  });

  it('says nothing happened instead of drawing an empty rail', async () => {
    const page = await mount(() => (
      <TriageActivityTimeline events={[]} locale="en" nowMs={NOW_MS} accessibilityLabel="Activity" empty={EMPTY} />
    ));
    await expect(page.getByText('Nothing happened yet')).resolves.toBeDefined();
  });
});
