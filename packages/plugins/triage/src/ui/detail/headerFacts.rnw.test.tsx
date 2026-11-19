// @vitest-environment jsdom
import * as React from 'react';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { TriageDetailHeaderV1 } from './header.js';
import { TriageDetailHeaderFacts } from './headerFacts.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(
  facts: Pick<TriageDetailHeaderV1, 'branches' | 'changeFacts'>,
) {
  const fixture = await createPluginUiTestkit({
    identity: {
      instanceId: 'fixture-instance-facts',
      mountNonce: 'fixture-mount-facts',
    },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(function Facts() {
      return <TriageDetailHeaderFacts header={facts} />;
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
  mounted.push(fixture);
  return fixture;
}

describe('the detail header facts row', () => {
  it('draws the head branch as its own fact, so a narrow pane shortens it and keeps the base and diff size', async () => {
    const view = await mount({
      branches: { head: 'leeroy/server-rounding', base: 'main' },
      changeFacts: {
        diff: { additions: 28, deletions: 3 },
        checks: { failingCount: 2, runningCount: 0, passingCount: 5 },
        reviewers: [{ verb: 'approved', names: ['Mika Tanaka'] }],
      },
    });
    await expect(
      view.getByText('leeroy/server-rounding'),
    ).resolves.toBeDefined();
  });

  it('draws nothing for an entry whose source states none of the facts (an issue, an error group)', async () => {
    const view = await mount({ branches: null, changeFacts: null });
    await expect(view.queryByText('main')).resolves.toBeUndefined();
  });
});
