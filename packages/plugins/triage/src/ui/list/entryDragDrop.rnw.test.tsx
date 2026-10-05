// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, DragSource, DropTarget, type DragSourceProps, type DropTargetProps } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { testkitEntryRef, testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import type { TriageListItemV1 } from './sections.js';
import { useTriageListAnatomyV1 } from './rows.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

function entry(materialized = true): TriageListItemV1 {
  return {
    key: 'entry-17', group: 'inReview', summary: null, signal: null,
    row: {
      key: 'entry-17', entryRef: testkitEntryRef(), title: 'Review the normalizer', scopeLabel: 'example/repository',
      detail: null, tone: 'neutral', detailKind: null, lifecyclePresentation: 'active', activityAtMs: null,
      kindId: 'pull-request', lifecycleLabel: 'Open', observedAtMs: 1, stale: false, pinned: false,
      materialized, sourceInstanceId: materialized ? '11111111-1111-4111-8111-111111111111' : null,
    },
    ...(materialized ? { locator: testkitLocator() } : {}),
  };
}

async function renderAnatomy(item: TriageListItemV1, organizing = false) {
  let source: DragSourceProps | null = null;
  let target: DropTargetProps | null = null;
  const surface = defineUiSurface(function Probe() {
    const anatomy = useTriageListAnatomyV1({ withSignal: false, organizing });
    const content = <Text value="The Collection still owns this row" />;
    const wrapped = anatomy.wrapItem?.(item, content) ?? content;
    // Inspect the public author boundary, then mount its actual children through
    // the public renderer. Physical carry and Action policy are host-owned tests.
    if (React.isValidElement<DragSourceProps>(wrapped) && wrapped.type === DragSource) {
      source = wrapped.props;
      const nested = wrapped.props.children;
      if (React.isValidElement<DropTargetProps>(nested) && nested.type === DropTarget) target = nested.props;
    }
    return wrapped;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'triage-drag-test', mountNonce: 'triage-drag-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface, surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
    });
  });
  mounted.push(fixture);
  await expect(fixture.getByText('The Collection still owns this row')).resolves.toBeDefined();
  return { source, target } as Readonly<{ source: DragSourceProps | null; target: DropTargetProps | null }>;
}

describe('the real PR Collection public drag/drop binding', () => {
  it('opts into the host-owned native grip only while the list is organizing', async () => {
    expect((await renderAnatomy(entry())).source).toMatchObject({ organizing: false });
    expect((await renderAnatomy(entry(), true)).source).toMatchObject({ organizing: true });
  });

  it('carries the qualified entry and selected source instance, and targets its existing Session link Action', async () => {
    const item = entry();
    const binding = await renderAnatomy(item);
    expect(binding.source).toMatchObject({ sourceId: 'entry-reference', reference: {
      entryRef: item.row.entryRef, title: item.row.title,
      sourceInstance: { source: item.row.entryRef.source, sourceInstanceId: item.row.sourceInstanceId },
      lastKnownLocator: testkitLocator(),
    } });
    expect(binding.target).toMatchObject({ targetId: 'entry-session', input: {
      entryRef: item.row.entryRef,
      display: { locator: testkitLocator(), scopeLabel: item.row.scopeLabel },
    } });
  });

  it('keeps an unread pin as ordinary Collection content rather than promising a current source or link destination', async () => {
    expect(await renderAnatomy(entry(false))).toEqual({ source: null, target: null });
  });
});
