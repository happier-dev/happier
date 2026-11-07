// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { useTriageListAnatomyV1 } from './rows.js';
import type { TriageListItemV1 } from './sections.js';
import { testkitEntryRef, TRIAGE_TESTKIT_SOURCE } from '../../corpus/testkit/observations.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let fixture: PluginUiTestkit | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

function sourceFacts(displayName: string): PluginUiTargetedContributionsV1 {
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  return {
    target: { pluginId: 'happier.triage', occurrenceId: 'target-1', sourceCustody: { kind: 'development', registeredRootId: 'target-root' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, contributionId: TRIAGE_TESTKIT_SOURCE.localId,
        occurrenceId: 'source-1', sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
      protocol,
      descriptor: { v: 1, purpose: 'triage-source', displayName,
        kinds: [{ id: 'pull-request', displayName: 'Pull request', workflowSubject: 'pullRequest' }] },
      operations: [], surfaces: [],
    }] }] }],
  };
}

const ITEM: TriageListItemV1 = {
  key: 'entry-17', group: 'everythingElse', statusGroup: 'everythingElse', summary: null, signal: null, agent: null,
  row: {
    key: 'entry-17', entryRef: testkitEntryRef(), title: 'Example entry', scopeLabel: 'example/repository',
    detail: null, tone: 'neutral', detailKind: null, detailIcon: null, authorLabel: null, designation: null,
    lifecyclePresentation: 'active', activityAtMs: null, kindId: 'pull-request', lifecycleLabel: 'Open',
    observedAtMs: 1_000, stale: false, pinned: false, materialized: true, sourceInstanceId: 'instance-1',
  },
};

describe('Triage row anatomy subscription locality', () => {
  it('retains row callbacks across unrelated serialized host facts but adopts locale changes', async () => {
    let observed: CollectionAnatomy<TriageListItemV1> | undefined;
    const renderSurface = defineUiSurface(function AnatomyProbe() {
      observed = useTriageListAnatomyV1({ withSignal: true });
      return <span>Row anatomy probe</span>;
    });
    const initial = createSurfaceContextFixture({ targetedContributions: sourceFacts('Example forge') });
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'row-anatomy-locality', mountNonce: 'row-anatomy-locality' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: initial,
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });
    });
    const first = observed;
    expect(first).toBeDefined();
    await act(async () => {
      await fixture!.updateSurface({ ...initial, theme: structuredClone(initial.theme),
        ...(initial.targetedContributions === undefined ? {} : { targetedContributions: structuredClone(initial.targetedContributions) }),
        safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 } });
    });
    expect(observed).toBe(first);
    await act(async () => { await fixture!.updateSurface({ ...initial, locale: 'de' }); });
    expect(observed).not.toBe(first);
    const localized = observed;
    expect(localized?.accessibilityHint?.(ITEM)).toContain('Example forge');
    await act(async () => { await fixture!.updateSurface({ ...initial, locale: 'de', targetedContributions: sourceFacts('Renamed forge') }); });
    expect(observed).not.toBe(localized);
    expect(observed?.accessibilityHint?.(ITEM)).toContain('Renamed forge');
  });
});
