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

async function mount(header: Pick<TriageDetailHeaderV1, 'pullRequestFacts' | 'attention'>) {
  const fixture = await createPluginUiTestkit({
    identity: {
      instanceId: 'fixture-instance-facts',
      mountNonce: 'fixture-mount-facts',
    },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(function Facts() {
      return <TriageDetailHeaderFacts header={header} narrow />;
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
  mounted.push(fixture);
  return fixture;
}

const UNKNOWN = { branch: null, checks: { kind: 'unknown' }, review: { kind: 'unknown' }, merge: { kind: 'unknown' } } as const;

describe('the detail header cells', () => {
  it('holds the three cells, quiet, before the status read lands', async () => {
    const view = await mount({ pullRequestFacts: UNKNOWN, attention: null });
    for (const label of ['Status', 'Checks', 'Reviewers']) await expect(view.getByText(label)).resolves.toBeDefined();
  });

  it('names the failing check under its count, and keeps whole reviewer names rather than cutting a verb', async () => {
    const view = await mount({
      pullRequestFacts: { branch: { head: 'fix', base: 'main' }, merge: { kind: 'blocked', why: 'checks' },
        checks: { kind: 'failing', count: 1, first: 'typecheck', more: 0 },
        review: { kind: 'approved', people: ['coderabbitai', 'happier-bot', 'greptile-apps'] } },
      attention: null,
    });
    await expect(view.getByText('1 failing')).resolves.toBeDefined();
    await expect(view.getByText('typecheck')).resolves.toBeDefined();
    await expect(view.getByText('coderabbitai +2')).resolves.toBeDefined();
  });

  it('says the reader\'s own requested review as "you"', async () => {
    const view = await mount({
      pullRequestFacts: { ...UNKNOWN, review: { kind: 'reviewRequired', people: ['leeroybrun'] } },
      attention: { level: 'required', reasonLabel: 'Review requested', icon: 'review', danger: false, reviewRequested: true },
    });
    await expect(view.getByText('Waiting on you')).resolves.toBeDefined();
  });

  it('draws nothing for an entry with no change request (an issue, an error group)', async () => {
    const view = await mount({ pullRequestFacts: null, attention: null });
    await expect(view.queryByText('Status')).resolves.toBeUndefined();
  });
});
