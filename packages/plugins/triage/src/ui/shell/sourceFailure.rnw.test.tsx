// @vitest-environment jsdom
import * as React from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '@happier-dev/plugin-ui';

import { TriageListFailureStatus, TriageOutsideSourcesNotice } from './sourceFailure.js';
import { readTriageListFailureNotice, readTriageSourceFailureRowV1 } from './windowState.js';

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
    const fixture = await mount(<TriageListFailureStatus failure={FAILURE}
      retry={<Button title="Try again" onPress={() => {}} />} manageSources={<Button title="Manage sources" onPress={() => {}} />} />);
    await expect(fixture.findByRole('button', { name: 'Manage sources' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
    await expect(fixture.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
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
