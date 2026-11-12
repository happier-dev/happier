// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface } from './surface.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1 } from '../actions/resolveResourceProtocol.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

it.each(['session', 'app'] as const)('restores the exact %s resource without ephemeral launch input', async kind => {
  const resource = { kind: 'issue' as const, url: 'https://github.com/octo/repo/issues/19#comment-3' };
  const opened: string[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: `restored-${kind}`, mountNonce: 'resource-restore' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: context => renderSurface({ ...context, ...(kind === 'session'
        ? { surface: { ...context.surface, mount: { kind: 'destination', destination: { pluginId: 'happier.triage', localId: 'resource-details' }, container: 'detailsTab', instanceKey: resource.url } } }
        : { subPath: `resource/${encodeURIComponent(JSON.stringify(resource))}` }) }),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { openExternalLink: ({ url }) => { opened.push(url); } },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Open on GitHub' })); });
  expect(opened).toEqual([resource.url]);
});

it('settles an unavailable resource and offers its exact external URL', async () => {
  const url = 'https://github.com/octo/repo/pull/17?tab=checks#issuecomment-3';
  const opened: string[] = [];
  const locations: string[] = [];
  const resolutions: unknown[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'resource', mountNonce: 'resource-1' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.triage', localId: 'triage' }, container: 'appPage' }, target: { kind: 'app' } }), launchInput: { resource: { kind: 'pullRequest', url } },
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        executeAction: ({ action, input }) => {
          expect(action).toBe(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1);
          resolutions.push(input);
          return { kind: 'unavailable' };
        },
        replacePageLocation: ({ subPath }) => { locations.push(subPath); return subPath; },
        openExternalLink: ({ url }) => { opened.push(url); },
      },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Open on GitHub' })); });
  expect(opened).toEqual([url]);
  expect(resolutions).toEqual([{ v: 1, resource: { kind: 'pullRequest', url } }]);
  expect(locations).toEqual([`resource/${encodeURIComponent(JSON.stringify({ kind: 'pullRequest', url }))}`]);
});
