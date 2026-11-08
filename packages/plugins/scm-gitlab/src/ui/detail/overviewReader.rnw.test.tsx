// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { Button, Tabs, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageGetResultV1Schema, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_ACTION_IDS } from '../../triage/contribution.js';
import { createStubGitlabTransport, gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE } from '../../triage/testkit/gitlabTriage.test-support.js';
import issues from '../../triage/__fixtures__/issueList.json' with { type: 'json' };
import { useGitlabOverview } from './panelReaders.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the GitLab Overview read owner', () => {
  it('consumes exact seeds, keeps a newer native refresh and ignores observation-only publications', async () => {
    const instance = gitlabTestConfiguredInstance();
    const localRef = { kindId: 'issue', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '7' };
    let revision = 81;
    const transport = createStubGitlabTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/user')) return { status: 200, body: { id: 18, username: 'example-author' } };
      if (path.endsWith('/issues/7')) return { status: 200, body: { ...issues[0],
        updated_at: `2026-08-09T15:31:51.${String(revision).padStart(3, '0')}Z`, description: `Body ${revision}` } };
      return undefined;
    } });
    const gitlab = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount },
      services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
    async function exactInput(): Promise<TriageDetailSurfaceInputV1> {
      const result = TriageGetResultV1Schema.parse(await gitlab.invokeAction(GITLAB_TRIAGE_ACTION_IDS.get,
        { v: 1, instance, localRef, lastKnownLocator: { v: 1, routingToken: 'example-group/example-subgroup/example-project' } }, { surface: 'ui' }));
      if (result.kind !== 'present') throw new Error(`Expected present issue: ${result.kind}`);
      const { kind: _kind, localRef: _localRef, detailData, taskFields: _taskFields,
        comparisonSource: _comparison, ...observation } = result;
      return { v: 1, instance, observation: { ...observation,
        entryRef: { source: instance.instance.source, ...localRef }, observedAtMs: Date.now() }, linkedSessions: [],
        ...(detailData === undefined ? {} : { detailData }) };
    }
    const initial = await exactInput();
    function Reader({ input }: { input: TriageDetailSurfaceInputV1 }) {
      const overview = useGitlabOverview(input);
      return <><Text value={`Body: ${overview.value?.description ?? 'reading'}`} />
        <Button title="Refresh native Overview" onPress={overview.refresh} /></>;
    }
    const surface = defineUiSurface(() => {
      const [input, setInput] = React.useState(initial);
      const [open, setOpen] = React.useState(true);
      return <>
        {open ? <Tabs value="overview" onValueChange={() => {}} ariaLabel="Overview reader">
          <Tabs.Item value="overview" title="Overview"><Reader input={input} /></Tabs.Item>
        </Tabs> : null}
        <Button title="Publish observation only" onPress={() => setInput(current => ({ ...current,
          ...(current.detailData === undefined ? {} : { detailData: structuredClone(current.detailData) }),
          observation: { ...current.observation, observedAtMs: current.observation.observedAtMs + 1 } }))} />
        <Button title="Publish exact result" onPress={async () => { setInput(await exactInput()); }} />
        <Button title="Publish source revision without seed" onPress={() => setInput(current => {
          const { detailData: _detailData, ...withoutSeed } = current;
          return { ...withoutSeed, observation: { ...current.observation,
            sourceUpdatedAtMs: Date.parse(`2026-08-09T15:31:51.${String(revision).padStart(3, '0')}Z`),
            nativeRevision: `2026-08-09T15:31:51.${String(revision).padStart(3, '0')}Z` } };
        })} />
        <Button title="Close Overview" onPress={() => setOpen(false)} />
        <Button title="Open Overview" onPress={async () => { setInput(await exactInput()); setOpen(true); }} />
      </>;
    });
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
        shell = await createPluginUiTestkit({ identity: { instanceId: 'gitlab-overview-owner', mountNonce: 'gitlab-overview-owner' },
          authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' }, surface,
          surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
          handlers: { executeAction: request => {
            if (typeof request.action === 'string') throw new Error(`Unexpected local Action ${request.action}`);
            return gitlab.invokeAction(request.action.localId, request.input!, { surface: 'ui', signal: request.signal });
          } } });
      });
      const press = async (name: string) => { await act(async () => { await shell!.press(await shell!.getByRole('button', { name })); }); };
      await shell!.getByText('Body: Body 81');
      expect(transport.requests).toHaveLength(2); // One canonical item + viewer read; seed needs no second read.
      revision = 82;
      await press('Refresh native Overview');
      await shell!.getByText('Body: Body 82');
      expect(transport.requests).toHaveLength(4);
      await press('Publish observation only');
      await shell!.getByText('Body: Body 82');
      expect(transport.requests).toHaveLength(4);
      revision = 83;
      await press('Publish exact result');
      await shell!.getByText('Body: Body 83');
      expect(transport.requests).toHaveLength(6);
      revision = 84;
      await press('Publish source revision without seed');
      await shell!.getByText('Body: Body 84');
      expect(transport.requests).toHaveLength(8);
      await press('Publish observation only');
      expect(transport.requests).toHaveLength(8);
      await press('Close Overview');
      revision = 85;
      await press('Open Overview');
      await shell!.getByText('Body: Body 85');
      expect(transport.requests).toHaveLength(10);
    } finally { await act(async () => { await shell?.dispose(); }); await gitlab.dispose(); }
  });
});
