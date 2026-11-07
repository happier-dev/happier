// @vitest-environment jsdom
import * as React from 'react';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createPluginUiRnwSemanticSurfaceAdapter } from '../testing/index.js';
import { defineUiSurface } from '../surfaceEntry.js';
import {
  AgentActionButton,
  type AgentActionLaunchMode,
} from './AgentActionButton.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(element: () => React.ReactElement) {
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'agent-action-button', mountNonce: 'one' },
    authorPlugin: { id: 'happier.test', version: '0.0.0' },
    surface: defineUiSurface(element),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  });
  mounted.push(fixture);
  return fixture;
}

describe('AgentActionButton (owner ruling 2026-11-07 "Agent actions: one shared flow")', () => {
  it.each(['start', 'review'] as const)(
    "runs the main press in the action's own launch mode (%s)",
    async (launchMode) => {
      const launches: AgentActionLaunchMode[] = [];
      const fixture = await mount(() => (
        <AgentActionButton
          title="Fix with Claude"
          launchMode={launchMode}
          onLaunch={(mode) => {
            launches.push(mode);
          }}
        />
      ));
      await fixture.press(
        await fixture.getByRole('button', { name: 'Fix with Claude' }),
      );
      expect(launches).toEqual([launchMode]);
    },
  );

  it('offers the other launch, and editing the action, on its chevron', async () => {
    const launches: AgentActionLaunchMode[] = [];
    let edits = 0;
    const fixture = await mount(() => (
      <AgentActionButton
        title="Fix"
        launchMode="start"
        onLaunch={(mode) => {
          launches.push(mode);
        }}
        onEdit={() => {
          edits += 1;
        }}
      />
    ));
    await fixture.press(
      await fixture.getByRole('button', { name: 'Fix options' }),
    );
    await fixture.press(
      await fixture.getByRole('menuitem', { name: 'Add instructions…' }),
    );
    await fixture.press(
      await fixture.getByRole('button', { name: 'Fix options' }),
    );
    await fixture.press(
      await fixture.getByRole('menuitem', { name: 'Start now' }),
    );
    await fixture.press(
      await fixture.getByRole('button', { name: 'Fix options' }),
    );
    await fixture.press(
      await fixture.getByRole('menuitem', { name: 'Edit action…' }),
    );
    expect(launches).toEqual(['review', 'start']);
    expect(edits).toBe(1);
  });

  it("lists the caller's other destinations after the launch choices and hands their ids back", async () => {
    const selected: string[] = [];
    const fixture = await mount(() => (
      <AgentActionButton
        title="Fix"
        launchMode="review"
        onLaunch={() => undefined}
        groups={[
          {
            id: 'recent',
            accessibilityLabel: 'Send to a Session',
            items: [{ id: 'session-a', label: 'Investigate sign in' }],
          },
        ]}
        onSelectDestination={(id) => {
          selected.push(id);
        }}
      />
    ));
    await fixture.press(
      await fixture.getByRole('button', { name: 'Fix options' }),
    );
    await expect(
      fixture.queryByRole('menuitem', { name: 'Edit action…' }),
    ).resolves.toBeUndefined();
    await fixture.press(
      await fixture.getByRole('menuitem', { name: 'Investigate sign in' }),
    );
    expect(selected).toEqual(['session-a']);
  });
});
