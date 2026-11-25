import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const { SessionDefaultsSpecimen } = await import('./SessionDefaultsSpecimen');
const { t } = await import('@/text');
const { ProjectSessionDefaultsView } = await import('@/components/projects/sessionDefaults/ProjectSessionDefaultsBody');
const { ProjectSessionDefaultsGetOutputV1Schema } = await import('@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1');
const CODEX = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
afterEach(standardCleanup);

const SPECIMEN = 'session-defaults-specimen';
/** The row's description line, as the list row receives it. */
const subtitleOf = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) =>
  screen.findAllByTestId(testID).find((node) => node.props.subtitle !== undefined)?.props.subtitle;

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
    // Only the rows every loaded editor shows are held, closing with "Other agents" (its mark keeps the section's
    // leading column); which Agents lead and their service rows come from the read and join below the held fields.
    expect(screen.findByTestId(`${SPECIMEN}.loading-otherAgents`)).not.toBeNull();
    for (const speculative of ['pending-agent:lead', 'pending-agent:lead:permission', 'pending-agent:next']) {
      expect(screen.findByTestId(`${SPECIMEN}.loading-${speculative}`), speculative).toBeNull();
    }
    const text = screen.getTextContent();
    for (const title of [
      t('teams.settings.memberDefaults.machine'),
      t('projects.sessionDefaults.agent'),
      t('teams.settings.memberDefaults.approvalProfile'),
    ])
      expect(text).toContain(title);
    expect(screen.findByTestId(`${SPECIMEN}.loading-skeleton:0`)).toBeNull();
    await screen.unmount();
  });

  it("keeps the Agent row's description line in the hold and in every loaded case, so Approval never moves", async () => {
    // The held Agent row reserves its description line, like Machine and Approval (TS-UI-ACCEPT-FINAL-2-1125 item 1:
    // an inherited Agent's source line arrived later and pushed Approval down 17 px).
    const held = await renderScreen(<SessionDefaultsSpecimen state="loading" scope="me" />);
    await flushHookEffects({ cycles: 3 });
    expect(subtitleOf(held, `${SPECIMEN}.loading-agent`)).toBeTruthy();
    await held.unmount();

    // Loaded, the line is always there: the inherited Agent's source (the specimen's Team default), else the resting
    // description, whether nothing is set or an Agent is chosen here.
    const inherited = await renderScreen(<SessionDefaultsSpecimen state="populated" scope="me" />);
    await flushHookEffects({ cycles: 3 });
    expect(subtitleOf(inherited, `${SPECIMEN}.editor-agent`)).toBeTruthy();
    await inherited.unmount();

    for (const projectDefaults of [{}, { defaultAgentTarget: CODEX }]) {
      const data = ProjectSessionDefaultsGetOutputV1Schema.parse({
        context: { primaryTeamId: 'team-acme', projectDefaults },
        personalDefaultsRow: null, sourceDefaultsRow: null, source: null, canManageSource: false, repairRequired: false, teamName: 'Acme',
      });
      const screen = await renderScreen(
        <ProjectSessionDefaultsView testID={SPECIMEN} projectName="acme/web" serverId="server-specimen" hasSource scope="me"
          onScopeChange={() => {}} status="ready" data={data} onRetry={async () => {}} defaults={projectDefaults}
          editable busy={false} save={async () => {}} />,
      );
      await flushHookEffects({ cycles: 3 });
      expect(subtitleOf(screen, `${SPECIMEN}.editor-agent`), JSON.stringify(projectDefaults))
        .toBe(t('teams.settings.memberDefaults.agentDescription'));
      await screen.unmount();
    }
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
