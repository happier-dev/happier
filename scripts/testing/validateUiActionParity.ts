import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AGENT_ACTION_EXCLUSION_REASONS, listActionSpecs, listActionCliCommandDeclarations,
  listVoiceToolActionSpecs } from '../../packages/protocol/src/actions/actionSpecs.ts';
import { listActionSpecsForCatalogSurface } from '../../packages/protocol/src/actions/actionCatalog.ts';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, buildBuiltInAccountSettingMutationV1,
  readPortablePlatformAccountSettingBindingV1, resolveBuiltInAccountSettingResetValueV1 } from '../../packages/protocol/src/actions/settings/settingsDeclarations.ts';
import { accountSettingsParse } from '../../packages/protocol/src/account/settings/accountSettings.ts';
import { collectActionDispatchParity, readActionDispatchGraph } from './lib/actionDispatchParity.ts';
import { collectUiActionParity, readUiActionParitySources } from './lib/uiActionParity.ts';

/** Presence at the actual composition/registration boundary; journeys prove effects. */
export function readCurrentActionDispatchParity(specs = listActionSpecs()) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  // The CLI owns its @ aliases and native module loading. Use its existing
  // source runtime instead of substituting its factories or registrars.
  const home = mkdtempSync(resolve(tmpdir(), 'action-dispatch-host-'));
  const environment: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: resolve(root, 'apps/cli/tsconfig.runtime.json'),
    HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'http://127.0.0.1:1' };
  delete environment.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
  let output: string;
  try {
  output = execFileSync(process.execPath, ['--conditions=happier-source', '--import',
    './packages/cli-common/registerSourceRuntime.mjs', '--input-type=module', '-e', `
      import { withSetupRpcRegistrations, SETUP_RPC_REGISTRATION_ACTION_IDS } from './apps/cli/src/testkit/setupRpcRegistrations.ts';
      import { listActionSpecs, hasDeclaredActionDaemonIngress } from './packages/protocol/src/actions/actionSpecs.ts';
      import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from './packages/protocol/src/rpc/methods.ts';
      import { isUiMachineOwnedAdmissionAction } from './apps/ui/sources/sync/ops/actions/executeMachineActionAtDaemon.ts';
      import { createCliActionHost } from './apps/cli/src/session/actions/createCliActionExecutor.ts';
      import { createAccountServerActionDeps } from './apps/cli/src/api/accountServerActionDeps.ts';
      import { createActionSettingsProvider } from './apps/cli/src/settings/actionsSettingsProvider.ts';
      import { seedCliTokenOnlyAuthForServer } from './packages/tests/src/testkit/cliAuth.ts';
      import { readStoredCredentialsForServerId } from './apps/cli/src/persistence.ts';
      import { AuthTokenProvenanceSchema } from './packages/protocol/src/auth/authToken.ts';
      const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
      const token = 'header.' + Buffer.from(JSON.stringify({ sub: 'dispatch-account', tokenEpoch: 0, provenance })).toString('base64url') + '.fixture-signature';
      const origin = 'http://127.0.0.1:1';
      const seeded = await seedCliTokenOnlyAuthForServer({ cliHome: process.env.HAPPIER_HOME_DIR, serverUrl: origin, token });
      const credentials = await readStoredCredentialsForServerId(seeded.serverId);
      if (!credentials || credentials.encryption !== null) throw new Error('plain stored fixture credentials missing');
      const home = { serverId: seeded.serverId, serverHttpBaseUrl: origin };
      // A configured authenticated host. No effect or network request runs;
      // constructors install the actual native ports used by the CLI factory.
      const host = createCliActionHost({ token: credentials.token, credentials, mode: 'plain', ctx: null,
        sessionId: 'cli-global', ...home, externalActionClient: true,
        actionsSettingsProvider: createActionSettingsProvider(),
        accountServerActionDeps: createAccountServerActionDeps({ token: credentials.token, credentials, ...home,
          isCredentialCurrent: () => true }),
      });
      const callable = value => typeof value === 'function' || value !== null && typeof value === 'object'
        && Object.values(value).some(member => typeof member === 'function');
      const hostPorts = Object.entries(host.deps).filter(([, value]) => callable(value)).map(([key]) => key);
      const methods = [...new Set(listActionSpecs().flatMap(spec =>
        [spec.bindings?.rpcMethod, ...(spec.bindings?.rpcMethodAliases ?? [])]).filter(Boolean)), EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1];
      const registered = await withSetupRpcRegistrations(manager => methods.filter(method => manager.hasHandler(method)));
      console.log('ACTION_DISPATCH_EVIDENCE ' + JSON.stringify({
        registered, coveredActionIds: SETUP_RPC_REGISTRATION_ACTION_IDS, hostPorts,
        // A catalog audit has no admitted operands. For input-dependent Actions,
        // inspect whether their declaration includes a UI-to-Machine route.
        uiMachineActionIds: listActionSpecs().filter(spec => spec.executionPlacementForInput
          ? hasDeclaredActionDaemonIngress(spec, 'ui')
            && (spec.executionPlacements ?? [spec.executionPlacement]).includes('machine')
          : isUiMachineOwnedAdmissionAction(spec.id, undefined)).map(spec => spec.id),
        hostMachineActionIds: listActionSpecs().filter(spec => hasDeclaredActionDaemonIngress(spec, 'cli')).map(spec => spec.id),
      }));
    `], { cwd: root, encoding: 'utf8', env: environment });
  } finally { rmSync(home, { recursive: true, force: true }); }
  const line = output.split('\n').find(line => line.startsWith('ACTION_DISPATCH_EVIDENCE '));
  if (!line) throw new Error('CLI dispatch composition did not produce its evidence');
  const evidence: { registered: string[]; coveredActionIds: string[]; uiMachineActionIds: string[]; hostMachineActionIds: string[]; hostPorts: string[] } = JSON.parse(line.slice('ACTION_DISPATCH_EVIDENCE '.length));
  const graph = { ...readActionDispatchGraph(root), hostPorts: evidence.hostPorts };
  const catalog = (surface: 'ui' | 'cli' | 'agent' | 'mcp') => new Set(listActionSpecsForCatalogSurface({ surface }).map(spec => spec.id));
  const findings = collectActionDispatchParity(graph, specs, {
    ui: catalog('ui'), cli: catalog('cli'), agent: catalog('agent'), mcp: catalog('mcp'),
    voice: new Set(listVoiceToolActionSpecs().map(spec => spec.id)),
  }, new Set(evidence.registered), new Set(evidence.coveredActionIds), new Set(evidence.uiMachineActionIds), new Set(evidence.hostMachineActionIds));
  const coverage = Object.fromEntries(['account', 'machine', 'client', 'session'].map(placement => {
    const rows = specs.filter(spec => spec.executionPlacement === placement);
    return [placement, { declared: rows.length, mapped: rows.filter(spec => graph.requirements[spec.id]).length }];
  }));
  return { canonicalSpecs: specs.length, mappedSpecs: specs.filter(spec => graph.requirements[spec.id]).length,
    coverage, unmappedActionIds: specs.filter(spec => !graph.requirements[spec.id]).map(spec => spec.id),
    uiPorts: graph.uiPorts.length, hostPorts: graph.hostPorts.length, mcpPorts: graph.mcpPorts?.length, daemonPorts: graph.daemonPorts?.length,
    uiMachineDispatch: graph.uiMachineDispatch, clientReverseDispatch: graph.clientReverseDispatch, hostMachineDispatch: graph.hostMachineDispatch,
    voiceDispatch: graph.voiceDispatch,
    cliDispatch: graph.cliDispatch, sessionToolDispatch: graph.sessionToolDispatch, standaloneToolDispatch: graph.standaloneToolDispatch,
    hostClientDispatch: graph.hostClientDispatch,
    registeredRpcMethods: evidence.registered.length, findings, requirements: graph.requirements, children: graph.children };
}

