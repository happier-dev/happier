// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture,
  type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { OBSERVED_HEAD, previewStatusInput, previewStatusTransport } from '../../triage/testkit/githubMutation.test-support.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(() => surface.dispose());
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

describe('preview receipt publication to the PR Overview', () => {
  it('renders the registered ready publication through the real PR preview reader in Overview', async () => {
    const transport = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active', domainPath: '/app' });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: transport.context.services });
    plugins.push(plugin);
    const publication = previewStatusInput();
    expect(await plugin.invokeAction(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus,
      { ...publication, status: 'ready' })).toMatchObject({ kind: 'applied', publication: { targetUrl: 'https://pr-1284.example.test/app' } });
    const input = TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'overview', instance: publication.instance,
      observation: { entryRef: { source: publication.instance.instance.source, ...publication.localRef },
        observedAtMs: 1, locator: { v: 1, routingToken: publication.routingToken },
        snapshot: { v: 1, title: 'Preview this pull request', scopeLabel: 'octo-org/example-app',
          state: { presentation: 'active', nativeLabel: 'Open' }, facts: [],
          reviewRevision: { headSha: OBSERVED_HEAD, baseSha: 'a'.repeat(40), nativeRevision: OBSERVED_HEAD } },
        viewer: { involvement: [] } }, linkedSessions: [] });
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({ identity: { instanceId: 'preview-overview', mountNonce: 'preview-overview-mount' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' }, surface: renderSurface, launchInput: input,
        surfaceContext: createSurfaceContextFixture({ accountScope: { serverId: 'srv_preview', accountId: 'preview-owner' } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async ({ action, input: request, signal }) => {
          if (typeof action === 'string' || request === undefined) throw new Error('Expected registered GitHub Action');
          return plugin.invokeAction(action.localId, request, { surface: 'ui', signal });
        } },
      });
    });
    mounted.push(detail);
    await expect(detail.getByText('Preview')).resolves.toBeDefined();
    await expect(detail.getByText('https://pr-1284.example.test/app')).resolves.toBeDefined();
    expect(transport.requests.filter(request => request.method === 'POST' && new URL(request.url).pathname !== '/graphql')).toHaveLength(1);
  });
});
