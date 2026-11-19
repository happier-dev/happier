import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectUiPersonActionClient, mountUiAutomationSubjectPicker, mountUiWorkflowActionCatalog, readUiMachineProjection } from '@happier-tests/ui-action-client';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
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
    const picker = await mountUiAutomationSubjectPicker({
      kind: { kind: 'plugin', pluginId: pluginIds[0], subjectKindId: 'ticket' }, page: { limit: 20 },
      subjectKinds: Object.values(entry.inputs.pluginUiProjection.subjectKindsById), machineId: machine.target.machineId,
    });
    try {
      await picker.waitForSettled();
      expect(picker.read()).toMatchObject({ status: 'ready', items: [], hasMore: false, coverage: 'complete' });
    } finally { await picker.close(); }
    await ui.close();
    ui = undefined;
    const definitionId = randomUUID();
    const definitionCreated = await actor.executeAsPerson('workflow.definition.create', { definitionId,
      metadata: { title: 'Shared ticket review' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the ticket.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } });
    expect(definitionCreated.ok, JSON.stringify({ ok: definitionCreated.ok,
      ...(!definitionCreated.ok ? { errorCode: definitionCreated.errorCode } : {}) })).toBe(true);
    const ownerId = readAccountIdFromToken(actor.credentials.token);
    const readerId = readAccountIdFromToken(reader.credentials.token);
    for (const [account, id] of [[actor, ownerId], [reader, readerId]] as const) {
      const named = await account.executeAsPerson('account.username.set', {
        username: `f7${id.replaceAll('-', '').slice(0, 12)}`,
      });
      expect(named.ok, JSON.stringify(named.ok ? { ok: true } : { errorCode: named.errorCode })).toBe(true);
    }
    const requested = await actor.executeAsPerson('friends.add', { uid: readerId });
    expect(requested, JSON.stringify(requested.ok ? { ok: true } : { errorCode: requested.errorCode }))
      .toMatchObject({ ok: true, result: { user: { id: readerId, status: 'requested' } } });
    const accepted = await reader.executeAsPerson('friends.add', { uid: ownerId });
    expect(accepted, JSON.stringify(accepted.ok ? { ok: true } : { errorCode: accepted.errorCode }))
      .toMatchObject({ ok: true, result: { user: { id: ownerId, status: 'friend' } } });
    const granted = await actor.executeAsPerson('artifact.access.grants.set', { artifactId: definitionId,
      principal: { kind: 'account', accountId: readerId }, accessLevel: 'view' });
    expect(granted.ok, JSON.stringify(granted.ok ? { ok: true } : { ok: false,
      errorCode: granted.errorCode, failureCause: granted.failureCause })).toBe(true);
    ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl, accountSecret: actor.auth.accountSigningSeed });
    const catalogs: Awaited<ReturnType<typeof mountUiWorkflowActionCatalog>>[] = [];
    try {
      const actionIds = pluginIds.map(pluginId => formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' }));
      for (const phase of ['before', 'after'] as const) {
        const catalog = await mountUiWorkflowActionCatalog({ serverId: ui.serverId,
          machineId: machine.target.machineId, phase });
        catalogs.push(catalog);
        await catalog.waitForSettled();
        expect(catalog.read().phase).toBe('ready');
        expect(catalog.read().specs.map(spec => spec.id)).toEqual(expect.arrayContaining(actionIds));
        const linked = await ui.executeConfirmed('workflow.trigger.add', {
          workflow: definitionId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
          trigger: { kind: 'action', phase, ...(phase === 'before' ? { mode: 'notify' } : {}), enabled: true, actionIds,
            subject: { kind: 'plugin', serverId: fixture.serverId, pluginId: pluginIds[0],
              subjectKindId: 'ticket', identity: { ticketId: 'ticket-1' } } },
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: ui.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
          externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
            project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
        expect(linked.ok, JSON.stringify(linked.ok ? { ok: true } : { errorCode: linked.errorCode,
          failureCause: linked.failureCause })).toBe(true);
      }
    } finally {
      for (const catalog of catalogs.reverse()) await catalog.close();
      await ui.close(); ui = undefined;
    }
    const closed = await actor.executeAsPerson('action.invoke', {
      action: { pluginId: pluginIds[0], localId: 'close-ticket' }, input: { ticket: { ticketId: 'ticket-1' } },
    }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } },
    { action: { pluginId: pluginIds[0], localId: 'close-ticket' }, machineId: machine.target.machineId });
    expect(closed, JSON.stringify(closed.ok ? { ok: true } : { ok: false,
      errorCode: closed.errorCode, failureCause: closed.failureCause }))
      .toMatchObject({ ok: true, result: { ticketId: 'ticket-1', state: 'closed' } });
  } finally {
    await ui?.close();
    await fixture.stop();
  }
}, 0);
