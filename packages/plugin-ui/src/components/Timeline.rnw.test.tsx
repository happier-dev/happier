import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';

import { defineUiSurface } from '../index.js';
import { createPluginUiRnwSemanticSurfaceAdapter } from '../testing/index.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Text } from './Text.js';
import { Timeline } from './Timeline.js';

describe('Timeline', () => {
  it('preserves the author order and exposes event controls independently inside a named list', async () => {
    const actions: string[] = [];
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'timeline', mountNonce: 'timeline' },
      authorPlugin: { id: 'example.timeline', version: '0.0.0' },
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      surface: defineUiSurface(() => (
        <Timeline
          accessibilityLabel="Build activity"
          items={['second', 'first']}
          keyForItem={(item) => item}
          renderItem={(item) => ({
            glyph: <Icon name="check" />,
            heading: <Text variant="label">{item}</Text>,
            time: item === 'second' ? <Text variant="micro">Earlier today</Text> : null,
            body: item === 'second' ? <Button title="Retry build" onPress={() => actions.push('retry')} /> : null,
            trailing: item === 'first' ? <Button title="Open build" onPress={() => actions.push('open')} /> : null,
          })}
        />
      )),
    });
    try {
      await expect(page.getByText('second')).resolves.toBeDefined();
      const list = document.querySelector('[role="list"][aria-label="Build activity"]');
      expect(list).not.toBeNull();
      const rows = list!.querySelectorAll('[role="listitem"]');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('second  Earlier today');
      expect(rows[1].textContent).toContain('first');
      const retry = rows[0].querySelector<HTMLButtonElement>('[role="button"]');
      const open = rows[1].querySelector<HTMLButtonElement>('[role="button"]');
      expect(retry?.getAttribute('aria-label')).toBe('Retry build');
      expect(open?.getAttribute('aria-label')).toBe('Open build');
      // A rail row is reading content. Its actions stay separate keyboard targets.
      expect(rows[0].matches('[role="button"],button')).toBe(false);
      expect(rows[1].matches('[role="button"],button')).toBe(false);
      await act(async () => { retry!.click(); open!.click(); });
      expect(actions).toEqual(['retry', 'open']);
    } finally {
      await page.dispose();
    }
  });
  it('draws a bounded stream in place, with its heading on the sentences and each time in the end column', async () => {
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'timeline-inline', mountNonce: 'timeline-inline' },
      authorPlugin: { id: 'example.timeline', version: '0.0.0' },
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      surface: defineUiSurface(() => (
        <Timeline
          inline
          timeAlign="end"
          accessibilityLabel="Today"
          header={<Text variant="meta">Today</Text>}
          items={['deployed', 'backed up', 'rolled back']}
          keyForItem={(item) => item}
          renderItem={(item) => ({
            glyph: <Icon name="check" />,
            heading: <Text variant="label">{item}</Text>,
            time: <Text variant="meta">{`at ${item}`}</Text>,
          })}
        />
      )),
    });
    try {
      await expect(page.getByText('deployed')).resolves.toBeDefined();
      const list = document.querySelector('[role="list"][aria-label="Today"]');
      const rows = list!.querySelectorAll('[role="listitem"]');
      // Every event of a bounded stream is present at once, in the author's order.
      expect([...rows].map(row => row.textContent)).toEqual(['deployedat deployed', 'backed upat backed up', 'rolled backat rolled back']);
      // The day heading leads the stream, outside its rows.
      expect(document.body.textContent!.indexOf('Today')).toBeLessThan(document.body.textContent!.indexOf('deployed'));
      expect(list!.textContent).not.toContain('Today');
    } finally {
      await page.dispose();
    }
  });
});
