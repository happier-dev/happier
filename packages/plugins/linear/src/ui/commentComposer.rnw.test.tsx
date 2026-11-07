// @vitest-environment jsdom
import React, { act } from 'react';
import { defineUiSurface, Tabs } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createPluginTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type {
  PluginUiActionControlEventV1,
  PluginUiActionControlRequestV1,
  PluginUiPageNavigationV1,
  RenderContext,
} from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LINEAR_ACTIONS, LINEAR_PLUGIN_ID } from '../contracts.js';
import { host, instance, issue, localRef } from '../fixtures.test-support.js';
import { LINEAR_PLUGIN } from '../manifest.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { renderSurface } from './renderSurface.js';

/**
 * The Linear comment composer, composed below the host: the host control prepares from the draft,
 * the plugin's own comment writer runs it, and only Linear HTTP and the account are substituted.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const INPUT = TriageDetailSurfaceInputV1Schema.parse({
  v: 1,
  instance,
  panel: 'activity',
  observation: {
    entryRef: { source: instance.instance.source, ...localRef },
    observedAtMs: 1_760_000_700_000,
    locator: { v: 1, webUrl: issue.url, displayPath: 'ENG-123' },
    snapshot: {
      v: 1,
      title: issue.title,
      scopeLabel: 'Engineering',
      state: { presentation: 'active', nativeLabel: 'In Progress' },
      facts: [],
    },
    viewer: { involvement: [] },
  },
  linkedSessions: [],
});

type Bound = {
  publish(event: PluginUiActionControlEventV1): void;
  presentation: { title: string; disabled?: boolean };
};

const mounted: PluginUiTestkit[] = [];
const backends: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const backend of backends.splice(0)) await backend.dispose();
});

it('keeps Linear Comments mapped to Activity under the single outer page Tabs without reading sibling sections', async () => {
  const navigation: Array<PluginUiPageNavigationV1 | null> = [];
  const sections: string[] = [];
  const pageKind = { pluginId: 'happier.triage', localId: 'entry' };
  function Detail({ context }: { context: RenderContext }) {
    const [panel, setPanel] = React.useState('overview');
    const body = renderSurface({ ...context, launchInput: { ...INPUT, panel } as unknown as JsonValue });
    // The SDK element is opaque across its boundary; this RNW host requires a React element.
    if (body !== null && !React.isValidElement(body)) throw new Error('Expected a native Linear surface');
    return <Tabs presentation="page" pageKind={pageKind} value={panel} onValueChange={setPanel} ariaLabel="Entry"
      sharedPanel={body}>
      <Tabs.Item value="overview" title="Overview" />
      <Tabs.Item value="activity" title="Activity" />
    </Tabs>;
  }
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'linear-navigation', mountNonce: 'linear-navigation' },
      authorPlugin: { id: LINEAR_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface(context => <Detail context={context} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), launchInput: null,
      handlers: {
        setPageNavigation: ({ navigation: value }) => { navigation.push(value); },
        executeAction: async ({ input }) => {
          const { section } = input as { section: string };
          sections.push(section);
          return { kind: 'ready', entries: [{ id: section, title: section === 'comments' ? 'Linear conversation' : 'Linear description' }] };
        },
      },
    });
  });
  mounted.push(fixture);
  expect(sections).toEqual(['overview']);
  expect((await fixture.getAllByRole('tab')).map(tab => tab.name)).toEqual(['Overview', 'Activity']);
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ page: { columnVisible: true,
    navigation: { pageKind, presentation: 'bottom', tabIds: [], request: 'activity' },
  } })); });
  expect(sections).toEqual(['overview', 'comments']);
  await expect(fixture.getByText('Linear conversation')).resolves.toBeDefined();
  expect(await fixture.queryAllByRole('tab')).toHaveLength(0);
  expect(navigation.filter(value => value !== null).every(value => value.pageKind.pluginId === 'happier.triage')).toBe(true);
  expect(navigation.at(-1)).toMatchObject({ value: 'activity' });
});

async function mountComments(answer: Parameters<typeof host>[0]) {
  const provider = host(answer);
  const backend = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest,
    module: { activate: LINEAR_PLUGIN.activate, activateAccount }, services: provider.context.services });
  backends.push(backend);
  const controls = new Map<string, Bound>();
  const prepared: unknown[] = [];
  let detailReads = 0;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'linear-comments',
        mountNonce: 'linear-comments-mount',
      },
      authorPlugin: { id: LINEAR_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: INPUT as unknown as JsonValue,
      handlers: {
        executeAction: async ({ action }) => {
          expect(action).toEqual({
            pluginId: LINEAR_PLUGIN_ID,
            localId: LINEAR_ACTIONS.detail,
          });
          detailReads += 1;
          return {
            kind: 'ready',
            entries: [{ id: 'comment-0', title: 'Mara', body: 'Earlier note' }],
          };
        },
        async actionControl({
          request,
          publish,
        }: Readonly<{
          request: PluginUiActionControlRequestV1;
          publish(event: PluginUiActionControlEventV1): void;
        }>) {
          if (request.kind === 'bind') {
            expect(request.action).toEqual({
              pluginId: LINEAR_PLUGIN_ID,
              localId: LINEAR_ACTIONS.comment,
            });
            controls.set(request.subscriptionId, {
              publish,
              presentation: request.presentation,
            });
            return;
          }
          if (request.kind === 'update') {
            controls.get(request.subscriptionId)!.presentation =
              request.presentation;
            return;
          }
          prepared.push(request.preparation);
          if (request.preparation === null) return;
          // The host transport enters the real Account Action adapter and comment writer.
          const result = await backend.invokeAction(LINEAR_ACTIONS.comment, request.preparation.input ?? null);
          publish({
            kind: 'settled',
            requestId: request.requestId,
            execution: { ok: true, result: result as JsonValue },
          });
        },
      },
    });
  });
  mounted.push(fixture);
  const publishControl = () => [...controls.values()][0];
  return {
    fixture,
    provider,
    prepared,
    publishControl,
    reads: () => detailReads,
  };
}

async function typeComment(value: string): Promise<void> {
  const field = document.querySelector<HTMLTextAreaElement>('textarea');
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(
  control: Bound | undefined,
  requestId: string,
): Promise<void> {
  if (control === undefined) throw new Error('control not bound');
  await act(async () => {
    control.publish({ kind: 'prepare', requestId });
  });
}

describe('the Linear comment composer', () => {
  it('publishes the typed comment once through the comment Action, clears the draft and rereads the comments', async () => {
    const page = await mountComments(({ operationName }) => {
      if (operationName === 'LinearViewer')
        return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearComment')
        return {
          commentCreate: { success: true, comment: { id: 'comment-1' } },
        };
      if (operationName === 'LinearCommentRead')
        return {
          comment: {
            id: 'comment-1',
            body: 'Shipping the fix today',
            issue: { id: issue.id },
          },
        };
      return { issue };
    });
    await expect(page.fixture.getByText('Earlier note')).resolves.toBeDefined();
    await vi.waitFor(() =>
      expect(page.publishControl()?.presentation).toMatchObject({
        title: 'Publish comment',
        disabled: true,
      }),
    );

    await typeComment('Shipping the fix today');
    await vi.waitFor(() =>
      expect(page.publishControl()?.presentation.disabled).toBe(false),
    );
    await press(page.publishControl(), 'press-1');

    await expect(
      page.fixture.getByText('Comment published'),
    ).resolves.toBeDefined();
    expect(page.prepared).toEqual([
      { input: { v: 1, instance, localRef, body: 'Shipping the fix today' } },
    ]);
    const mutations = page.provider.request.mock.calls.filter(([request]) =>
      new TextDecoder().decode(request.body).includes('mutation LinearComment'),
    );
    expect(mutations).toHaveLength(1);
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '',
    );
    await vi.waitFor(() => expect(page.reads()).toBe(2));
  });

  it('keeps the draft and withholds publishing after an unconfirmed comment', async () => {
    let writes = 0;
    const page = await mountComments(({ operationName }) => {
      if (operationName === 'LinearViewer')
        return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearComment') {
        writes += 1;
        throw new Error('answer lost');
      }
      return { issue };
    });
    await expect(page.fixture.getByText('Earlier note')).resolves.toBeDefined();
    await typeComment('One comment');
    await vi.waitFor(() =>
      expect(page.publishControl()?.presentation.disabled).toBe(false),
    );
    await press(page.publishControl(), 'press-1');

    await expect(
      page.fixture.getByText('Linear may already have made this change.'),
    ).resolves.toBeDefined();
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'One comment',
    );
    await vi.waitFor(() =>
      expect(page.publishControl()?.presentation.disabled).toBe(true),
    );
    await press(page.publishControl(), 'press-2');
    expect(page.prepared.at(-1)).toBeNull();
    expect(writes).toBe(1);
  });
});
