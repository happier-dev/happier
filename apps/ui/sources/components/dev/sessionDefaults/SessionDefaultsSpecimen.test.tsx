import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const { SessionDefaultsSpecimen } = await import('./SessionDefaultsSpecimen');
const { t } = await import('@/text');
afterEach(standardCleanup);

const SPECIMEN = 'session-defaults-specimen';

describe('Session defaults loading shape', () => {
  it("holds the editor's own rows while the read is in flight, not a run of generic page rows", async () => {
    const screen = await renderScreen(
      <SessionDefaultsSpecimen state="loading" scope="me" />,
    );
    await flushHookEffects({ cycles: 3 });
    // The rows every loaded editor shows, under the same names, so they stay put when their values land.
    for (const row of ['machine', 'agent', 'approvalProfile']) {
      expect(
        screen.findByTestId(`${SPECIMEN}.loading-${row}`),
        row,
      ).not.toBeNull();
    }
    // The default Agent's open group (its choices under it), then the next Agent row (lab L11).
    expect(
      screen.findByTestId(`${SPECIMEN}.loading-pending-agent:lead:permission`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${SPECIMEN}.loading-pending-agent:lead:model`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${SPECIMEN}.loading-pending-agent:next`),
    ).not.toBeNull();
    // For me is editable once read, so the unset Agents' row is held too.
    expect(screen.findByTestId(`${SPECIMEN}.loading-otherAgents`)).not.toBeNull();
    const text = screen.getTextContent();
    for (const title of [
      t('teams.settings.memberDefaults.machine'),
      t('projects.sessionDefaults.agent'),
      t('teams.settings.memberDefaults.approvalProfile'),
      t('teams.settings.memberDefaults.permissionMode'),
      t('teams.settings.memberDefaults.model'),
    ])
      expect(text).toContain(title);
    expect(screen.findByTestId(`${SPECIMEN}.loading-skeleton:0`)).toBeNull();
    await screen.unmount();
  });

  it('gives way to the loaded editor with the same leading rows', async () => {
    const screen = await renderScreen(
      <SessionDefaultsSpecimen state="populated" scope="me" />,
    );
    await flushHookEffects({ cycles: 3 });
    for (const row of ['machine', 'agent', 'approvalProfile']) {
      expect(
        screen.findByTestId(`${SPECIMEN}.editor-${row}`),
        row,
      ).not.toBeNull();
    }
    expect(screen.findByTestId(`${SPECIMEN}.loading-machine`)).toBeNull();
    await screen.unmount();
  });
});
