// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, defineUiSurface, EmptyState, Text, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  TriageDetailSurfaceInputV1JsonSchema,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { useTriageDetailPanelOpener } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageDetailTabbedBody } from './body.js';
import { TriageAgentStep } from './storyRail.js';
import { planTriageDetailTabsV1, type TriageDetailTabV1 } from './tabs.js';

/**
 * The tabbed detail body keeps the owning source instance while asking it for
 * exactly the selected tab's `panel` (r0.42).
 *
 * The source here is admitted through the SDK testkit's real cold admission,
 * which validates the launch input against the mount's `inputSchema` before a
 * child renders. The fixture's schema admits only `panel: 'files'`, so the
 * source's body appears exactly when the Files tab asks for the Files panel —
 * and a tab that forgot the panel, or asked for the wrong one, shows the
 * fallback instead.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_PLUGIN = 'happier.example.source';
const RENDERER = 'example-detail';
const PANEL_BODY = 'The source files panel';
const FALLBACK = 'Panel not admitted';
const PROTOCOL = Object.freeze({
  id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
});
const context = createSurfaceContextFixture();
const target = context.targetedContributions!.target;
const CONTRIBUTOR = Object.freeze({
  pluginId: SOURCE_PLUGIN,
  contributionId: 'example-forge',
  occurrenceId: 'source-occurrence-a',
  sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' },
});
const SURFACE = Object.freeze({
  point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
  contributor: CONTRIBUTOR,
  role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  presentation: 'content' as const,
});

/** The published detail input schema, narrowed to require `panel: 'files'`. */
function filesOnlyInputSchema() {
  const base = TriageDetailSurfaceInputV1JsonSchema as Readonly<Record<string, unknown>> & {
    properties: Record<string, unknown>;
    required: readonly string[];
  };
  return {
    ...base,
    // A bare `const` is the canonical projection of a protocol literal.
    properties: { ...base.properties, panel: { const: 'files' } },
    required: [...base.required, 'panel'],
  };
}

const MOUNT = Object.freeze({
  kind: 'targetedSurface',
  target,
  point: SURFACE.point,
  contributor: CONTRIBUTOR,
  role: SURFACE.role,
  presentation: 'content',
  inputSchema: filesOnlyInputSchema(),
  rendererChain: [{ pluginId: SOURCE_PLUGIN, localId: RENDERER }],
  selectedRenderer: {
    identity: { pluginId: SOURCE_PLUGIN, localId: RENDERER },
    renderer: {
      kind: 'declarative',
      contributionId: RENDERER,
      model: {
        identity: {
          pluginId: SOURCE_PLUGIN,
          localId: RENDERER,
          qualifiedId: `${SOURCE_PLUGIN}/${RENDERER}`,
          occurrenceId: 'source-occurrence-a',
        },
        visible: true,
        requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: PANEL_BODY },
      },
    },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
  },
  executionOrigin: {
    serverIdentityId: 'srv_example',
    materializationRef: { machineId: 'machine-example', materializationId: 'materialization-a', pluginId: SOURCE_PLUGIN },
  },
  resourceCapability: { readable: true, dynamic: true },
  contributorTargetedContributions: {
    target: { pluginId: SOURCE_PLUGIN, occurrenceId: CONTRIBUTOR.occurrenceId, sourceCustody: CONTRIBUTOR.sourceCustody },
    points: [],
  },
});
const MANIFEST = definePlugin({
  id: SOURCE_PLUGIN,
  version: '1.0.0',
  ui: { renderers: [{ id: RENDERER, kind: 'declarative', root: { kind: 'text', text: PANEL_BODY } }] },
}).manifest;

const INPUT = createTriageSourceV1Fixture().detailInput as TriageDetailSurfaceInputV1;

let tabs: readonly TriageDetailTabV1[] = [];
let session: React.ReactNode;
const renderBody = defineUiSurface(function Body(_context: RenderContext): React.ReactElement {
  return (
    <TriageDetailTabbedBody
      tabs={tabs}
      entry={{ surface: SURFACE, input: INPUT, instanceKey: 'entry-a' }}
      fixPullRequest={null}
      session={session}
      overviewTail={(
        <TriageAgentStep
          sessions={[{ sessionId: 'session-a', displayTitle: 'Fix rounding' }]}
          hasMore={false}
          live={{ status: 'unsupported', state: null }}
          reviewEntry={{ kind: 'pullRequest' }}
        />
      )}
      fallback={<EmptyState title={FALLBACK} />}
    />
  );
});

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountBody(nextTabs: readonly TriageDetailTabV1[], probe?: React.ReactNode, nextSession?: React.ReactNode) {
  tabs = nextTabs;
  session = nextSession;
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'fixture-instance-detail-body', mountNonce: 'fixture-mount-detail-body' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: renderBody,
    surfaceContext: context,
    adapter: createPluginUiRnwSemanticSurfaceAdapter({
      targetedSurfaces: {
        readCurrentMounts: () => [probe === undefined ? MOUNT : { ...MOUNT, inputSchema: TriageDetailSurfaceInputV1JsonSchema }],
        readContributorManifest: () => MANIFEST,
        ...(probe === undefined ? {} : { renderAdmittedContent: () => probe }),
      },
    }),
    handlers: { executeAction: async () => ({}) },
  });
  mounted.push(fixture);
  return fixture;
}

