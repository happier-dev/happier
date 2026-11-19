// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  defineUiSurface,
  EmptyState,
  Text,
  useTabPanelActivity,
} from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  TriageDetailSurfaceInputV1JsonSchema,
  admitTriageSourceDescriptorV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageDetailPanel, TriageEvidenceDisclosureProvider, useTriageDetailFilesCount, useTriageDetailPanelOpener, useTriageDetailFixPullRequestNavigation, useTriageEvidenceDisclosure, type TriageDetailFixPullRequestNavigationV1, type TriageEvidenceDisclosureV1 } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageDetailPageLeadProvider, TriageDetailTabbedBody } from './body.js';
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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  sourceCustody: {
    kind: 'development' as const,
    registeredRootId: 'source-root',
  },
});
const SURFACE = Object.freeze({
  point: {
    pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    protocol: PROTOCOL,
  },
  contributor: CONTRIBUTOR,
  role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  presentation: 'content' as const,
});

/** The published detail input schema, narrowed to require `panel: 'files'`. */
function panelInputSchema(panel = 'files', scrollOwner?: 'list') {
  const base = TriageDetailSurfaceInputV1JsonSchema as Readonly<
    Record<string, unknown>
  > & {
    properties: Record<string, unknown>;
    required: readonly string[];
  };
  return {
    ...base,
    // A bare `const` is the canonical projection of a protocol literal.
    properties: { ...base.properties, panel: { const: panel },
      ...(scrollOwner === undefined ? {} : { panelScrollOwner: { const: scrollOwner } }) },
    required: [...base.required, 'panel', ...(scrollOwner === undefined ? [] : ['panelScrollOwner'])],
  };
}

const MOUNT = Object.freeze({
  kind: 'targetedSurface',
  target,
  point: SURFACE.point,
  contributor: CONTRIBUTOR,
  role: SURFACE.role,
  presentation: 'content',
  inputSchema: panelInputSchema(),
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
        declarativeInventory: {
          actions: [],
          destinations: [],
          settings: [],
          uiQueries: [],
        },
        root: { kind: 'text', path: 'root', order: 0, text: PANEL_BODY },
      },
    },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
  },
  executionOrigin: {
    serverIdentityId: 'srv_example',
    materializationRef: {
      machineId: 'machine-example',
      materializationId: 'materialization-a',
      pluginId: SOURCE_PLUGIN,
    },
  },
  resourceCapability: { readable: true, dynamic: true },
  contributorTargetedContributions: {
    target: {
      pluginId: SOURCE_PLUGIN,
      occurrenceId: CONTRIBUTOR.occurrenceId,
      sourceCustody: CONTRIBUTOR.sourceCustody,
    },
    points: [],
  },
});
const MANIFEST = definePlugin({
  id: SOURCE_PLUGIN,
  version: '1.0.0',
  ui: {
    renderers: [
      {
        id: RENDERER,
        kind: 'declarative',
        root: { kind: 'text', text: PANEL_BODY },
      },
    ],
  },
}).manifest;

const INPUT = createTriageSourceV1Fixture()
  .detailInput as TriageDetailSurfaceInputV1;
const LIVE_SESSION = {
  sessionId: 'session-a',
  title: 'Fix rounding',
  lifecycle: 'active',
  runtime: 'idle',
  operational: 'ready',
  workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' },
  pendingPermissions: [],
} satisfies SessionStateV1;

let tabs: readonly TriageDetailTabV1[] = [];
let session: React.ReactNode;
let fixNavigation: TriageDetailFixPullRequestNavigationV1 | undefined;
let pushed = false;
let pageLead: React.ReactNode = null;
let fixMount: React.ComponentProps<typeof TriageDetailTabbedBody>['fixPullRequest'] = null;
let disclosure: TriageEvidenceDisclosureV1 | null = null;
let renderAdmitted: ((launchInput: unknown) => React.ReactNode) | null = null;
const renderBody = defineUiSurface(function Body(
  _context: RenderContext,
): React.ReactElement {
  const body = (
    <TriageDetailPageLeadProvider lead={pageLead}>
    <TriageDetailTabbedBody
      tabs={tabs}
      entry={{ surface: SURFACE, input: INPUT, instanceKey: 'entry-a' }}
      fixPullRequest={fixMount}
      fixPullRequestNavigation={fixNavigation}
      pushed={pushed}
      session={session}
      overviewTail={
        <TriageAgentStep
          sessions={[
            { sessionId: 'session-a', displayTitle: 'Old relationship label' },
          ]}
          hasMore={false}
          live={{ status: 'ready', state: LIVE_SESSION }}
          reviewEntry={{ kind: 'pullRequest' }}
        />
      }
      fallback={<EmptyState title={FALLBACK} />}
    />
    </TriageDetailPageLeadProvider>
  );
  return disclosure === null ? body
    : <TriageEvidenceDisclosureProvider disclosure={disclosure}>{body}</TriageEvidenceDisclosureProvider>;
});

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  fixMount = null;
  disclosure = null;
  renderAdmitted = null;
});

