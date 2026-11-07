// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../actions/actionIds.js';
import { renderSurface } from './renderForgeSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

describe('GitHub run resource destinations', () => {
  it('keeps an explicit GitHub link when the native run read is unavailable', async () => {
    const url = 'https://github.com/other/repository/actions/runs/732';
    const opened: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'unavailable-resource', mountNonce: 'unavailable-resource' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const result = renderSurface(context);
          if (result !== null && !React.isValidElement(result)) throw new Error('Expected a native resource view');
          return result;
        }),
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-resource-run' }, container: 'appPage' }, target: { kind: 'app' } }),
        launchInput: { resource: { kind: 'ciRun', url } },
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { watchResource: async () => ({}), replacePageLocation: async ({ subPath }) => subPath,
          openExternalLink: async ({ url: value }) => { opened.push(value); },
          executeAction: async () => ({ kind: 'unavailable', failure: { class: 'permission', code: 'repository_inaccessible' } }),
        },
      });
    });
    mounted.push(fixture);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'On GitHub' })); });
    expect(opened).toEqual([url]);
  });

  it('settles an invalid run resource without provider reads', async () => {
    const calls: unknown[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'invalid-resource', mountNonce: 'invalid-resource' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const result = renderSurface(context);
          if (result !== null && !React.isValidElement(result)) throw new Error('Expected a native resource view');
          return result;
        }),
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-resource-run' }, container: 'appPage' }, target: { kind: 'app' } }),
        launchInput: { resource: { kind: 'ciRun', url: 'https://example.com/owner/repo/actions/runs/732' } },
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: async request => { calls.push(request); return null; } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText('This run link couldn’t be opened');
    expect(calls).toEqual([]);
  });

  it.each([
    { container: 'appPage', restored: false },
    { container: 'detailsTab', restored: false },
    { container: 'appPage', restored: true },
    { container: 'detailsTab', restored: true },
  ] as const)('loads the URL run and its job log through the existing CI binding in $container (restored: $restored)', async ({ container, restored }) => {
    const native = createForgeCiConformanceVectorsV1().github;
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'other/repository' } as const;
    const ref = { ...native.run.ref, repository, runId: '732' };
    const selection = { kind: 'run', run: ref } as const;
    const run = { ...native.run, ref, title: 'Workflow from a resource URL',
      currentAttempt: { run: ref, attemptId: '1', number: 1 }, attemptCount: 1 };
    const job = { ...native.job, ref: { ...native.job.ref, selection } };
    const calls: { id: string; input: unknown }[] = [];
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const locations: string[] = [];
    const url = 'https://github.com/Other/Repository/actions/runs/732';
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: `resource-${container}`, mountNonce: `resource-${container}` },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const result = renderSurface(context);
          if (result !== null && !React.isValidElement(result)) throw new Error('Expected a native resource view');
          return result;
        }),
        surfaceContext: createSurfaceContextFixture({ mountId: `resource-${container}-${restored}`, mount: { kind: 'destination',
          destination: { pluginId: GITHUB_PLUGIN_ID, localId: container === 'appPage' ? 'github-resource-run' : 'github-resource-run-session' }, container,
          ...(container === 'detailsTab' && restored ? { instanceKey: url } : {}) },
          target: container === 'appPage' ? { kind: 'app' }
            : { kind: 'session', sessionId: 'session', repository: native.run.ref.repository } }),
        ...(restored ? container === 'appPage' ? { subPath: `run/${encodeURIComponent(url)}` } : {} : { launchInput: { resource: { kind: 'ciRun', url } } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        // The host Action transport is the boundary; renderer, binding, reads and native CI views stay real.
        handlers: { setPageNavigation: ({ navigation: value }) => { navigation.push(value); },
          watchResource: async () => ({}), replacePageLocation: async ({ subPath }) => { locations.push(subPath); return subPath; }, executeAction: async ({ action, input }) => {
          if (action === 'shell.column.set') {
            const descriptor = navigation.at(-1);
            if (!descriptor) throw new Error('Expected the published page navigation');
            await fixture.updateSurface(createSurfaceContextFixture({ ...fixture.context.surface,
              page: { columnVisible: true, navigation: { pageKind: descriptor.pageKind,
                presentation: 'top', tabIds: descriptor.items.map(item => item.value), request: (input as { tab: string }).tab } },
            }));
            return null;
          }
          if (typeof action !== 'object') throw new Error('Expected a qualified CI Action');
          calls.push({ id: action.localId, input });
          const value = action.localId === GITHUB_CI_ACTION_IDS_V1.readRun ? run
            : action.localId === GITHUB_CI_ACTION_IDS_V1.readJob ? job
              : action.localId === GITHUB_CI_ACTION_IDS_V1.readJobLog
                ? { kind: 'available', job: job.ref, logId: 'resource-log', text: 'Resource URL job log', startLine: 1, startByte: 0, complete: true, continuation: null }
                : { rows: action.localId === GITHUB_CI_ACTION_IDS_V1.listJobs ? [job] : [],
                  omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
          return projectNativeJsonValueForTransport({ kind: 'value', value });
        } },
      });
    });
    mounted.push(fixture);
    await fixture.getByText(run.title);
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readRun)).toEqual([
      { id: GITHUB_CI_ACTION_IDS_V1.readRun, input: { repository, runId: '732' } },
    ]);
    expect(calls.some(call => call.id === GITHUB_CI_ACTION_IDS_V1.listRuns)).toBe(false);
    expect(locations).toEqual(container === 'appPage' && !restored ? [`run/${encodeURIComponent(url)}`] : []);
    if (container === 'appPage') expect(navigation.at(-1)).toMatchObject({
      pageKind: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-resource-run/run' }, value: 'summary',
    });
    else expect(navigation).toEqual([]);
    const tab = (await fixture.queryAllByRole('tab')).find(value => value.name?.startsWith('Jobs'));
    if (!tab) throw new Error('Expected the native Jobs tab');
    await act(async () => { await fixture.press(tab); });
    const buttons = await fixture.queryAllByRole('button');
    const jobButton = buttons.find(value => value.name?.includes(job.name));
    if (!jobButton) throw new Error(`Expected the native job row; buttons: ${buttons.map(value => value.name).join(', ')}`);
    await act(async () => { await fixture.press(jobButton); });
    await fixture.getByRole('button', { name: 'Copy log' });
    if (container === 'appPage') expect(navigation.at(-1)).toMatchObject({ value: 'jobs' });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.readJobLog)).toHaveLength(1);
  });
});
