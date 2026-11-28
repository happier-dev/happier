// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '@happier-dev/plugin-ui';

import { TriageListFailureStatus, TriageOutsideSourcesNotice } from './sourceFailure.js';
import { readTriageListFailureLine, readTriageListFailureNotice, readTriageSourceFailureRowV1 } from './windowState.js';
import { renderSurface as renderShellSurface } from '../surface.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1 } from './root.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from '../../actions/listEntriesProtocol.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 } from '../../actions/savedViewsProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../actions/userMarksProtocol.js';
import { createTriageMountedUiActionHandler } from '../../actions/mountedUi.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema } from '../../actions/mountedUiProtocol.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { refreshTriageListWindow } from '../window/mountedWindow.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

const FAILURE = { kind: 'sources', sources: [
  { sourceInstanceId: 'native', displayName: 'Native GitHub', reason: 'Could not be reached just now.',
    code: 'plugin_activation_failed', retryable: false, needsConnectionChange: true },
  { sourceInstanceId: 'stored', displayName: 'Stored GitHub', reason: 'Needs you to sign in again.',
    code: 'github_credential_mismatch', needsConnectionChange: true },
] } as const;

async function mount(node: React.ReactElement): Promise<PluginUiTestkit> {
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'source-warning', mountNonce: 'source-warning-mount' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => node),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
  mounted.push(fixture);
  return fixture;
}

