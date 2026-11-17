import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { ManagedMachineActionOutputSchemasV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionOperationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { buildAuthoredAccountActionRelease } from '../../../../apps/cli/src/plugins/runtime/accountPluginActions.testkit';
import { packLocalPlugin } from '../../../../apps/cli/src/plugins/packaging/pack';
import type { PluginChangeRequestResult } from '../../../../apps/cli/src/plugins/daemon/changeContract';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { guestCliExecutable } from '../../../../apps/cli/src/machines/managed/enrollmentPayload.testkit';
import type { Settings } from '../../../../apps/cli/src/persistence';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
  GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH } from '../../../../apps/cli/src/plugins/install/ui/generatedArtifacts';
import { contribution, manifest } from '../../fixtures/account-machine-provider';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';
import { renderScreen } from '../../../../apps/ui/sources/dev/testkit/render/renderScreen';
import { MachineProvisionerPicker } from '../../../../apps/ui/sources/components/settings/machines/managed/MachineProvisionerPicker';
import { ListPresentationProvider } from '../../../../apps/ui/sources/components/ui/lists/listPresentation';
import { ModalProvider } from '../../../../apps/ui/sources/modal';
import { captureActiveServerAccountScopeLifetime } from '../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '../../../../apps/ui/sources/sync/domains/plugins/availability/projection';
import { acquirePluginReactNativeArtifactLease } from '../../../../apps/ui/sources/sync/domains/plugins/availability/reactNativeArtifactLease';
import { resolveSavedServerProfileByUrl } from '../../../../apps/ui/sources/sync/domains/server/serverProfiles';

const run = createRunDirs({ runLabel: 'core' });

