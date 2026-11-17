import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
import { HappierPublicProfile, HappierPublicProfileWidget, HappierPublicProfileDataProvider } from '@happier-dev/plugin-ui/components';
import { publishHomeAccountChange, publishHomeAccountChangeWake, getHomeAccountChangeDemandedServerIds } from '@/sync/runtime/orchestration/homeAccountChange';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import {
  PublicProfileWidgetPreviewProvider,
  PublicProfileWidgetPreviewRead,
  PublicProfileWidgetSurface,
} from './PublicProfileWidgetSurface';

// Adapt Metro deferred imports only; standalone setup uses the real mounted Action owner.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const account = createProviderSettingsAccountHarness();
const disposeLoader = await installRealActionExecutorModuleLoader();
afterAll(() => disposeLoader());
afterEach(async () => { standardCleanup(); await account.reset(); });
function MountedPreview(props: Readonly<{ children: React.ReactNode }>) {
  const scope = { serverId: account.serverId, accountId: 'account-a' };
  const execution = useMountedActionExecution(scope);
  return <PublicProfileWidgetPreviewRead execution={execution} scope={scope}>{props.children}</PublicProfileWidgetPreviewRead>;
}

const instance = {
  v: 1 as const,
  id: 'sky',
  definition: { kind: 'artifact' as const, artifactId: 'sky-definition' },
  bindings: {},
};

describe('PublicProfileWidgetSurface', () => {
  it('renders identical admitted project anchors through the public page and widget adapters after native layout, and strips both when off', async () => {
    const labels = { identityLine: '', periodTitle: '', periodDetail: '', emptyLayout: '', footerNote: '', report: '', madeWith: '',
      inert: { success: '', warning: '', error: '', incomplete: '' } };
    const usage = { paint: { accent: '#aabbee', paper: '#111111', dark: true }, agent: (id: string) => ({ id, name: id, color: '#aabbee' }),
      labels: { chartLabel: () => 'Projects', unavailable: 'Unavailable', projects: { empty: 'No projects' } } };
    for (const projects of [true, false]) {
      const view = projectPublicProfilePreview({ context: { handle: 'ada', identity: {}, service: null, urls: null },
        snapshot: PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 1, coverage: { status: 'partial', method: 'runtime' },
          period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, fieldCoverage: {}, facts: {} }),
        metadata: { projects: [{ label: 'Public project', url: 'https://example.com/project' }] },
        policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, projects } },
        appearance: { theme: 'auto', atmosphere: { source: 'none' } }, layout: { v: 1, items: [{ kind: 'widget', id: 'projects',
          size: 'wide', frameStyle: 'plain', presentation: { kind: 'usage', widgetId: 'usage_projects', inputs: {} } }] } })!;
      const screen = await renderScreen(<CorePluginUiPresentationScope>
        <HappierPublicProfileDataProvider view={view} usage={usage}>
          <HappierPublicProfile view={view} labels={labels} usage={usage} />
          <HappierPublicProfileWidget view={view} widgetId="projects" labels={labels} usage={usage} testID="standalone" />
        </HappierPublicProfileDataProvider>
      </CorePluginUiPresentationScope>);
      // Native layout is an OS boundary. Deliver its real event; all adapters/models/bodies stay real.
      await act(async () => {
        for (const node of screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function'))
          node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 400 } } });
      });
      expect(screen.findAll(node => typeof node.type === 'string' && node.props.href === 'https://example.com/project')).toHaveLength(projects ? 2 : 0);
      await screen.unmount();
    }
  });
  it('admits 1000 duration facts once for twenty widgets and does no fact work on a Look/size edit', async () => {
    let visits = 0;
    const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10,
      period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { activeDays: 3 } });
    snapshot.facts.sessionDurations = Array.from({ length: 1000 }, () => ({ agentId: 'codex', get durationMs() { visits++; return 100; } }));
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'days', name: 'Days', sizeDeclaration: { sizes: ['medium', 'wide'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'private' } } },
      publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Duration',
        data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } } });
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, { kind: 'inline', definition });
    const source = { context: { handle: 'ada', identity: {}, service: null, urls: null }, snapshot, metadata: {},
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, sessionDurations: true } },
      appearance: { theme: 'auto' as const, atmosphere: { source: 'none' as const } } };
    const labels = { identityLine: '', periodTitle: '', periodDetail: '', emptyLayout: '', footerNote: '', report: '', madeWith: '',
      inert: { success: '', warning: '', error: '', incomplete: '' } };
    const tree = (size: 'medium' | 'wide', facts = snapshot) => <PublicProfileWidgetPreviewProvider value={{ kind: 'ready', source: {
      ...source, snapshot: facts, appearance: { ...source.appearance, theme: size === 'medium' ? 'auto' : 'dark' },
    }, labels }}>
      {Array.from({ length: 20 }, (_, i) => <PublicProfileWidgetSurface key={i} instance={{ ...instance, id: String(i) }}
        descriptor={descriptor} size={size} testID={`block-${i}`} />)}
    </PublicProfileWidgetPreviewProvider>;
    const screen = await renderScreen(tree('medium'));
    expect(screen.getTextContent()).toContain('3');
    expect(visits).toBe(1000);
    visits = 0;
    await screen.update(tree('wide'));
    expect(visits).toBe(0);
    await screen.update(tree('wide', { ...snapshot, computedAtMs: 11, facts: { ...snapshot.facts, activeDays: 4 } }));
    expect(screen.getTextContent()).toContain('4');
    expect(visits).toBe(1000);
  });
  it('keeps a placed block’s slot quiet while the page’s Usage is unavailable, without inventing a per-block cause', async () => {
    const reason = t('publicIdentity.profile.reasons.usage_unavailable');
    const screen = await renderScreen(
      <PublicProfileWidgetPreviewProvider
        value={{ kind: 'unavailable', reason }}
      >
        <PublicProfileWidgetSurface
          instance={instance}
          descriptor={null}
          testID="block"
        />
      </PublicProfileWidgetPreviewProvider>,
    );
    expect(screen.getTextContent()).not.toContain(
      t('publicIdentity.page.blockUnavailable'),
    );
    expect(
      screen.findByTestId('block.awaiting')?.props.accessibilityLabel,
    ).toBe(reason);
  });
});

