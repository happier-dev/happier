import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveInstalledRuntimePackage } from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import type { Settings } from '../../../../apps/cli/src/persistence';
import { DATABASE_CAPTURE_RESOURCE_REF_V1, DatabaseWorktreeTargetV1Schema } from '@happier-dev/plugin-sdk/database';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1, databaseActionLocalIdV1, type DatabaseActionIdV1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseTargetsConnectInputV1Schema } from '../../../database-protocol/src/databaseTargetActions';
import { DatabaseDescriptorV1Schema as DatabaseTargetsConnectResultV1Schema } from '@happier-dev/plugin-sdk/database';

import { startDatabaseWorkbenchPostgres } from './process/databaseWorkbenchPostgres';
export { prepareDatabaseWorkbenchPostgresService } from './process/databaseWorkbenchPostgres';
import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';
import { repoRootDir } from './paths';
import { startSessionMcpAgent } from './sessionMcpAgent';

/** Register authored source owned by this run. The daemon watches the registered
 * root, so another lane editing the checkout must not reload this fixture. */
type FixturePluginInstallation = Readonly<{
  testDir: string;
  daemonPort: number;
  controlToken?: string | null;
  moduleImportJournal?: string;
}>;

export function installDatabaseWorkbenchPluginFixture(params: FixturePluginInstallation) {
  return installDatabaseFixturePlugin(params, 'database-workbench', DATABASE_PLUGIN_ID_V1);
}

export function installDatabaseCapturePluginFixture(params: FixturePluginInstallation) {
  return installDatabaseFixturePlugin(params, 'telemetry', DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId);
}

async function installDatabaseFixturePlugin(params: FixturePluginInstallation, packageName: string, pluginId: string) {
  const sourceRoot = join(repoRootDir(), 'packages/plugins', packageName);
  const packageJsonPath = join(sourceRoot, 'package.json');
  const packageJson = await readFile(packageJsonPath, 'utf8');
  const { dependencies, devDependencies } = JSON.parse(packageJson) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const pluginRoot = join(await realpath(params.testDir), `${packageName}-plugin`);
  await mkdir(pluginRoot);
  await Promise.all([
    cp(join(sourceRoot, 'src'), join(pluginRoot, 'src'), { recursive: true, dereference: true }),
    writeFile(join(pluginRoot, 'package.json'), packageJson),
    ...Object.keys({ ...dependencies, ...devDependencies }).map(async (packageName) => {
      const { packageJsonPath: installedManifest } = resolveInstalledRuntimePackage({
        packageName, resolveFromPackageJsonPath: packageJsonPath,
      });
      const link = join(pluginRoot, 'node_modules', packageName);
      await mkdir(dirname(link), { recursive: true });
      await symlink(dirname(await realpath(installedManifest)), link, 'junction');
    }),
  ]);
  if (packageName === 'database-workbench' && params.moduleImportJournal) {
    const activationEntry = join(pluginRoot, 'src', 'activate.ts');
    const source = await readFile(activationEntry, 'utf8');
    const journal = JSON.stringify(params.moduleImportJournal);
    await writeFile(activationEntry, `import { appendFileSync } from 'node:fs';
appendFileSync(${journal}, String(process.pid) + '\\n');
${source}`);
  }
  const { applyTrustedLocalPluginFixture } = await import('./externalSessionLiveLifecycleFixture');
  const installation = await applyTrustedLocalPluginFixture({
    daemonPort: params.daemonPort, controlToken: params.controlToken, pluginRoot,
    pluginId, interactionId: `${packageName}-fixture-install`,
  });
  return { sourceRoot: pluginRoot, installation };
}

/** Exercise the internal Session relay using the vendor boundary shim. The
 * relay supplies the agent's actual caller and authority from the live turn. */
export async function startDatabaseWorkbenchAgent(
  fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>>,
  testDir: string,
) {
  const agent = await startSessionMcpAgent({ testDir, directory: fixture.machine.workspaceDir,
    daemonState: fixture.machine.daemon.state, executeAsPerson: fixture.owner.executeAsPerson });
  return {
    sessionId: agent.sessionId, stop: agent.stop,
    execute: (actionId: DatabaseActionIdV1, input: unknown) => agent.execute(actionId, input),
  };
}

/** Real CLI Action → Postgres Home → enrolled daemon. No internal boundary mocks.
 * G2 callers createAccount first; enrollDaemon drives real terminal pairing.
 * A caller with an already paired home can pass enrollDaemon({pairedHome}).
 * Each flow owns its G1 Action control: native SQL setup alone is never a G1 pass.
 */
