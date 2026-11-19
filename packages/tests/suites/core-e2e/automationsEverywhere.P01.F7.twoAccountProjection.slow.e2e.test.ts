import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectUiPersonActionClient, readUiMachineProjection } from '@happier-tests/ui-action-client';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createExternalTicketPlugin } from '../../../plugin-ui/fixtures/external-authoring/src/ticketAutomationPlugin';
import { createPluginManifestV2Fixture } from '../../../../apps/cli/src/plugins/testkit/manifestV2Fixture';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';

it('reacquires the adopted projection after two Accounts and two Machines prewarm the real UI', async () => {
  const run = createRunDirs({ runLabel: 'automations-p01-f7-projection-cache' });
  const testDir = run.testDir('development-reconnect');
  const fixture = await startTeamSetupFFixture({ testDir,
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  try {
    const actor = await fixture.createAccount('projection-owner');
    const reader = await fixture.createAccount('projection-reader');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const readerMachine = await fixture.enrollDaemon(reader, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    // Match the qualified F7 journey's established person/Home bootstrap.
    const control = await actor.executeAsPerson('workflow.events.list', machine.target);
    expect(control.ok, JSON.stringify(control)).toBe(true);
    const pluginIds = ['acme.tickets', 'other.tickets'] as const;
    const sections = ['actionsById', 'familiesById.subjectKinds'] as const;
    for (const currentPluginId of pluginIds) {
      const publicManifest = createExternalTicketPlugin(currentPluginId).manifest;
      const manifest = createPluginManifestV2Fixture({ id: currentPluginId, entrypoints: undefined,
        contributes: { actions: publicManifest.contributes.actions.filter(action => ['close-ticket', 'list-tickets'].includes(action.id)),
          subjectKinds: publicManifest.contributes.subjectKinds } });
      const sourceRoot = join(testDir, currentPluginId + '-ticket-source');
      await mkdir(sourceRoot, { recursive: true });
      const entryPath = join(sourceRoot, 'plugin.ts');
      await writeFile(entryPath, `export const manifest = ${JSON.stringify(manifest)};\nexport function activate(api) { api.actions.register('close-ticket', () => ({ ticketId: 'ticket-1', state: 'closed' })); api.actions.register('list-tickets', () => ({ items: [], nextCursor: null })); }\n`);
      await applyTrustedLocalPluginFixture({ daemonPort: machine.daemon.state.httpPort,
        controlToken: machine.daemon.state.controlToken, pluginRoot: entryPath, pluginId: currentPluginId,
        interactionId: 'f7-two-account-install-' + currentPluginId });
      await applyTrustedLocalPluginFixture({ daemonPort: readerMachine.daemon.state.httpPort,
        controlToken: readerMachine.daemon.state.controlToken, pluginRoot: entryPath, pluginId: currentPluginId,
        interactionId: 'f7-two-account-reader-install-' + currentPluginId });
    }

    ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      accountSecret: actor.auth.accountSigningSeed });
    const entry = await readUiMachineProjection({ machineId: machine.target.machineId,
      serverId: ui.serverId, sections });
    expect(entry?.kind).toBe('ready');
    if (entry?.kind !== 'ready') throw new Error('Restored Machine projection unavailable');
    for (const pluginId of pluginIds) {
      const key = buildQualifiedPluginContributionKey({ pluginId, localId: 'close-ticket' });
      expect(entry.inputs.pluginProjectionV2?.actionsById[key]).toMatchObject({ pluginId, id: 'close-ticket' });
      expect(Object.values(entry.inputs.pluginUiProjection.subjectKindsById)).toEqual(expect.arrayContaining([
        expect.objectContaining({ pluginId, definition: expect.objectContaining({ id: 'ticket' }) }),
      ]));
    }
  } finally {
    await ui?.close();
    await fixture.stop();
  }
}, 0);
