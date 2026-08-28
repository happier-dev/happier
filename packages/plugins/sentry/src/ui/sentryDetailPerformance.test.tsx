// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../sentryContracts.js';
import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTANCE = {
  v: 1,
  instance: {
    source: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-issues' },
    sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
  },
  binding: {
    purpose: 'sentry-account-use',
    account: {
      service: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' },
      accountId: 'account-1',
    },
  },
  localInstanceKey: 'https://us.sentry.io42',
  configuration: { v: 1, token: 'sentry-configuration-token-v1' },
  locator: { v: 1, displayLabel: 'acme-org' },
} as const;

const DETAIL_INPUT = TriageDetailSurfaceInputV1Schema.parse({
  v: 1,
  instance: INSTANCE,
  observation: {
    entryRef: {
      source: INSTANCE.instance.source,
      kindId: 'error-issue',
      collisionScope: 'https://us.sentry.io\u001f42',
      entryId: '1234',
    },
    observedAtMs: 1_760_000_700_000,
    locator: { v: 1, displayPath: 'acme-org/checkout · ACME-42' },
    snapshot: {
      v: 1,
      title: 'ChargeDeclined: card was declined',
      scopeLabel: 'acme-org/checkout',
      state: { presentation: 'active', nativeLabel: 'Unresolved' },
      facts: [],
    },
    viewer: { involvement: [] },
  },
  linkedSessions: [],
});

const OCCURRENCE_COUNT = 100;
const TRACE_SECTION_COUNT = 6;
const FRAMES_PER_SECTION = 40;
const TOTAL_FRAME_COUNT = TRACE_SECTION_COUNT * FRAMES_PER_SECTION;

const occurrenceRows = Array.from({ length: OCCURRENCE_COUNT }, (_, index) => ({
  eventId: index.toString(16).padStart(32, '0'),
  headline: `occurrence ${String(index)}`,
  atMs: 1_760_000_100_000 + index,
}));

const traceSections = Array.from({ length: TRACE_SECTION_COUNT }, (_, sectionIndex) => ({
  kind: 'exception',
  type: `Failure${String(sectionIndex)}`,
  value: `section ${String(sectionIndex)}`,
  frames: Array.from({ length: FRAMES_PER_SECTION }, (_, frameIndex) => ({
    filename: `app/section-${String(sectionIndex)}/frame-${String(frameIndex)}.ts`,
    function: `call${String(frameIndex)}`,
    lineNo: frameIndex + 1,
    colNo: 1,
    inApp: frameIndex % 2 === 0,
    contextLine: `run(${String(frameIndex)});`,
    vars: {},
  })),
}));

const mounted: PluginUiTestkit[] = [];

async function mountMaximumDetailSpecimen(): Promise<PluginUiTestkit> {
  const page = await createPluginUiTestkit({
    identity: {
      pluginId: SENTRY_PLUGIN_ID,
      pluginVersion: '0.0.0',
      viewId: 'sentry-detail',
      generation: 'sentry-detail-performance',
    },
    surface: renderSurface,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    launchInput: DETAIL_INPUT as unknown as JsonValue,
    handlers: {
      executeAction: async ({ action, input }): Promise<JsonValue> => {
        const localId = (action as Readonly<{ localId?: string }>).localId;
        if (localId === SENTRY_ACTION_IDS.readIssue) {
          const projection = (input as Readonly<{ projection?: string }>).projection;
          if (projection === 'tags') {
            return { kind: 'tags', tags: [], omittedTagCount: 0, projectionTruncated: false };
          }
          if (projection === 'activity') {
            return {
              kind: 'activity',
              activity: {
                status: 'available',
                items: [],
                malformedItemCount: 0,
                omittedItemCount: 0,
                projectionTruncated: false,
              },
            };
          }
          return {
            kind: 'overview',
            statePresentation: 'active',
            nativeStateLabel: 'Unresolved',
            eventCount: String(OCCURRENCE_COUNT),
          };
        }
        if (localId === SENTRY_ACTION_IDS.listIssueEvents) {
          return {
            kind: 'events',
            rows: occurrenceRows,
            omittedRowCount: 0,
            projectionTruncated: false,
          };
        }
        if (localId === SENTRY_ACTION_IDS.readEvent) {
          return {
            kind: 'event',
            projection: {
              eventId: 'a'.repeat(32),
              dateCreatedMs: 1_760_000_000_000,
              title: 'ChargeDeclined',
              message: 'card was declined',
              location: null,
              culprit: null,
              platform: 'javascript',
              sections: traceSections,
              tags: [],
              user: null,
              redactions: [],
              sensitivePaths: [],
              projectionTruncated: false,
              omitted: {
                sections: 0,
                frames: 0,
                breadcrumbs: 0,
                tags: 0,
                redactions: 0,
                sensitivePaths: 0,
              },
            },
          };
        }
        if (localId === SENTRY_ACTION_IDS.listTagValues) {
          return {
            kind: 'tagValues',
            tagKey: 'url',
            rows: [],
            omittedRowCount: 0,
            projectionTruncated: false,
          };
        }
        throw new Error(`unexpected action ${String(localId)}`);
      },
    },
  });
  mounted.push(page);
  return page;
}

async function selectTab(page: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await page.press(await page.getByRole('tab', { name }));
  });
}

function verticalScrollAncestors(element: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.style.overflowY === 'auto' || ancestor.style.overflowY === 'scroll') {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

afterEach(async () => {
  for (const page of mounted.splice(0)) await page.dispose();
});

describe('Sentry maximum-detail mounted-work specimen', () => {
  it('windows 100 Occurrences and a 240-frame trace through one List owner', async () => {
    const page = await mountMaximumDetailSpecimen();

    await selectTab(page, 'Occurrences');
    const mountedOccurrences = await page.queryAllByRole('listitem');
    expect(mountedOccurrences.length).toBeGreaterThan(0);
    expect(mountedOccurrences.length).toBeLessThan(OCCURRENCE_COUNT);

    await selectTab(page, 'Stack Trace');
    const stackTraceLists = document.querySelectorAll<HTMLElement>(
      '[role="list"][aria-label="Stack Trace"]',
    );
    expect(stackTraceLists).toHaveLength(1);
    expect(verticalScrollAncestors(stackTraceLists[0]!)).toEqual([]);
    const mountedApplicationFrames = await page.queryAllByRole('listitem');
    expect(mountedApplicationFrames.length).toBeGreaterThan(0);
    expect(mountedApplicationFrames.length).toBeLessThan(TOTAL_FRAME_COUNT / 2);

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Show system frames' }));
    });
    const mountedExpandedFrames = await page.queryAllByRole('listitem');
    expect(mountedExpandedFrames.length).toBeGreaterThan(0);
    expect(mountedExpandedFrames.length).toBeLessThan(TOTAL_FRAME_COUNT);
  });
});