// Development diagnostic for the same source walker consumed by the UI parity test.
export function readCurrentUiActionParity() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = readUiActionParitySources(root);
  const specs = listActionSpecs();
  const defaults = accountSettingsParse({});
  const settingBindings = new Map<string, string[]>();
  for (const declaration of BUILT_IN_SETTINGS_DECLARATIONS_V1) {
    if (declaration.storage?.scope !== 'account' || declaration.storage.access !== 'read_write') continue;
    // Ask the real pure semantic owner for an admitted reset delta; no write or service runs.
    const reset = resolveBuiltInAccountSettingResetValueV1(declaration);
    const delta = reset.success ? buildBuiltInAccountSettingMutationV1(declaration, defaults, reset.value) : null;
    for (const key of Object.keys(delta ?? {})) {
      const anchors = settingBindings.get(`account:${key}`) ?? [];
      anchors.push(declaration.anchor);
      settingBindings.set(`account:${key}`, anchors);
    }
    // The semantic Enter-to-send row binds a different canonical key per host.
    // Read both owners; an arbitrary metadata option never authorizes a write.
    for (const platform of ['web', 'native'] as const) {
      const binding = readPortablePlatformAccountSettingBindingV1(declaration, platform);
      if (!binding || binding.access !== 'read_write') continue;
      const anchors = settingBindings.get(`account:${binding.key}`) ?? [];
      anchors.push(declaration.anchor);
      settingBindings.set(`account:${binding.key}`, anchors);
    }
  }
  return { sourceFiles: files.length, canonicalSpecs: specs.length,
    ...collectUiActionParity(files, specs, BUILT_IN_SETTINGS_DECLARATIONS_V1, {
      sourceRoot: root,
      agentIds: new Set(listActionSpecsForCatalogSurface({ surface: 'agent' }).map(spec => spec.id)),
      mcpIds: new Set(listActionSpecsForCatalogSurface({ surface: 'mcp' }).map(spec => spec.id)),
      cliIds: new Set(listActionSpecsForCatalogSurface({ surface: 'cli' }).map(spec => spec.id)),
      cliCommandIds: new Set(listActionCliCommandDeclarations().map(({ spec }) => spec.id)),
      agentExclusionReasons: new Map(Object.entries(AGENT_ACTION_EXCLUSION_REASONS)),
      settingBindings,
    }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--dispatch')) {
    const report = readCurrentActionDispatchParity();
    console.log(JSON.stringify(report));
    if (report.findings.length) process.exitCode = 1;
  } else {
    const report = readCurrentUiActionParity();
    console.log(`UI Action parity: ${report.sourceFiles} source files, ${report.canonicalSpecs} canonical specs, `
      + `${report.actions.length} Action sites, ${report.settings.length} settings sites, ${report.findings.length} findings`);
    console.log(JSON.stringify(report));
    if (report.findings.length || !report.actions.length || !report.settings.length) process.exitCode = 1;
  }
}