describe('PublicProfileWidgetPreviewRead', () => {
  it('wakes standalone setup on publication changes and failed-read reconnect, retiring demand on close', async () => {
    const context = { handle: 'leeroy', identity: {}, service: null, urls: null };
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context });
    let reads = 0;
    let failNextRead = false;
    await account.restore({ currentAccount: true,
      features: createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } }),
      httpAnswers: { 'GET /v1/account/public-profile': { select: () => {
        reads++;
        if (failNextRead) { failNextRead = false; throw new TypeError('offline'); }
        return { body: owner };
      } } },
    });
    const screen = await renderScreen(<MountedPreview><Text>Size</Text></MountedPreview>);
    const serverId = account.serverId;
    const reconnect = () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });
    const wake = (homeId: string, entityId: string) => publishHomeAccountChangeWake(homeId,
      { t: 'account-change', changeKinds: ['account'], entityIds: [entityId], sessionSystemRecords: [] }, 'socket');
    try {
      // One read hydrates the owner; real preview preparation captures the same Account again.
      await vi.waitFor(() => expect(reads).toBe(2));
      await act(async () => { wake('other-home', 'public-profile'); wake(serverId, 'workflow-run:other'); reconnect(); });
      expect(reads).toBe(2);
      await act(async () => { wake(serverId, 'public-profile'); });
      await vi.waitFor(() => expect(reads).toBe(4));
      failNextRead = true;
      await act(async () => { wake(serverId, 'public-profile'); });
      expect(reads).toBe(5);
      await act(async () => { reconnect(); });
      await vi.waitFor(() => expect(reads).toBe(7));
      await act(async () => { reconnect(); });
      expect(reads).toBe(7);
      expect(getHomeAccountChangeDemandedServerIds()).toContain(serverId);
    } finally { await screen.unmount(); }
    expect(getHomeAccountChangeDemandedServerIds()).not.toContain(serverId);
  });
  it('keeps a standalone setup’s controls while the page preview is preparing or cannot be prepared', async () => {
    await account.restore({ currentAccount: true,
      features: createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } }),
      httpAnswers: { 'GET /v1/account/public-profile': { status: 503, body: { error: 'unavailable' } } },
    });
    const screen = await renderScreen(<MountedPreview>
      <Text testID="size-selector">Size</Text>
      <PublicProfileWidgetSurface instance={instance} descriptor={null} testID="standalone-preview" />
    </MountedPreview>);
    expect(screen.findByTestId('size-selector')).not.toBeNull();
    await vi.waitFor(() => expect(screen.findByTestId('standalone-preview.awaiting')?.props.accessibilityLabel)
      .toBe(t('publicIdentity.profile.reasons.preparation_unavailable')));
    expect(screen.findByTestId('size-selector')).not.toBeNull();
  });
});