it('runs Account provisioner options and acquire, then refuses both roles when the installed revision lacks its artifact', async () => {
  const testDir = run.testDir(`account-artifact-${randomUUID()}`);
  const payloadRoot = join(testDir, 'local-guest-payload');
  await mkdir(payloadRoot, { recursive: true });
  // Existing executable boundary fixture admits local allocation; guest execution remains deliberately unavailable.
  await writeFile(join(payloadRoot, 'happier'), guestCliExecutable('exit 1\n'), { mode: 0o755 });
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  const fixture = await startProjectDaemonFixture({ testDir, dbProvider: 'postgres',
    daemonEnv: { HAPPIER_LOG_LEVEL: 'debug', HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: payloadRoot },
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl,
      HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: '1',
      // Match the canonical authored-release fixture's operator hosting allowance.
      HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: String(16 * 1024 * 1024),
      HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: String(256 * 1024 * 1024) } }).catch(async (error: unknown) => {
      await postgres.stop();
      throw error;
    });
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  try {
    const account = await fixture.createAccount('provider-owner');
    ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
      accountSecret: account.auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady());
    const savedHome = resolveSavedServerProfileByUrl(fixture.server.baseUrl);
    expect(savedHome.kind).toBe('resolved');
    if (savedHome.kind !== 'resolved') throw new Error('Signed-in Home profile unavailable');
    const homeChoiceId = `managed-picker.home:${savedHome.profile.id}`;
    // Keep the mounted picker while its parent withdraws the explicit Home.
    // The available choice comes from the real signed-in UI profile owner.
    const picker = (serverId: string) => createElement(ModalProvider, null,
      createElement(ListPresentationProvider, { value: 'page' },
        createElement(MachineProvisionerPicker, { serverId, presetOnly: true })));
    const screen = await renderScreen(picker(ui.serverId));
    try {
      expect(screen.findByTestId(homeChoiceId)).toBeNull();
      await screen.update(picker(''));
      expect(screen.findByTestId(homeChoiceId)).not.toBeNull();
    } finally { await screen.unmount(); }
    const machine = await fixture.enrollDaemon(account, { cliLaunchSpec: { command: process.execPath,
      args: [resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: resolve(repoRootDir(), 'apps/cli') } });
    const settings: Settings = JSON.parse(await readFile(join(machine.homeDir, 'settings.json'), 'utf8'));
    expect(settings.activeServerId).toBe(machine.cliServerId);
    expect(settings.servers?.[machine.cliServerId]?.homeConnectionDescriptor?.homeServerIdentityId).toBe(fixture.serverId);
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineControlReady(machine.target.machineId));
    const installation = MachineInstallationIdentityV1Schema.parse(
      JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
    const controller = { machineId: machine.target.machineId, installationId: installation.installationId };

    async function install(version: string, withArtifact: boolean) {
      const root = join(testDir, `provider-${version}`);
      const declaration = { ...manifest, version };
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await mkdir(join(root, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH), { recursive: true });
      await writeFile(join(root, '.happier-plugin/plugin.json'), JSON.stringify(declaration));
      await writeFile(join(root, 'daemon.mjs'), 'export function activate() {}\n');
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'account-machine-journey-fixture', version,
        type: 'module', keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin/plugin.json', 'daemon.mjs', 'dist/happier-plugin-ui'] }));
      if (withArtifact) {
        const artifact = await buildAuthoredAccountActionRelease({ manifest: declaration, artifactId: 'account-runtime',
          accountArtifactId: randomUUID(), manifestExport: null, activateExport: 'activateAccount', archiveDigestCharacter: 'a',
          source: { manifest: declaration, projectRoot: resolve(repoRootDir(), 'packages/tests'),
            entryPath: resolve(repoRootDir(), 'packages/tests/fixtures/account-machine-provider/index.ts') } });
        for (const file of artifact.files) {
          const path = join(root, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH, file.relativePath);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.bytes);
        }
        await writeFile(join(root, GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH), JSON.stringify(artifact.generated));
      }
      // Exercise normal portable installation. A development source has no portable Account release.
      const packed = await packLocalPlugin({ locator: root, outPath: join(testDir, `provider-${version}.tgz`) });
      expect(packed, JSON.stringify(packed)).toMatchObject({ ok: true });
      if (!packed.ok) throw new Error('Fixture package was refused');
      const requested = await daemonControlPostJson({ port: machine.daemon.state.httpPort,
        controlToken: machine.daemon.state.controlToken, path: '/plugins/change/request',
        body: { kind: 'installArchive', locator: packed.archivePath, expectedIntegrity: packed.archiveIntegrity } });
      expect(requested.status, JSON.stringify(requested.data)).toBe(200);
      // The authenticated local control transport serializes its canonical result contract.
      const change = requested.data as PluginChangeRequestResult;
      if (change.kind === 'reviewRequired') {
        const approved = await daemonControlPostJson({ port: machine.daemon.state.httpPort,
          controlToken: machine.daemon.state.controlToken, path: '/plugins/change/decide',
          body: { pendingChangeId: change.pendingChangeId, decision: 'installAndTrust', optionalSelections: [] } });
        expect(approved.data, JSON.stringify(approved.data)).toMatchObject({ kind: 'committed' });
      } else expect(change).toMatchObject({ kind: 'committed' });
      const selected = await ui!.executeConfirmed('plugins.account.release.select', {
        pluginId: contribution.pluginId, version,
        daemon: { serverId: ui!.serverId, serverIdentityId: fixture.serverId, machineId: machine.target.machineId },
      }, { surface: 'ui', authority: 'present_user', serverId: ui!.serverId, actionCaller: { kind: 'host' } });
      expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { kind: 'selected' } });
      if (withArtifact) {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Signed-in Account lifetime unavailable');
        const reader = readPluginAccountAvailability(lifetime.scope);
        await waitFor(() => reader.readCurrentHostedArtifactAdministration({ pluginId: contribution.pluginId }).kind === 'available');
        const hosting = await ui!.executeConfirmed('plugins.account.hosting.set', { pluginId: contribution.pluginId, enabled: true },
          { surface: 'ui', authority: 'present_user', serverId: ui!.serverId, actionCaller: { kind: 'host' } });
        expect(hosting, JSON.stringify(hosting)).toMatchObject({ ok: true, result: { kind: 'updated' } });
        const hosted = reader.readCurrentHostedArtifactAdministration({ pluginId: contribution.pluginId });
        if (hosted.kind !== 'available') throw new Error('Selected release unavailable');
        const slot = hosted.release.uiSlots.find(candidate => candidate.artifactId === 'account-runtime' && candidate.platform === 'web');
        if (!slot?.artifactGraph) throw new Error('Selected Account artifact graph unavailable');
        const artifactSlot = { pluginId: contribution.pluginId, contributionId: slot.contributionId, tier: slot.tier, platform: slot.platform };
        await waitFor(() => reader.readCurrentHostedPublicationTarget(artifactSlot).kind === 'available');
        // Selection records desired custody. The real UI lease verifies daemon bytes and publishes the Account archive.
        const acquired = await acquirePluginReactNativeArtifactLease({ reader, accountLifetime: lifetime,
          artifactGraph: slot.artifactGraph, cacheIdentity: { pluginId: contribution.pluginId, contributionId: slot.contributionId,
            artifactId: slot.artifactId, artifactDigest: slot.artifactDigest, platform: slot.platform },
          daemon: { machineId: machine.target.machineId, serverId: ui!.serverId } });
        expect(acquired, JSON.stringify(acquired)).toMatchObject({ kind: 'available' });
        if (acquired.kind !== 'available') throw new Error(acquired.code);
        try {
          expect(acquired.accountHosting).toBeDefined();
          const publication = await acquired.accountHosting;
          expect(publication, JSON.stringify(publication)).toMatchObject({ kind: 'published' });
        } finally { acquired.lease.dispose(); }
      }

    }

    async function options() {
      return account.execute('machines.provisioners.options', { homeId: fixture.serverId, controller,
        contribution, selectors: {} });
    }
    const acquire = (name: string) => ui!.executeConfirmed('machines.managed.acquire', {
      selection: { kind: 'one-off', homeId: fixture.serverId, controller,
        launch: { provider: contribution, schemaVersion: 1, name, choices: { name } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    }, { surface: 'ui', authority: 'present_user', serverId: ui!.serverId, actionCaller: { kind: 'host' } });

    // Prove the exact fixture's valid artifact path before counting a refusal as evidence.
    await install('1.0.0', true);
    const availableOptions = await options();
    expect(availableOptions, JSON.stringify(availableOptions)).toMatchObject({ ok: true,
      result: { dimensions: { size: [{ id: 'local' }] } } });
    const acquired = await acquire('artifact-present');
    expect(acquired, JSON.stringify(acquired)).toMatchObject({ ok: true });
    if (!acquired.ok) throw new Error(acquired.errorCode);
    const accepted = ManagedMachineActionOutputSchemasV1['machines.managed.acquire'].parse(acquired.result);
    try {
      await waitFor(async () => {
        const read = await account.execute('machines.managed.get', { homeId: fixture.serverId, managedId: accepted.managedId });
        expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
        if (!read.ok) return false;
        const row = unwrapManagedMachineReadV1(ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(read.result));
        expect(row, JSON.stringify(row)).toMatchObject({ allocation: 'bound' });
        return true;
      });
    } catch (error) {
      const operation = accepted.operation && await account.execute('action.operations.get', { serverId: fixture.serverId,
        machineId: machine.target.machineId, operationId: accepted.operation.operationId });
      throw new Error(`Present-artifact allocation did not bind: ${String(error)}; operation=${JSON.stringify(operation)}`);
    }
    // Binding proves the Account acquire handler ran. Guest installation/enrollment is a separate journey.
    await install('1.0.1', false);
    const missingOptions = await options();
    expect(missingOptions, JSON.stringify(missingOptions)).toMatchObject({ ok: false, errorCode: 'plugin_daemon_module_load_failed' });
    expect(JSON.stringify(missingOptions)).toContain('plugin_account_execution_artifact_unavailable');
    const missingAcquire = await acquire('missing-artifact');
    expect(missingAcquire, JSON.stringify(missingAcquire)).toMatchObject({ ok: true });
    if (!missingAcquire.ok) throw new Error(missingAcquire.errorCode);
    const missingAccepted = ManagedMachineActionOutputSchemasV1['machines.managed.acquire'].parse(missingAcquire.result);
    expect(missingAccepted.operation).toBeDefined();
    const terminal = await account.execute('action.operations.get', { serverId: fixture.serverId,
      machineId: machine.target.machineId, operationId: missingAccepted.operation!.operationId, waitForTerminal: true });
    expect(terminal, JSON.stringify(terminal)).toMatchObject({ ok: true });
    if (!terminal.ok) throw new Error(terminal.errorCode);
    const failed = ActionOperationActionOutputSchemasV1['action.operations.get'].parse(terminal.result);
    expect(failed).toMatchObject({ kind: 'found', operation: { state: 'failed',
      error: { errorCode: 'plugin_daemon_module_load_failed' } } });
    expect(JSON.stringify(failed)).toContain('plugin_account_execution_artifact_unavailable');
  } finally {
    try { await ui?.close(); }
    finally {
      try { await fixture.stop(); }
      finally { await postgres.stop(); }
    }
  }
  // Each existing process fixture owns its startup/settlement budgets.
}, 0);