describe('source failure presentation', () => {
  it('keeps the producer explanation in Details instead of exposing only its machine code', () => {
    const source = { sourceInstanceId: 'account-tasks', displayName: 'Tasks',
      reason: 'The account task content could not be read.', lineReason: 'Could not be reached just now.',
      code: 'accountDataUnavailable' };
    const result = readTriageSourceFailureRowV1(source);
    expect(result.details).toContain(source.reason);
    expect(result.details).toContain(source.code);
    expect(result.reason).toBe(source.lineReason);
    const notice = readTriageListFailureNotice({ kind: 'sources', sources: [source] });
    expect(notice.details).toContain(source.reason);
    expect(notice.details).toContain(source.code);
  });
  it('takes one line with one recovery press and no diagnostics row beside the rows', async () => {
    const fixture = await mount(<TriageListFailureStatus line={readTriageListFailureLine(FAILURE)}
      retry={<Button title="Try again" onPress={() => {}} />} manageSources={<Button title="Manage sources" onPress={() => {}} />} />);
    await expect(fixture.findByRole('button', { name: 'Manage sources' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
    await expect(fixture.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
  });

  it.each([false, true])('offers retry when a failed connection can be read again (also needs repair: %s)', async (mixed) => {
    const fixture = await mount(<TriageListFailureStatus line={readTriageListFailureLine({ kind: 'sources', sources: [
      ...(mixed ? FAILURE.sources : []),
      { sourceInstanceId: 'retryable', displayName: 'Retryable source', reason: 'Could not be reached just now.', retryable: true },
    ] })} retry={<Button title="Try again" onPress={() => {}} />}
      manageSources={<Button title="Manage sources" onPress={() => {}} />} />);
    await expect(fixture.getByRole('button', { name: 'Try again' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Manage sources' })).resolves.toBeUndefined();
  });

  it.each([0, 1, 2])('shows recovery with %i failed sources beside visible rows (zero exercises the empty list)', async failedWithRows => {
    const source = { pluginId: 'happier.example.source', localId: 'example-forge' };
    const entryRef = { source, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' };
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const healthyId = '22222222-2222-4222-8222-222222222222';
    const secondFailureId = '33333333-3333-4333-8333-333333333333';
    const assembledAtMs = 1_760_000_100_000;
    const failed = (id: string, displayLabel: string) => ({
      configured: { sourceInstanceId: id, configurationRowId: id, source, displayLabel, available: true },
      lane: { sourceInstanceId: id, source, exhausted: false,
        health: { kind: 'failed', failure: { class: 'authentication', code: 'sign_in_required' } } },
    });
    const failures = [failed(sourceInstanceId, 'Example account'),
      ...(failedWithRows === 2 ? [failed(secondFailureId, 'Second failing account')] : [])];
    const rowTitle = 'Keep this pull request visible';
    const result = TriageListEntriesResultV1Schema.parse({ v: 1, configuredSourcesStatus: 'complete',
      configuredSources: [...failures.map(({ configured }) => configured),
        ...(failedWithRows ? [{ sourceInstanceId: healthyId, configurationRowId: healthyId, source,
          displayLabel: 'Healthy account', available: true }] : [])],
      window: { v: 1, rows: failedWithRows ? [{
        entryRef, lane: '1-open', sortAtMs: assembledAtMs,
        presence: { kind: 'present', observedAtMs: assembledAtMs },
        selected: { kind: 'selected', sourceInstanceId: healthyId, reason: 'onlyPresent' },
        observation: { sourceInstanceId: healthyId, observedAtMs: assembledAtMs, outcome: {
          kind: 'present', locator: testkitLocator(), snapshot: testkitSnapshot({ title: rowTitle }), viewer: testkitViewer(),
        } },
        otherObservations: [], observedByCount: 1,
      }] : [], lanes: [...failures.map(({ lane }) => lane),
        ...(failedWithRows ? [{ sourceInstanceId: healthyId, source, exhausted: true,
          health: { kind: 'walkFinished' } }] : [])], coverage: 'partial', assembledAtMs },
    });
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'source-auth-recovery', mountNonce: 'source-auth-recovery' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: renderShellSurface,
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: 'happier.triage', localId: 'triage' }, container: 'appPage' } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
        handlers: { executeAction: async ({ action, input, signal }) => {
          // The host transport returns this addressed Action to the real mounted dispatcher.
          if (action === TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1) {
            return await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(input), {
              plugin: { id: 'happier.triage', version: '0.0.0' },
              contribution: { id: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1,
                qualifiedId: `happier.triage/actions/${TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1}` },
              invocationSurface: 'ui', signal: signal ?? new AbortController().signal,
              ui: fixture.context.hostApi, ephemeralSharedScope,
            }) as unknown as JsonValue;
          }
          if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) return result as unknown as JsonValue;
          if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
          if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) return { v: 1, availability: 'absent', views: [], revision: 'revision-1' };
          throw new Error(`Unexpected action ${action}`);
        }, replacePageLocation: ({ subPath }) => subPath },
      });
    });
    mounted.push(fixture);
    await act(async () => { await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope); });
    if (failedWithRows) {
      await expect(fixture.getByRole('button', { name: rowTitle })).resolves.toBeDefined();
      const stage = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}:stage"]`)!;
      const label = failedWithRows === 1 ? /Example account could not be read/ : /2 sources need attention/;
      const notices = [...document.querySelectorAll('[role="status"]')].filter(node => label.test(node.textContent ?? ''));
      expect(notices).toHaveLength(1);
      const refresh = document.querySelector('[aria-label="Refresh"]');
      expect(refresh).not.toBeNull();
      expect(refresh?.parentElement?.contains(notices[0]!)).toBe(true);
      expect(stage.contains(notices[0]!)).toBe(false);
    }
    const manage = await fixture.getByRole('button', { name: 'Manage sources' });
    await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
    await act(async () => { await fixture.press(manage); });
    await expect(fixture.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
  });

  it('says sources outside the view in one line whose Review opens the source health surface (VIEW-HEALTH)', async () => {
    const opened: string[] = [];
    const fixture = await mount(<TriageOutsideSourcesNotice attention={{ count: 6, target: 'manageSources' }}
      onReview={(target) => { opened.push(target); }} />);
    await expect(fixture.getByText('6 other sources need attention')).resolves.toBeDefined();
    await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
    expect(opened).toEqual(['manageSources']);
    const one = await mount(<TriageOutsideSourcesNotice attention={{ count: 1, target: 'manageSources' }} onReview={() => {}} />);
    await expect(one.getByText('1 other source needs attention')).resolves.toBeDefined();
  });

  it('steps aside while Manage sources is open, where each source already says its own state', async () => {
    const fixture = await mount(<TriageOutsideSourcesNotice attention={{ count: 4, target: 'manageSources' }} managing onReview={() => {}} />);
    await expect(fixture.queryByText('4 other sources need attention')).resolves.toBeUndefined();
    await expect(fixture.queryByRole('button', { name: 'Review' })).resolves.toBeUndefined();
  });

  it('gives each connection its own reason, fix and on-demand cause for its Manage sources row', () => {
    const [native, stored] = FAILURE.sources.map((source) => readTriageSourceFailureRowV1(source));
    expect(native).toMatchObject({ fix: 'connection', details: 'For support: plugin_activation_failed' });
    expect(stored).toMatchObject({ fix: 'connection', details: 'For support: github_credential_mismatch' });
  });
});
