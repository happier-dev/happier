// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageDetailWholeBody } from './sessionPanel.js';

/**
 * The Triage entry's live Session (plan 05 §4.6). The host's real Session view is app composition,
 * so the semantic testkit's session stand-ins are the boundary: a group named "Session <id>" is
 * exactly the Session the host was asked to present.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINKED: readonly TriageLinkedSessionProjectionV1[] = Object.freeze([
  { sessionId: 'session-linked', displayTitle: 'Route repair' },
  { sessionId: 'session-other', displayTitle: 'Parser cleanup' },
]);

const calls: Array<Readonly<{ action: string; input: unknown }>> = [];
const mounted: PluginUiTestkit[] = [];
let openFails = false;

/** The host's canonical Session projection; `agent` is present only when the host admits it. */
function liveState(sessionId: string, agent?: SessionStateV1['agent']): SessionStateV1 {
  return {
    sessionId,
    lifecycle: 'active',
    runtime: 'waiting',
    operational: 'ready',
    workStatus: { bucket: 'idle', tone: 'neutral', word: 'Ready' },
    pendingPermissions: [],
    ...(agent === undefined ? {} : { agent }),
  } as SessionStateV1;
}

async function mountBody(
  sessions: readonly TriageLinkedSessionProjectionV1[],
  readSession?: (sessionId: string) => SessionStateV1,
) {
  calls.length = 0;
  openFails = false;
  const surface = defineUiSurface(function EntryBody(_context: RenderContext): React.ReactElement {
    return (
      <TriageDetailWholeBody sessions={sessions}>
        <Text value="The source's own detail" />
      </TriageDetailWholeBody>
    );
  });
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'fixture-instance-session', mountNonce: 'fixture-mount-session' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ sessions: true, overlays: true }),
    handlers: {
      executeAction: async ({ action, input }) => {
        calls.push({ action: String(action), input });
        if (openFails) throw new Error('open failed');
        return {};
      },
      ...(readSession === undefined ? {} : { readSession: ({ sessionId }: { sessionId: string }) => readSession(sessionId) }),
    },
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('Triage entry Session tab', () => {
  it('shows an inline Open failure and lets the user retry the same Session', async () => {
    const body = await mountBody(LINKED);
    await act(async () => { await body.press(await body.getByRole('tab', { name: 'Session' })); });
    openFails = true;
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Open session' })); });
    await expect(body.getByText('This Session could not be opened.')).resolves.toBeDefined();
    openFails = false;
    await act(async () => { await body.press(await body.getByRole('button', { name: 'Open session' })); });
    await expect(body.queryByText('This Session could not be opened.')).resolves.toBeUndefined();
    expect(calls).toEqual([
      { action: 'session.open', input: { sessionId: 'session-linked' } },
      { action: 'session.open', input: { sessionId: 'session-linked' } },
    ]);
  });
  it('presents the first linked Session live, follows the selection and still opens it in full', async () => {
    const body = await mountBody(LINKED);
    await expect(body.getByText("The source's own detail")).resolves.toBeDefined();

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Session' }));
    });
    await expect(body.getByRole('group', { name: 'Session session-linked' })).resolves.toBeDefined();

    await act(async () => {
      await body.press(await body.getByRole('button', { name: 'Linked session: Route repair' }));
    });
    await act(async () => {
      await body.press(await body.getByRole('menuitemradio', { name: 'Parser cleanup' }));
    });
    await expect(body.getByRole('group', { name: 'Session session-other' })).resolves.toBeDefined();
    await expect(body.queryByRole('group', { name: 'Session session-linked' })).resolves.toBeUndefined();

    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Details' }));
    });
    await expect(body.queryByRole('group', { name: 'Session session-other' })).resolves.toBeUndefined();
    await act(async () => {
      await body.press(await body.getByRole('tab', { name: 'Session' }));
    });
    // Tab changes preserve the linked-session selection and its controller.
    await expect(body.getByRole('group', { name: 'Session session-other' })).resolves.toBeDefined();

    await act(async () => {
      await body.press(await body.getByRole('button', { name: 'Open session' }));
    });
    expect(calls).toEqual([{ action: 'session.open', input: { sessionId: 'session-other' } }]);
  });

  it('marks the toolbar title with the linked Agent only when the host admits that identity', async () => {
    // The testkit host carries no brand bytes or names, so a BrandMark draws its neutral monogram
    // ("P" for the unnamed plugin): its presence is the mark's presence.
    const single = [LINKED[0]!];
    const anonymous = await mountBody(single, (sessionId) => liveState(sessionId));
    await act(async () => { await anonymous.press(await anonymous.getByRole('tab', { name: 'Session' })); });
    await expect(anonymous.getByText('Route repair')).resolves.toBeDefined();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    await expect(anonymous.queryByText('P')).resolves.toBeUndefined();

    const admitted = await mountBody(single, (sessionId) => liveState(sessionId, {
      agentId: 'codex', displayName: 'Codex', brand: { pluginId: 'happier.agent.codex' },
    } as SessionStateV1['agent']));
    await act(async () => { await admitted.press(await admitted.getByRole('tab', { name: 'Session' })); });
    await expect(admitted.getByText('Route repair')).resolves.toBeDefined();
    await expect.poll(async () => (await admitted.queryByText('P')) !== undefined).toBe(true);
  });

  it('keeps the source detail exactly as it was when the entry has no linked Session', async () => {
    const body = await mountBody([]);
    await expect(body.getByText("The source's own detail")).resolves.toBeDefined();
    await expect(body.queryByRole('tab', { name: 'Session' })).resolves.toBeUndefined();
    await expect(body.queryByRole('tab', { name: 'Details' })).resolves.toBeUndefined();
  });
});