async function mountBody(
  nextTabs: readonly TriageDetailTabV1[],
  probe?: React.ReactNode,
  nextSession?: React.ReactNode,
  requiredPanel?: string,
  navigation?: TriageDetailFixPullRequestNavigationV1,
  requiredScrollOwner?: 'list',
) {
  tabs = nextTabs;
  session = nextSession;
  fixNavigation = navigation;
  const fixture = await createPluginUiTestkit({
    identity: {
      instanceId: 'fixture-instance-detail-body',
      mountNonce: 'fixture-mount-detail-body',
    },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: renderBody,
    surfaceContext: context,
    adapter: createPluginUiRnwSemanticSurfaceAdapter({
      targetedSurfaces: {
        readCurrentMounts: () => [
          requiredPanel !== undefined
            ? { ...MOUNT, inputSchema: panelInputSchema(requiredPanel, requiredScrollOwner) }
            : probe === undefined
              ? MOUNT
              : { ...MOUNT, inputSchema: TriageDetailSurfaceInputV1JsonSchema },
        ],
        readContributorManifest: () => MANIFEST,
        ...(renderAdmitted !== null ? { renderAdmittedContent: ({ launchInput }: { launchInput: unknown }) => renderAdmitted?.(launchInput) }
          : probe === undefined ? {} : { renderAdmittedContent: () => probe }),
      },
    }),
    handlers: {
      executeAction: async () => ({}),
      readSession: () => LIVE_SESSION,
    },
  });
  mounted.push(fixture);
  return fixture;
}

const PR_TABS = planTriageDetailTabsV1({
  workflowSubject: 'pullRequest',
  entryTabs: [
    { kind: 'shared', id: 'overview' },
    { kind: 'shared', id: 'activity' },
    { kind: 'shared', id: 'files', scrollOwner: 'list' },
    { kind: 'shared', id: 'checks' },
  ],
  fixPullRequest: null,
});

