// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageListFailureStatus } from './sourceFailure.js';

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('source failure presentation', () => {
  it('reveals each typed refusal on demand without exposing codes in the readable warning', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'source-warning', mountNonce: 'source-warning-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageListFailureStatus action={null} failure={{ kind: 'sources', sources: [
        { sourceInstanceId: 'native', displayName: 'Native GitHub', reason: 'Could not be reached just now.',
          code: 'plugin_activation_failed', retryable: false },
        { sourceInstanceId: 'stored', displayName: 'Stored GitHub', reason: 'Needs you to sign in again.',
          code: 'github_credential_mismatch' },
      ] }} />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    mounted.push(fixture);
    const diagnostic = 'Native GitHub — plugin_activation_failed · retryable=false Stored GitHub — github_credential_mismatch';
    await expect(fixture.queryByText(diagnostic)).resolves.toBeUndefined();
    await act(async () => {
      await fixture.press(await fixture.findByRole('button', { name: 'Details' }));
    });
    await expect(fixture.getByText(diagnostic)).resolves.toBeDefined();
  });
});
