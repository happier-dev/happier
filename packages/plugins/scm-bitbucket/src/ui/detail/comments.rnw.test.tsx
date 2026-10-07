// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { afterEach, expect, it } from 'vitest';
import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/source/detailContracts.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let detail: PluginUiTestkit | undefined;
afterEach(async () => { await detail?.dispose(); });

it('expands only returned replies locally while the independent collection pager preserves provider order', async () => {
  let reads = 0;
  const readInputs: (JsonValue | undefined)[] = [];
  const row = (id: string, parentId?: string) => ({ id, body: `Body ${id}`, deleted: false, resolution: 'unknown', ...(parentId ? { parentId } : {}) });
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'comments-instance', mountNonce: 'comments-mount' },
      authorPlugin: { id: BITBUCKET_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: createTriageSourceV1Fixture().detailInput as unknown as JsonValue,
      handlers: { executeAction: async ({ action, input }) => {
        if ((action as Readonly<{ localId?: string }>).localId !== BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments) return { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
        reads += 1;
        readInputs.push(input);
        return { kind: 'comments', rows: reads === 1
          ? [row('root'), row('first', 'root'), row('other'), row('second', 'root'), row('nested', 'second'), row('orphan', 'missing'), row('orphan-two', 'missing')]
          : [row('third', 'root'), row('missing')], omittedRowCount: 0, projectionTruncated: false,
          ...(reads === 1 ? { continuation: 'opaque-provider-next' } : {}) };
      } },
    });
  });
  if (!detail) throw new Error('not mounted');
  await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
  await expect(detail.getByText('Body first')).resolves.toBeDefined();
  await expect(detail.queryByText('Body second')).resolves.toBeUndefined();
  await expect(detail.queryByText('Body nested')).resolves.toBeUndefined();
  await expect(detail.getByText('Body orphan')).resolves.toBeDefined();
  await expect(detail.getByText('Reply to comment root')).resolves.toBeDefined();
  await detail.press(await detail.getByRole('button', { name: 'Show returned replies' }));
  await expect(detail.getByText('Body second')).resolves.toBeDefined();
  await expect(detail.getByText('Body nested')).resolves.toBeDefined();
  expect(reads).toBe(1);
  await detail.press(await detail.getByRole('button', { name: 'Show 30 more comments' }));
  await expect(detail.getByText('Body third')).resolves.toBeDefined();
  await expect(detail.getByText('Body orphan-two')).resolves.toBeDefined();
  // Undated remarks keep the provider's order in the one Activity stream.
  const bodies = [...(document.body.textContent ?? '').matchAll(/Body ([a-z]+(?:-two)?)/gu)].map((match) => match[1]);
  expect(bodies.filter((body, index) => bodies.indexOf(body) === index))
    .toEqual(['root', 'first', 'other', 'second', 'nested', 'orphan', 'orphan-two', 'third', 'missing']);
  expect(reads).toBe(2);
  expect(readInputs[1]).toMatchObject({ continuation: 'opaque-provider-next' });
});