describe('the tabbed detail body (r0.42)', () => {
  it('draws the source file count from its existing completed read', async () => {
    function Source() {
      useTriageDetailFilesCount({ kind: 'ready', rows: ['a', 'b'], omittedRowCount: 0,
        canLoadMore: false, incomplete: null, failure: null });
      return <Text value="files" />;
    }
    if (PR_TABS.kind !== 'tabs') throw new Error('Expected tabs');
    const body = await mountBody(PR_TABS.tabs, <Source />);
    expect(document.querySelector('[role="tablist"]')?.textContent).toContain('Files2');
    await body.dispose();
  });
  it('uses the source’s visible panels and falls back without retiring its retained detail', async () => {
    let mounts = 0;
    let retires = 0;
    function Source() {
      const [trace, setTrace] = React.useState(true);
      React.useEffect(() => { mounts++; return () => { retires++; }; }, []);
      return <TriageDetailPanel panel="overview" ariaLabel="Source sections"
        visiblePanels={trace ? ['overview', 'activity', 'stack-trace'] : ['overview', 'activity']}
        panels={{ overview: <Button title={trace ? 'Remove trace' : 'Restore trace'} onPress={() => setTrace(!trace)} />,
          activity: <Text value="Event activity" />,
          'stack-trace': <Text value="Trace frames" /> }} />;
    }
    const plan = planTriageDetailTabsV1({ workflowSubject: 'errorIssue',
      // Keep the page strip visible after withdrawal: Tabs hides a one-page strip.
      entryTabs: [{ kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'activity' },
        { kind: 'source', id: 'stack-trace', title: 'Stack trace' }],
      fixPullRequest: null });
    if (plan.kind !== 'tabs') throw new Error('Expected tabs');
    const body = await mountBody(plan.tabs, <Source />);
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Stack trace' })); });
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Remove trace' })); });
    await expect(body.queryByRole('tab', { name: 'Stack trace' })).resolves.toBeUndefined();
    await expect(body.getByRole('tab', { name: 'Overview', state: { selected: true } })).resolves.toBeDefined();
    expect({ mounts, retires }).toEqual({ mounts: 1, retires: 0 });
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Restore trace' })); });
    await expect(body.getByRole('tab', { name: 'Stack trace' })).resolves.toBeDefined();
    expect({ mounts, retires }).toEqual({ mounts: 1, retires: 0 });
  });
  it('offers no fix navigation when the frame has no admitted primary', async () => {
    if (PR_TABS.kind !== 'tabs') throw new Error('Expected tab composition');
    function Probe() { return <Text value={useTriageDetailFixPullRequestNavigation() === null ? 'No fix navigation' : 'Unexpected navigation'} />; }
    const mounted = await mountBody(PR_TABS.tabs, <Probe />);
    await expect(mounted.getByText('No fix navigation')).resolves.toBeDefined();
  });
  it('offers the resolved fix navigation to the admitted source through its existing panel context', async () => {
    if (PR_TABS.kind !== 'tabs') throw new Error('Expected tab composition');
    const entryRef = { ...INPUT.observation.entryRef, entryId: 'off-page-fix' };
    let opens = 0;
    const navigation: TriageDetailFixPullRequestNavigationV1 = { entryRef, title: 'Resolved off-page fix', url: null,
      open: async () => { opens++; return { kind: 'opened' }; }, openExternal: async () => {} };
    function Probe() {
      const fix = useTriageDetailFixPullRequestNavigation();
      return fix === null ? <Text value="No fix binding" />
        : <Button title={fix.title} onPress={() => { void fix.open(); }} />;
    }
    const mounted = await mountBody(PR_TABS.tabs, <Probe />, undefined, undefined, navigation);
    await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Resolved off-page fix' })); });
    expect(opens).toBe(1);
  });
  it.each([false, true])(
    'mounts an admitted source session panel independently of a linked Session (%s)',
    async (linked) => {
      const source = createTriageSourceV1Fixture().descriptor;
      const admitted = admitTriageSourceDescriptorV1({
        ...source,
        kinds: [
          {
            ...source.kinds[0],
            detailTabs: [
              { kind: 'shared', id: 'overview' },
              { kind: 'source', id: 'session', title: 'Session history' },
            ],
          },
        ],
      });
      if (!admitted.ok)
        throw new Error(`Public descriptor refused: ${admitted.reason}`);
      const kind = admitted.descriptor.kinds[0]!;
      const plan = planTriageDetailTabsV1({
        workflowSubject: kind.workflowSubject ?? null,
        entryTabs: kind.detailTabs,
        fixPullRequest: null,
      });
      const body = await mountBody(
        plan.kind === 'tabs' ? plan.tabs : [],
        undefined,
        linked ? <Text value="The linked Happier Session" /> : undefined,
        'session',
      );
      await act(async () => {
        await body.press(
          await body.getByRole('tab', { name: 'Session history' }),
        );
      });
      // Cold admission accepts the original author panel only, never the frame's tab identity.
      await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
      if (linked) {
        await act(async () => {
          await body.press(await body.getByRole('tab', { name: 'Session' }));
        });
        await expect(
          body.getByText('The linked Happier Session'),
        ).resolves.toBeDefined();
        await expect(body.queryByText(PANEL_BODY)).resolves.toBeUndefined();
        await act(async () => {
          await body.press(
            await body.getByRole('tab', { name: 'Session history' }),
          );
        });
        await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
      }
    },
  );

  it('maps source panel openers to their frame tabs without exposing the host Session as a source panel', async () => {
    function SourceOpener() {
      const open = useTriageDetailPanelOpener('session');
      return open === undefined ? (
        <Text value="No source session panel" />
      ) : (
        <Button title="Open session history" onPress={open} />
      );
    }
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'pullRequest',
      entryTabs: [
        { kind: 'shared', id: 'overview' },
        { kind: 'source', id: 'session', title: 'Session history' },
      ],
      fixPullRequest: null,
    });
    const body = await mountBody(
      plan.kind === 'tabs' ? plan.tabs : [],
      <SourceOpener />,
      <Text value="Linked Session" />,
    );
    await act(async () => {
      await body.press(
        await body.getByRole('button', { name: 'Open session history' }),
      );
    });
    await expect(
      body.getByRole('tab', {
        name: 'Session history',
        state: { selected: true },
      }),
    ).resolves.toBeDefined();
    await body.dispose();
    const shared = await mountBody(
      PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [],
      <SourceOpener />,
      <Text value="Linked Session" />,
    );
    await expect(
      shared.getByText('No source session panel'),
    ).resolves.toBeDefined();
  });

  it('keeps one admitted source selection and settled pages across panels, then cancels on retirement', async () => {
    const intervals: AbortSignal[] = [];
    const secondUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    function SourceSelectionProbe() {
      const [uuid, select] = React.useState(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const [pages, setPages] = React.useState(1);
      const { activeSignal } = useTabPanelActivity();
      React.useEffect(() => {
        intervals.push(activeSignal);
      }, [activeSignal]);
      return (
        <>
          <Button
            title="Select second event"
            onPress={() => select(secondUuid)}
          />
          <Button
            title="Next source page"
            onPress={() => setPages((count) => count + 1)}
          />
          <Text value={`Selected ${uuid}, pages ${pages}`} />
        </>
      );
    }
    const body = await mountBody(
      PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [],
      <SourceSelectionProbe />,
      <Text value="Linked session" />,
    );
    await act(async () => {
      await body.press(
        await body.getByRole('button', { name: 'Select second event' }),
      );
    });
    await act(async () => {
      await body.press(
        await body.getByRole('button', { name: 'Next source page' }),
      );
    });
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Activity' }));
    });
    await expect(
      body.getByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeDefined();
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Overview' }));
    });
    await expect(
      body.getByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeDefined();
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    await expect(
      body.getByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeDefined();
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Overview' }));
    });
    await expect(
      body.getByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeDefined();
    const sourceInterval = intervals.at(-1)!;
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Session' }));
    });
    expect(sourceInterval.aborted).toBe(true);
    await expect(
      body.queryByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeUndefined();
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Overview' }));
    });
    await expect(
      body.getByText(`Selected ${secondUuid}, pages 2`),
    ).resolves.toBeDefined();
    expect(intervals.at(-1)?.aborted).toBe(false);
    await body.dispose();
    expect(intervals.every((signal) => signal.aborted)).toBe(true);
  });
  it('retires the live Session tree whenever its tab is hidden', async () => {
    let mounts = 0;
    let active = 0;
    function SessionProbe() {
      React.useEffect(() => {
        mounts += 1;
        active += 1;
        return () => {
          active -= 1;
        };
      }, []);
      return <Text value="Linked Session probe" />;
    }
    const body = await mountBody(
      PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [],
      undefined,
      <SessionProbe />,
    );
    expect({ mounts, active }).toEqual({ mounts: 0, active: 0 });
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Session' }));
    });
    expect({ mounts, active }).toEqual({ mounts: 1, active: 1 });
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Overview' }));
    });
    expect({ mounts, active }).toEqual({ mounts: 1, active: 0 });
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Session' }));
    });
    expect({ mounts, active }).toEqual({ mounts: 2, active: 1 });
  });
  it("lets the source open a sibling panel through the frame's own selection, and only one it offers", async () => {
    function SourceOpener() {
      const openFiles = useTriageDetailPanelOpener('files');
      const openReleases = useTriageDetailPanelOpener('release');
      return (
        <>
          {openFiles === undefined ? null : (
            <Button title="Open files" onPress={openFiles} />
          )}
          {openReleases === undefined ? (
            <Text value="No release panel here" />
          ) : (
            <Button title="Open release" onPress={openReleases} />
          )}
        </>
      );
    }
    const body = await mountBody(
      PR_TABS.kind === 'tabs' ? PR_TABS.tabs : [],
      <SourceOpener />,
    );
    await expect(
      body.getByText('No release panel here'),
    ).resolves.toBeDefined();
    await act(async () => {
      await body.press(await body.getByRole('button', { name: 'Open files' }));
    });
    await expect(
      body.getByRole('tab', { name: 'Files', state: { selected: true } }),
    ).resolves.toBeDefined();
  });
  it('keeps declared fix-PR panels visible with the unavailable state before the PR mount is ready', async () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'issue',
      entryTabs: [{ kind: 'shared', id: 'overview' }],
      fixPullRequest: {
        detailTabs: [
          { kind: 'shared', id: 'files', scrollOwner: 'list' },
          { kind: 'shared', id: 'checks' },
        ],
      },
    });
    const body = await mountBody(plan.kind === 'tabs' ? plan.tabs : []);
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });
  it("keeps a linked fix PR's write and status out of the issue's header: the fix is drawn once, in its own step", async () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'issue',
      entryTabs: [{ kind: 'shared', id: 'overview' }],
      fixPullRequest: { detailTabs: [{ kind: 'shared', id: 'files', scrollOwner: 'list' }] },
    });
    const fixInput = { ...INPUT, observation: { ...INPUT.observation,
      entryRef: { ...INPUT.observation.entryRef, entryId: 'fix-pr-7' } } } as TriageDetailSurfaceInputV1;
    fixMount = { surface: SURFACE, input: fixInput, instanceKey: 'fix-a' };
    const offered: string[] = [];
    disclosure = { available: false, disclose: async () => ({ kind: 'inert' }),
      primaryWrite: { offer: (write) => { if (write !== null) offered.push('write'); },
        offerStatus: (status) => { if (status !== null) offered.push('status'); } } };
    function Publisher(props: Readonly<{ entryId: string }>) {
      const host = useTriageEvidenceDisclosure().primaryWrite;
      React.useLayoutEffect(() => {
        if (props.entryId !== 'fix-pr-7') return;
        host?.offerStatus?.({ kind: 'unavailable', failure: { code: 'unavailable' } } as never);
        host?.offer({ title: 'Merge' } as never);
      }, [host, props.entryId]);
      return <Text value={`${props.entryId} ${host === undefined ? 'publishes nothing' : 'publishes to the header'}`} />;
    }
    renderAdmitted = (launchInput) => <Publisher
      entryId={(launchInput as TriageDetailSurfaceInputV1).observation.entryRef.entryId} />;
    const body = await mountBody(plan.kind === 'tabs' ? plan.tabs : [], <Text value="unused" />, undefined, 'files', undefined, 'list');
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    expect(offered).toEqual([]);
    await expect(body.getByText('fix-pr-7 publishes nothing')).resolves.toBeDefined();
  });
  it("opens on Overview with the story rail's agent step, and names the tabs in Triage's order", async () => {
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);

    const tabNames = (await body.getAllByRole('tab')).map((tab) => tab.name);
    expect(tabNames).toEqual(['Overview', 'Activity', 'Files', 'Checks']);
    // ③, named after the linked Session doing the work.
    expect(
      document.querySelector('[data-testid="triage-story-agent"]')?.textContent,
    ).toContain('Fix rounding');
    await expect(
      body.getByRole('button', { name: 'Open Fix rounding' }),
    ).resolves.toBeDefined();
    // Overview asked for the overview panel, which this fixture refuses.
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });

  it("names a tab's count beside its title when the source summarized it", async () => {
    // An issue's Checks come from its linked fix, which its header has no cell for: the tab says their outcome.
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'issue',
      entryTabs: [{ kind: 'shared', id: 'overview' }],
      fixPullRequest: {
        detailTabs: [
          { kind: 'shared', id: 'files', scrollOwner: 'list' },
          { kind: 'shared', id: 'checks', summaryFact: 'example/checks' },
        ],
        facts: [
          {
            id: 'example/checks',
            importance: 'primary',
            value: { kind: 'status', value: '2 failing', tone: 'danger' },
          },
        ],
      },
    });
    const body = await mountBody(plan.kind === 'tabs' ? plan.tabs : []);
    const strip = document.querySelector('[role="tablist"]')?.textContent ?? '';
    expect(strip).toContain('Checks2 failing');
    // Files has no summary, so it says nothing rather than an invented zero.
    expect(strip).toContain('FilesChecks');
    await body.dispose();
  });

  it('honors an arbitrary source panel declaring its List as the sole scroller', async () => {
    const source = createTriageSourceV1Fixture().descriptor;
    const admitted = admitTriageSourceDescriptorV1({
      ...source,
      kinds: [{ ...source.kinds[0], detailTabs: [
        { kind: 'shared', id: 'overview' },
        { kind: 'source', id: 'events', title: 'Events', scrollOwner: 'list' },
      ] }],
    });
    if (!admitted.ok) throw new Error(`Public descriptor refused: ${admitted.reason}`);
    const plan = planTriageDetailTabsV1({ workflowSubject: null,
      entryTabs: admitted.descriptor.kinds[0]!.detailTabs, fixPullRequest: null });
    const body = await mountBody(plan.kind === 'tabs' ? plan.tabs : [], undefined, undefined, 'events', undefined, 'list');
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Events' })); });
    await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
    const leaf = [...document.querySelectorAll('*')].find(node => node.textContent === PANEL_BODY && node.children.length === 0);
    let ancestor = leaf?.parentElement ?? null;
    while (ancestor !== null) {
      expect(['auto', 'scroll']).not.toContain(getComputedStyle(ancestor).overflowY);
      ancestor = ancestor.parentElement;
    }
  });

  it("scrolls content panels while source-declared Lists own their scroller (QB-55/81)", async () => {
    // Live 2026-10-23: Activity on a long PR rendered 33 000 px of timeline inside a pane that could not scroll.
    // Live 2026-11-06 (QB-81): Files nested the source's virtualized diff inside this frame scroller.
    const scrollAncestor = (text: string): Element | null => {
      const leaf = [...document.querySelectorAll('*')].find(
        (node) => node.textContent === text && node.children.length === 0,
      );
      let scroller: Element | null = leaf?.parentElement ?? null;
      while (scroller !== null && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      return scroller;
    };
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
    expect(scrollAncestor(PANEL_BODY)).toBeNull();

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Activity' }));
    });
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
    expect(scrollAncestor(FALLBACK)).not.toBeNull();
  });

  it('scrolls a source List panel with the whole phone detail page, as in the lab (D21)', async () => {
    // Live 2026-11-07 (390×701): a bounded Occurrences List kept 38 px of rows under its fixed selected-event header.
    const leafScroller = (text: string): Element | null => {
      const leaf = [...document.querySelectorAll('*')].find(
        (node) => node.textContent === text && node.children.length === 0,
      );
      let scroller: Element | null = leaf?.parentElement ?? null;
      while (scroller !== null && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      return scroller;
    };
    pushed = true;
    pageLead = <EmptyState title="Entry title and facts" />;
    try {
      const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);
      await act(async () => {
        await body.press(await body.getByRole('tab', { name: 'Files' }));
      });
      await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
      expect(leafScroller(PANEL_BODY)).not.toBeNull();
      // The title and facts lead the page above its tab row (lab merged-detail-pr phone), in the story's one scroll:
      // they scroll away while the row stays pinned (Tabs `lead`).
      const title = [...document.querySelectorAll('*')].find((node) => node.textContent === 'Entry title and facts' && node.children.length === 0)!;
      const tablist = document.querySelector('[role="tablist"]')!;
      expect(title.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(leafScroller('Entry title and facts')).toBe(leafScroller(PANEL_BODY));
      expect(leafScroller(PANEL_BODY)!.contains(tablist)).toBe(true);
    } finally { pushed = false; pageLead = null; }
  });

  it('mounts the source asking for exactly the tab it shows', async () => {
    const body = await mountBody(PR_TABS.kind === 'tabs' ? PR_TABS.tabs : []);

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Files' }));
    });
    await expect(body.getByText(PANEL_BODY)).resolves.toBeDefined();
    expect(
      document.querySelector('[data-testid="triage-story-agent"]'),
    ).toBeNull();

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Checks' }));
    });
    await expect(body.queryByText(PANEL_BODY)).resolves.toBeUndefined();
    await expect(body.getByText(FALLBACK)).resolves.toBeDefined();
  });
});
