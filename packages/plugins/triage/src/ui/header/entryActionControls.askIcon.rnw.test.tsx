// @vitest-environment jsdom
import * as React from 'react';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../../settings/actions.js';
import { TriageEntryActionControls } from './entryActionControls.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountBand(compact: boolean): Promise<PluginUiTestkit> {
  const fixture = await createPluginUiTestkit({
    identity: {
      instanceId: `ask-icon-${compact}`,
      mountNonce: `ask-icon-${compact}`,
    },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: '56', kindId: 'issue' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor={false}
        reviewPreparation="ready"
        onAction={() => null}
        compact={compact}
      />
    )),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  });
  mounted.push(fixture);
  return fixture;
}

describe('Ask beside the primary', () => {
  // Owner ruling 2026-11-11 (lab merged-detail-pr phone: the primary and one chat icon): in the pinned phone band Ask
  // is the chat-bubble icon named "Ask", so the primary keeps its whole label at 360 and 390.
  it('is the named chat icon in the pinned phone band, leaving the primary its words', async () => {
    const fixture = await mountBand(true);
    const ask = await fixture.getByRole('button', { name: 'Ask' });
    expect(ask).toBeDefined();
    await expect(fixture.queryByText('Ask')).resolves.toBeUndefined();
  });

  it('keeps its word where the band has room', async () => {
    const fixture = await mountBand(false);
    await expect(fixture.getByText('Ask')).resolves.toBeDefined();
  });
});