const PR_TABS = planTriageDetailTabsV1({
  workflowSubject: 'pullRequest',
  entryTabs: [
    { kind: 'shared', id: 'overview' },
    { kind: 'shared', id: 'activity' },
    { kind: 'shared', id: 'files' },
    { kind: 'shared', id: 'checks' },
  ],
  fixPullRequest: null,
});

describe('the tabbed detail body (r0.42)', () => {
  it('keeps one admitted source selection and settled pages across panels, then cancels on retirement', async () => {
    const intervals: AbortSignal[] = [];
    const secondUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    function SourceSelectionProbe() {
      const [uuid, select] = React.useState('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const [pages, setPages] = React.useState(1);
      const { activeSignal } = useTabPanelActivity();
      React.useEffect(() => { intervals.push(activeSignal); }, [activeSignal]);
      return <>
        <Button title="Select second event" onPress={() => select(secondUuid)} />
        <Button title="Next source page" onPress={() => setPages((count) => count + 1)} />
        <Text value={`Selected ${uuid}, pages ${pages}`} />
      </>;
    }
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [], <SourceSelectionProbe />, <Text value="Linked session" />);
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Select second event' })); });
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Next source page' })); });
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Activity' })); });
    await expect(body.getByText(`Selected ${secondUuid}, pages 2`)).resolves.toBeDefined();
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Overview' })); });
    await expect(body.getByText(`Selected ${secondUuid}, pages 2`)).resolves.toBeDefined();
    const sourceInterval = intervals.at(-1)!;
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Session' })); });
    expect(sourceInterval.aborted).toBe(true);
    await expect(body.queryByText(`Selected ${secondUuid}, pages 2`)).resolves.toBeUndefined();
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Overview' })); });
    await expect(body.getByText(`Selected ${secondUuid}, pages 2`)).resolves.toBeDefined();
    expect(intervals.at(-1)?.aborted).toBe(false);
    await body.dispose();
    expect(intervals.every((signal) => signal.aborted)).toBe(true);
  });
  it('lets the source open a sibling panel through the frame\'s own selection, and only one it offers', async () => {
    function SourceOpener() {
      const openFiles = useTriageDetailPanelOpener('files');
      const openReleases = useTriageDetailPanelOpener('release');
      return <>
        {openFiles === undefined ? null : <Button title="Open files" onPress={openFiles} />}
        {openReleases === undefined ? <Text value="No release panel here" /> : <Button title="Open release" onPress={openReleases} />}
      </>;
    }
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [], <SourceOpener />);
    await expect(body.getByText('No release panel here')).resolves.toBeDefined();
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Open files' })); });
    await expect(body.getByRole('tab', { name: 'Files', state: { selected: true } })).resolves.toBeDefined();
  });
  it('keeps declared fix-PR panels visible with the unavailable state before the PR mount is ready', async () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'issue', entryTabs: [{ kind: 'shared', id: 'overview' }],
      fixPullRequest: { detailTabs: [{ kind: 'shared', id: 'files' }, { kind: 'shared', id: 'checks' }] },
    });
    const body = await mountBody(plan.kind === 'tabs' ? plan.tabs : []);
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Files' })); });
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });
  it('opens on Overview with the story rail\'s agent step, and names the tabs in Triage\'s order', async () => {
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);

    const tabNames = (await body.getAllByRole('tab')).map((tab) => tab.name);
    expect(tabNames).toEqual(['Overview', 'Activity', 'Files', 'Checks']);
    // ③, named after the linked Session doing the work.
    expect(document.querySelector('[data-testid="triage-story-agent"]')?.textContent).toContain('Fix rounding');
    await expect(body.getByRole('button', { name: 'Fix rounding' })).resolves.toBeDefined();
    // Overview asked for the overview panel, which this fixture refuses.
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });

  it('mounts the source asking for exactly the tab it shows', async () => {
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
    expect(document.querySelector('[data-testid="triage-story-agent"]')).toBeNull();

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Checks' }));
    });
    await expect(body.queryByText(PANEL_BODY)).resolves.toBeUndefined();
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });
});
