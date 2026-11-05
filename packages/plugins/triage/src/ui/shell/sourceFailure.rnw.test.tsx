// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '@happier-dev/plugin-ui';

import { TriageListFailureDetails, TriageListFailureStatus } from './sourceFailure.js';

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
  it('takes one line with one recovery press and no diagnostics row beside the rows', async () => {
    const fixture = await mount(<TriageListFailureStatus failure={FAILURE}
      retry={<Button title="Try again" onPress={() => {}} />} manageSources={<Button title="Manage sources" onPress={() => {}} />} />);
    await expect(fixture.findByRole('button', { name: 'Manage sources' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
    await expect(fixture.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
  });

  it('keeps each typed refusal on demand where the reader goes to fix it', async () => {
    const fixture = await mount(<TriageListFailureDetails failure={FAILURE} />);
    const diagnostic = 'Native GitHub — plugin_activation_failed · retryable=false Stored GitHub — github_credential_mismatch';
    await expect(fixture.queryByText(diagnostic)).resolves.toBeUndefined();
    await act(async () => {
      await fixture.press(await fixture.findByRole('button', { name: 'Details' }));
    });
    await expect(fixture.getByText(diagnostic)).resolves.toBeDefined();
  });
});