export async function startDatabaseWorkbenchFixture(params: Readonly<{
  testDir: string;
  postgresTls?: NonNullable<Parameters<typeof startDatabaseWorkbenchPostgres>[0]>['tls'];
  completeTerminalConnect?: Parameters<typeof import('./daemon/projectDaemon').startProjectDaemonFixture>[0]['completeTerminalConnect'];
  serverEnv?: NodeJS.ProcessEnv;
  guestReachableHome?: Parameters<typeof import('./teamSetupF').startTeamSetupFFixture>[0]['guestReachableHome'];
  advertiseRequestObservationEndpoint?: boolean;
  captureRequestBody?: (request: RecordedHttpProxyRequest) => boolean;
  beforeForwardResponse?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
}>) {
  // Load the CLI composition only when starting it, under the composed runner's
  // importer-aware aliases. Importing a fixture must not initialize the CLI graph.
  const { startTeamSetupFFixture } = await import('./teamSetupF');
  const postgres = await startDatabaseWorkbenchPostgres({ tls: params.postgresTls });
  try {
    const composition = await startTeamSetupFFixture({ testDir: join(params.testDir, 'composition'),
      completeTerminalConnect: params.completeTerminalConnect,
      dbProvider: 'postgres', observeActionRequests: true,
      guestReachableHome: params.guestReachableHome,
      advertiseRequestObservationEndpoint: params.advertiseRequestObservationEndpoint,
      captureRequestBody: params.captureRequestBody, beforeForwardResponse: params.beforeForwardResponse,
      serverEnv: { NODE_ENV: process.env.NODE_ENV, ...params.serverEnv, DATABASE_URL: postgres.homeDatabaseUrl } });
    return { ...composition, postgres,
      async stop() {
        try { await composition.stop(); } finally { await postgres.stop(); }
      },
    };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}

/** Later-state F6/F8/F9 setup. The real Open action supplies accepted workspace
 * and Project identity; the daemon supplies installation identity. These are
 * fixture prerequisites, never the named G1 control for any of those flows. */
export async function startDatabaseWorkbenchInsightsFixture(params: Readonly<{
  testDir: string;
  workspaceDir?: string;
  workbenchModuleImportJournal?: string;
  completeTerminalConnect?: Parameters<typeof startDatabaseWorkbenchFixture>[0]['completeTerminalConnect'];
  serverEnv?: NodeJS.ProcessEnv;
  daemonEnv?: NodeJS.ProcessEnv;
  guestReachableHome?: Parameters<typeof startDatabaseWorkbenchFixture>[0]['guestReachableHome'];
  captureRequestBody?: Parameters<typeof startDatabaseWorkbenchFixture>[0]['captureRequestBody'];
  beforeForwardResponse?: Parameters<typeof startDatabaseWorkbenchFixture>[0]['beforeForwardResponse'];
}>) {
  const fixture = await startDatabaseWorkbenchFixture(params);
  try {
    const owner = await fixture.createAccount('insights-owner');
    await fixture.claimHomeOwner(owner);
    const [{ ensureManagedJavaScriptRuntimeCommand }, { MANAGED_TOOLS_ROOT_ENV_KEY }] = await Promise.all([
      import('../../../cli-common/src/agents/managedJavaScriptRuntime'),
      import('../../../cli-common/src/firstPartyRuntime/installLayoutContract'),
    ]);
    const daemonEnv = { ...params.daemonEnv, [MANAGED_TOOLS_ROOT_ENV_KEY]: join(params.testDir, 'managed-tools') };
    // Prepare the real plugin UI toolchain before daemon startup can request
    // it concurrently for source observation and its own background services.
    const managedJavaScriptRuntime = await ensureManagedJavaScriptRuntimeCommand({ ...process.env, ...daemonEnv });
    if (!managedJavaScriptRuntime) throw new Error('DBW fixture managed JavaScript runtime unavailable');
    const machine = await fixture.enrollDaemon(owner, { env: daemonEnv, workspaceDir: params.workspaceDir });
    const pluginFixture = await installDatabaseWorkbenchPluginFixture({ testDir: params.testDir,
      daemonPort: machine.daemon.state.httpPort, controlToken: machine.daemon.state.controlToken,
      moduleImportJournal: params.workbenchModuleImportJournal });
    const envPath = '.env.local';
    const envBindings = {
      DATABASE_URL: fixture.postgres.selectedDatabaseUrl,
      NEIGHBOR_DATABASE_URL: fixture.postgres.neighborDatabaseUrl,
      NO_EXTENSION_DATABASE_URL: fixture.postgres.noExtensionDatabaseUrl,
    };
    const projectSetupDir = join(machine.workspaceDir, '.happier');
    await mkdir(projectSetupDir, { recursive: true });
    await writeFile(join(projectSetupDir, 'project.json'), JSON.stringify({
      version: 1,
      environmentVariables: Object.keys(envBindings).map(name => ({ name, kind: 'config' })),
    }));
    await writeFile(join(machine.workspaceDir, envPath),
      Object.entries(envBindings).map(([name, url]) => `${name}=${url}\n`).join(''), { mode: 0o600 });
    const opened = await owner.executeReviewed('projects.open', {
      serverId: fixture.serverId, machineId: machine.target.machineId,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' },
    }, { presentUserConfirmation: { actionId: 'projects.open' } });
    if (!opened.ok) throw new Error(`DBW fixture Project Open failed (${opened.errorCode})`);
    const accepted = OpenProjectResultV1Schema.parse(opened.result);
    if (accepted.kind !== 'opened') {
      // The canonical login owns this file. Project only identity facts, never credentials.
      const settings = JSON.parse(await readFile(join(machine.homeDir, 'settings.json'), 'utf8')) as Settings;
      const profile = settings.servers?.[machine.cliServerId];
      throw new Error(`DBW fixture Project Open did not open (${accepted.kind}: ${accepted.kind === 'refused' ? accepted.code : 'unexpected result'}); identity=${JSON.stringify({
        homeId: fixture.serverId, cliServerId: machine.cliServerId, activeServerId: settings.activeServerId,
        profileId: profile?.id, descriptorHomeId: profile?.homeConnectionDescriptor?.homeServerIdentityId,
        descriptorAuthority: profile?.homeConnectionDescriptorAuthority,
      })}`);
    }
    if (!accepted.facts?.projectKey) throw new Error('DBW fixture Project Open omitted its Project identity');
    const installation = MachineInstallationIdentityV1Schema.parse(JSON.parse(
      await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
    const context = { accountId: readAccountIdFromToken(owner.credentials.token),
      installationId: installation.installationId, projectKey: accepted.facts.projectKey, workspace: accepted.workspace };
    const scope = { kind: 'worktree' as const, ...context };
    const externalActionTarget = { kind: 'machine' as const, machineId: machine.target.machineId };
    const databaseInvocation = (actionId: DatabaseActionIdV1, input: unknown) => ({
      action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(actionId) }, input,
    });
    function executeDatabase(actionId: DatabaseActionIdV1, input: unknown, context: Parameters<typeof owner.execute>[2] = {}) {
      return owner.executeReviewed('action.invoke', databaseInvocation(actionId, input), {
        externalActionTarget, presentUserConfirmation: { actionId: 'action.invoke' }, ...context,
      });
    }
    function executeDatabaseAsPerson(actionId: DatabaseActionIdV1, input: unknown) {
      const invocation = databaseInvocation(actionId, input);
      return owner.executeAsPerson('action.invoke', invocation, { externalActionTarget }, {
        action: invocation.action, machineId: externalActionTarget.machineId,
      });
    }
    async function connectDatabase(databaseUrl: string, label: string) {
      const created = await owner.execute('secrets.create', { name: label, kind: 'other', value: databaseUrl },
        { presentUserConfirmation: { actionId: 'secrets.create' } });
      if (!created.ok) throw new Error(`DBW fixture Saved Secret creation refused (${created.errorCode})`);
      const secret = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(created.result);
      const connected = await executeDatabase(DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
        DatabaseTargetsConnectInputV1Schema.parse({ scope, savedSecretRef: secret.secretRef, label }));
      if (!connected.ok) throw new Error(`DBW fixture Connect refused (${connected.errorCode})`);
      const descriptor = DatabaseTargetsConnectResultV1Schema.parse(connected.result);
      if (descriptor.target.kind !== 'manual') throw new Error('DBW fixture Connect did not return its manual association');
      return { ...descriptor, target: descriptor.target };
    }
    function envTarget(variable: keyof typeof envBindings) {
      return DatabaseWorktreeTargetV1Schema.parse({ kind: 'worktree', ...context,
        source: { kind: 'env_file', path: envPath, variable } });
    }
    const targets = {
      selected: envTarget('DATABASE_URL'),
      neighbor: envTarget('NEIGHBOR_DATABASE_URL'),
      noExtension: envTarget('NO_EXTENSION_DATABASE_URL'),
    };
    const runtime = { homeId: fixture.serverId, serverPid: fixture.server.proc.child.pid,
      daemonPid: machine.daemon.state.pid, machineId: machine.target.machineId,
      installationId: installation.installationId, sourceRuntime: true,
      managedJavaScriptRuntime,
      sourceEntrypoints: {
        server: fixture.server.proc.child.spawnargs.filter(argument => /\.(?:mjs|cjs|tsx?)$/u.test(argument)),
        daemon: machine.daemon.proc.child.spawnargs.filter(argument => /\.(?:mjs|cjs|tsx?)$/u.test(argument)),
      },
      plugin: { id: DATABASE_PLUGIN_ID_V1, sourceRoot: pluginFixture.sourceRoot,
        installationKind: pluginFixture.installation.kind,
        ...(typeof pluginFixture.installation.appliedGeneration === 'string'
          ? { appliedGeneration: pluginFixture.installation.appliedGeneration } : {}),
      },
    };
    // A stable evidence pointer identifies the running processes without DSNs,
    // credentials, telemetry, or a separate release representation.
    await writeFile(join(params.testDir, 'runtime.json'), `${JSON.stringify(runtime)}\n`);
    return { ...fixture, owner, machine, scope, targets, runtime, executeDatabase, executeDatabaseAsPerson, connectDatabase };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
