import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const cliSourceRoot = join(repoRoot, 'apps', 'cli', 'src');

async function listProductionSourceFiles(
  directory: string,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listProductionSourceFiles(path));
      continue;
    }
    if (
      entry.isFile()
      && ['.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))
      && !entry.name.includes('.test.')
      && !entry.name.includes('.spec.')
      // Checked-in generated bundle outputs are regenerated once at the
      // integration boundary; this test owns source/generator contraction.
      && !entry.name.startsWith('generatedBundledPlugin')
    ) {
      files.push(path);
    }
  }

  return files.sort();
}

function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.js') || path.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sourceIdentifiers(path: string, source: string): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return identifiers;
}

function sourceExportModuleSpecifiers(
  path: string,
  source: string,
): ReadonlySet<string> {
  const moduleSpecifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      moduleSpecifiers.add(statement.moduleSpecifier.text);
    }
  }
  return moduleSpecifiers;
}

function sourceExportedTypeDeclarationIdentifiers(
  path: string,
  source: string,
): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      && statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      identifiers.add(statement.name.text);
    }
  }
  return identifiers;
}

function sourceCalls(path: string, source: string): readonly Readonly<{
  callee: string;
  argumentIdentifiers: ReadonlySet<string>;
}>[] {
  const calls: Array<Readonly<{
    callee: string;
    argumentIdentifiers: ReadonlySet<string>;
  }>> = [];
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (callee) {
        const argumentIdentifiers = new Set<string>();
        for (const argument of node.arguments) {
          const collectArgumentIdentifier = (argumentNode: ts.Node): void => {
            if (ts.isIdentifier(argumentNode)) argumentIdentifiers.add(argumentNode.text);
            ts.forEachChild(argumentNode, collectArgumentIdentifier);
          };
          collectArgumentIdentifier(argument);
        }
        calls.push(Object.freeze({ callee, argumentIdentifiers }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function expectCall(
  calls: ReturnType<typeof sourceCalls>,
  callee: string,
  argumentIdentifier?: string,
): void {
  expect(calls.some((call) => (
    call.callee === callee
    && (
      argumentIdentifier === undefined
      || call.argumentIdentifiers.has(argumentIdentifier)
    )
  ))).toBe(true);
}

// Absence censuses name surviving predecessor files by path, and those paths move or get
// deleted by whichever corridor owns them. A file that no longer exists trivially satisfies
// "does not contain the retired vocabulary", so reading it strictly can only manufacture a
// RED for a deletion that is the contraction direction this census asserts. Absence-side
// reads therefore tolerate a missing file; presence-side reads (the retained architecture in
// the last case) stay strict, because there a missing file IS the regression.
async function readAbsenceScanSource(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function findIdentifierOffenders(input: Readonly<{
  roots?: readonly string[];
  files?: readonly string[];
  identifiers: readonly string[];
}>): Promise<readonly string[]> {
  const sourceFiles = new Set(input.files ?? []);
  for (const root of input.roots ?? []) {
    for (const file of await listProductionSourceFiles(root)) {
      sourceFiles.add(file);
    }
  }
  const offenders: string[] = [];

  await Promise.all([...sourceFiles].sort().map(async (file) => {
    const source = await readAbsenceScanSource(file);
    if (source === null) return;
    const identifiers = sourceIdentifiers(file, source);
    for (const identifier of input.identifiers) {
      if (identifiers.has(identifier)) {
        offenders.push(`${identifier}: ${relative(repoRoot, file)}`);
      }
    }
  }));

  return offenders.sort();
}

async function findExistingProductionFiles(
  relativePaths: readonly string[],
): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const relativePath of relativePaths) {
    try {
      await access(join(repoRoot, relativePath));
      existing.push(relativePath);
    } catch {
      // The contraction requires this production owner to be absent.
    }
  }
  return existing;
}

async function readIdentifiers(relativePath: string): Promise<ReadonlySet<string>> {
  const path = join(repoRoot, relativePath);
  return sourceIdentifiers(path, await readFile(path, 'utf8'));
}

function expectIdentifiers(
  identifiers: ReadonlySet<string>,
  expected: readonly string[],
): void {
  expect(expected.filter((identifier) => !identifiers.has(identifier))).toEqual([]);
}

function readReasonPropertyValues(path: string, source: string): readonly string[] {
  const values: string[] = [];
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(path),
  );
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'reason') {
      let initializer = node.initializer;
      while (
        ts.isAsExpression(initializer)
        || ts.isSatisfiesExpression(initializer)
        || ts.isParenthesizedExpression(initializer)
        || ts.isNonNullExpression(initializer)
        || ts.isTypeAssertionExpression(initializer)
      ) {
        initializer = initializer.expression;
      }
      if (ts.isStringLiteral(initializer)) values.push(initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

describe('public managed Provider contraction', () => {
  it('removes Provider dependence on UI Local Services ownership, gating, and operation-scoped predecessors', async () => {
    const providerFiles = [
      'apps/cli/src/providers/connections/service/describe.ts',
      'apps/cli/src/providers/connections/service/localOperations.ts',
      'apps/cli/src/providers/connections/service/authoringOperations.ts',
      'apps/cli/src/providers/connections/service/types.ts',
      'apps/cli/src/providers/connections/runtimeServices.ts',
    ];
    const providerSources = await Promise.all(providerFiles.map(async (path) => ({
      path,
      source: await readAbsenceScanSource(join(repoRoot, path)),
    })));
    expect(providerSources.flatMap(({ path, source }) => (
      source?.includes('localServices.managed') ? [path] : []
    ))).toEqual([]);

    await expect(findIdentifierOffenders({
      files: [
        join(cliSourceRoot, 'daemon', 'local', 'services', 'runtime.ts'),
        join(cliSourceRoot, 'daemon', 'machine', 'bootstrapMachineSyncRuntime.ts'),
        join(cliSourceRoot, 'daemon', 'startup', 'createDaemonMachineBootstrapRuntime.ts'),
        join(cliSourceRoot, 'daemon', 'startup', 'startDaemonSessionControlRuntime.ts'),
        join(cliSourceRoot, 'daemon', 'startDaemon.ts'),
        join(cliSourceRoot, 'daemon', 'controlClient.ts'),
        join(cliSourceRoot, 'daemon', 'controlServer.ts'),
        join(cliSourceRoot, 'daemon', 'multiDaemon.ts'),
        join(cliSourceRoot, 'daemon', 'service', 'cli.ts'),
        join(cliSourceRoot, 'cli', 'commands', 'daemon.ts'),
        join(cliSourceRoot, 'cli', 'runtime', 'update', 'quiesceInstalledCliWindowsPayloadOwners.ts'),
      ],
      identifiers: [
        'TrustedManagedLocalServiceOwnedRun',
        'TrustedManagedLocalServiceOwnerContext',
        'TrustedManagedLocalServiceStopResult',
        'TrustedManagedLocalServiceTransferOptions',
        'TrustedManagedLocalServiceTransferResult',
        'getManagedSnapshot',
        'listByOwnerContext',
        'managedLocalServiceOwnerScopeKey',
        'operationManagedServiceKeys',
        'readManagedLocalServicesSnapshot',
        'trustedManagedLocalServices',
        'transferManagedLocalServices',
        'transferTrustedManagedLocalService',
        'ManagedLocalServicesShutdownDisposition',
        'managedLocalServicesDisposition',
        'ProviderManagedLocalServicesOwner',
        'onProviderManagedLocalServicesOwnerReady',
      ],
    })).resolves.toEqual([]);

    await expect(findIdentifierOffenders({
      files: [
        join(cliSourceRoot, 'daemon', 'local', 'services', 'runtime.ts'),
      ],
      identifiers: ['operationId'],
    })).resolves.toEqual([]);

    await expect(findIdentifierOffenders({
      files: [join(cliSourceRoot, 'providers', 'discovery', 'project.ts')],
      identifiers: ['managedServices'],
    })).resolves.toEqual([]);

    await expect(findExistingProductionFiles([
      'apps/cli/src/plugins/runtime/context/localServices.ts',
      'apps/cli/src/plugins/runtime/context/ui/hostedWeb.ts',
      'apps/cli/src/daemon/local/services/pluginBridgeAuthorization.ts',
      'apps/cli/src/daemon/local/services/pluginBridgeClient.ts',
      'apps/cli/src/daemon/local/services/pluginBridgeProtocol.ts',
      'apps/cli/src/daemon/local/services/pluginBridgeRoutes.ts',
      'apps/cli/src/daemon/local/services/managed/declaration.ts',
      'apps/cli/src/daemon/local/services/managed/startDeclarations.ts',
    ])).resolves.toEqual([]);

    // RU2 surfaces finalization / DEC-6 (LSV-2): the managed local-service RUNTIME — the
    // registry whose two start mutators had no production caller, its snapshot projection,
    // its restart resolver, and the protocol snapshot schemas + machine RPC that carried an
    // always-empty row list to the UI — is removed. The producer this census already forbids
    // (`declaration.ts` / `startDeclarations.ts`) is why it could never fill.
    // `selectManagedOwnedTreeEndpoint` survived the deletion and moved to its only live
    // consumer, the plugin-runtime managed-process supervisor; its new home is asserted below
    // so the move cannot silently regress into a re-created daemon module.
    await expect(findExistingProductionFiles([
      'apps/cli/src/daemon/local/services/managed/registry.ts',
      'apps/cli/src/daemon/local/services/managed/routes.ts',
      'apps/cli/src/daemon/local/services/managed/restart.ts',
      'apps/cli/src/daemon/local/services/managed/scripts.ts',
      'packages/protocol/src/local/services/managed/v1.ts',
      'packages/protocol/src/local/services/managed/index.ts',
      'apps/ui/sources/sync/domains/local/services/managed/store.ts',
      'apps/ui/sources/sync/domains/local/services/managed/sharedStore.ts',
      'apps/ui/sources/sync/domains/local/services/managed/useManagedLocalServicesState.ts',
      'apps/ui/sources/sync/domains/local/services/managed/machineRpc.ts',
      'apps/ui/sources/sync/domains/local/services/managed/api.ts',
      'apps/ui/sources/components/sessions/localServices/ManagedLocalServiceRow.tsx',
      'apps/ui/sources/components/sessions/localServices/ManagedLocalServiceStatus.tsx',
      'apps/ui/sources/components/sessions/localServices/LocalServiceFactList.tsx',
    ])).resolves.toEqual([]);

    // No production module may name the removed runtime again. This is an AST identifier
    // census over every production file in the daemon local-services corridor plus the two
    // protocol tables that carried the RPC row, so re-introducing any of it — under any
    // import spelling — is a RED here, not a silent regression.
    await expect(findIdentifierOffenders({
      roots: [join(cliSourceRoot, 'daemon', 'local', 'services')],
      identifiers: [
        'ManagedLocalServiceRegistry',
        'ManagedLocalServiceRuntimeState',
        'createManagedLocalServiceRegistry',
        'createLocalServiceManagedRoutes',
        'LocalServiceManagedRoutes',
        'resolveManagedLocalServiceRestartRequest',
        'ManagedLocalServiceRestartPolicy',
        'managedRegistry',
        'managedRoutes',
        'applyInventoryEntries',
        'startDetectAfterLaunch',
        'startAssignAndInject',
        'markProcessOwnershipUnverified',
        'stopIntentional',
      ],
    })).resolves.toEqual([]);

    await expect(findIdentifierOffenders({
      files: [
        join(repoRoot, 'apps/cli/src/daemon/controlServer.ts'),
        join(repoRoot, 'apps/cli/src/rpc/handlers/daemonLocalServices.ts'),
        join(repoRoot, 'apps/cli/src/rpc/handlers/_internalAllowlist.ts'),
        join(repoRoot, 'apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts'),
        join(repoRoot, 'packages/protocol/src/rpc/methods.ts'),
        join(repoRoot, 'packages/protocol/src/machines/peer/mediation/rpc/governanceV1.ts'),
        join(repoRoot, 'packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts'),
      ],
      identifiers: [
        'DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT',
        'LocalServiceManagedRuntimeSnapshotV1',
        'LocalServiceManagedRuntimeStateV1',
        'DaemonLocalServiceManagedSnapshotRequestV1Schema',
        'DaemonLocalServiceManagedSnapshotResponseV1Schema',
        'localServicesManaged',
      ],
    })).resolves.toEqual([]);

    // Presence side: the one live survivor of the deleted registry kept its behaviour and
    // gained an owner. A missing file here IS the regression, so this read stays strict.
    expectIdentifiers(
      await readIdentifiers(
        'apps/cli/src/plugins/runtime/invocation/services/managedOwnedTreeEndpoint.ts',
      ),
      ['selectManagedOwnedTreeEndpoint', 'ManagedInventoryCandidate'],
    );
    expectIdentifiers(
      await readIdentifiers(
        'apps/cli/src/plugins/runtime/invocation/services/managedProcessSupervisor.ts',
      ),
      ['selectManagedOwnedTreeEndpoint'],
    );

    await expect(findIdentifierOffenders({
      files: [
        join(cliSourceRoot, 'daemon', 'local', 'services', 'runtime.ts'),
        join(cliSourceRoot, 'daemon', 'startup', 'shutdownCancellationDomains.ts'),
        join(cliSourceRoot, 'daemon', 'startup', 'startDaemonSessionControlRuntime.ts'),
      ],
      identifiers: [
        'ManagedLocalServiceDeclaration',
        'ManagedLocalServicesRuntimeOptions',
        'createManagedLocalServiceStartDeclarationRegistry',
        'declarePluginManagedStartDeclaration',
        'managedLocalServicesProcessSignal',
        'pluginManagedStartDeclarations',
      ],
    })).resolves.toEqual([]);

    // These hostedWeb owners live in corridors this census does not own (protocol, apps/ui),
    // so they are read absence-tolerantly: `plugins/projection/registry/ui/hostedWebBuild.ts`
    // was already deleted outright by its owner and produced a spurious RED here. Deletion is
    // the contraction direction, and non-existence of the projection-registry predecessor is
    // asserted by its canonical owner
    // `plugins/projection/registry/normalize/legacyUiContributionContraction.test.ts`.
    const hostedWebPredecessors = await Promise.all([
      'packages/protocol/src/plugins/contributions/ui/hostedWeb.ts',
      'packages/protocol/src/plugins/ui/hostedWebBuild.ts',
      'apps/cli/src/plugins/install/ui/hostedWebAssets.ts',
      'apps/ui/sources/sync/domains/plugins/ui/hostedWebRuntime.ts',
    ].map(async (path) => ({
      path,
      source: await readAbsenceScanSource(join(repoRoot, path)),
    })));
    expect(hostedWebPredecessors.flatMap(({ path, source }) => (
      source?.includes('managedLocalService')
      || source?.includes("kind: z.literal('managedService')")
      || source?.includes("serviceKind === 'managedService'")
        ? [path]
        : []
    ))).toEqual([]);

    await expect(findIdentifierOffenders({
      files: [join(cliSourceRoot, 'plugins', 'runtime', 'exec', 'privateContract.ts')],
      identifiers: [
        'LocalServiceDeclarationV1',
        'LocalServiceLaunchV1',
        'LocalServiceRuntimeSnapshotV1',
      ],
    })).resolves.toEqual([]);
  });

  it('removes the Session marker attachment, CAS, promotion, and startup recovery graph', async () => {
    await expect(findIdentifierOffenders({
      roots: [join(cliSourceRoot, 'daemon')],
      identifiers: [
        'ManagedLocalServiceRunAttachmentMarkerOwnership',
        'ManagedLocalServiceRunAttachmentV1',
        'ManagedLocalServiceRunAttachmentV1Schema',
        'ManagedProviderRecoveryCandidate',
        '_managedLocalServiceRunAttachment',
        '_targetManagedLocalServiceRunAttachment',
        'clearPromotedManagedLocalServiceMarkerAttachment',
        'clearSessionMarkerManagedLocalServiceRunAttachment',
        'expectedManagedLocalServiceRunAttachment',
        'finalizeReattachedAuthority',
        'managedLocalServiceRunAttachment',
        'managedLocalServiceRunAttachmentsEqual',
        'managedProviderRecoveryCandidates',
        'onManagedLocalServiceRunAttachmentPersisted',
        'onManagedLocalServiceRunAttachmentPidPromoted',
        'preserveManagedLocalServiceRunAttachment',
        'preservedManagedLocalServiceRunAttachment',
        'reattachVerifiedRun',
        'recoverManagedProviderEndpoint',
        'setSessionMarkerManagedLocalServiceRunAttachment',
        'startupManagedProviderRecoveryCandidates',
        'writeSessionMarkerWithManagedLocalServiceRunAttachment',
      ],
    })).resolves.toEqual([]);
  });

  it('removes private Provider facets, adapters, and bundled-binding generator sources', async () => {
    const identifierOffenders = await findIdentifierOffenders({
        roots: [
          join(cliSourceRoot, 'daemon', 'spawn'),
          join(cliSourceRoot, 'plugins', 'projection'),
          join(cliSourceRoot, 'providers'),
          join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'src'),
          join(repoRoot, 'packages', 'protocol', 'src', 'providers'),
        ],
        files: [
          join(
            repoRoot,
            'scripts',
            'migrations',
            'extensions',
            'generateBundledPluginEntries.ts',
          ),
        ],
        identifiers: [
          'BundledProviderImplementationBinding',
          'CLIPROXYAPI_MANAGED_CONTRACT_VERSION',
          'CLIPROXYAPI_MANAGED_SDK_VERSION',
          'CliProxyApiManagedAgentEndpointInput',
          'CliProxyApiManagedAuthEntry',
          'CliProxyApiManagedReadiness',
          'CliProxyApiManagedRecoveryHealth',
          'CliProxyApiManagedRuntimeAdapterInput',
          'CliProxyApiManagedRuntimeInput',
          'CliProxyApiManagedRuntimePreparation',
          'CliProxyApiManagedRuntimeRecoveryInput',
          'MANAGED_PROVIDER_IMPLEMENTATION',
          'MANAGED_PROVIDER_RUNTIME_ADAPTER',
          'ManagedProviderEndpointDeclarationV1',
          'ManagedProviderEndpointSecurityFactsV1',
          'ManagedProviderEndpointSecurityFactsV1Schema',
          'ManagedProviderImplementationSource',
          'ManagedProviderLocalServiceDeclarationV1Schema',
          'ManagedProviderRuntimeAdapterInput',
          'ManagedProviderRuntimeAdapterPreparation',
          'ManagedProviderRuntimeAdapterV1',
          'ManagedProviderRuntimeRecoveryCapabilityV1',
          'ManagedProviderRuntimeRecoveryFacts',
          'ManagedProviderRuntimeRecoveryHealthIdentity',
          'PreparedManagedProviderRuntimeAdapter',
          'ProviderManagedCatalogSourceIdentityV1',
          'ProviderManagedDeploymentSecurityFactsV1',
          'ProviderManagedDeploymentSecurityFactsV1Schema',
          'ResolvedConnectedAccountPurposeDeclarationV1',
          'ResolvedFirstPartyManagedProviderFacet',
          'inspectCliProxyApiManagedRuntimeRecovery',
          'inspectManagedProviderRuntimeAdapterRecovery',
          'loadManagedProviderImplementation',
          'managedProviderImplementation',
          'managedRuntimeAdapter',
          'parseCliProxyApiManagedRecoveryHealth',
          'prepareCliProxyApiManagedRuntime',
          'prepareManagedProviderRuntimeAdapter',
          'projectBuiltInProviders',
          'readManagedProviderFacet',
          'readManagedProviderRuntimeAdapter',
          'runtimeAdapter',
          'scanCliProxyApiManagedReadiness',
          'verifyManagedProviderRuntimeRecoveryHealth',
        ],
    });
    expect(identifierOffenders).toEqual([]);
  });

  it('deletes obsolete private prepare, launch, transient, discovery, and recovery owners', async () => {
    const [existingFiles, identifierOffenders] = await Promise.all([
      findExistingProductionFiles([
        'apps/cli/src/daemon/spawn/prepareDaemonManagedProviderBinding.ts',
        'apps/cli/src/daemon/startup/clearPromotedManagedLocalServiceMarkerAttachment.ts',
        'apps/cli/src/plugins/projection/registry/builtIn/providers.ts',
        'apps/cli/src/providers/discovery/managedStart.ts',
        'apps/cli/src/providers/lifecycle/managedEndpointLaunch.ts',
        'apps/cli/src/providers/lifecycle/managedEndpointRecovery.ts',
        'apps/cli/src/providers/lifecycle/managedPurposeBindingAuthorization.ts',
        'apps/cli/src/providers/lifecycle/managedRuntimeAdapterPreparation.ts',
        'apps/cli/src/providers/lifecycle/managedRuntimeAdapterRecovery.ts',
        'apps/cli/src/providers/lifecycle/retainedManagedRuntimeArtifact.ts',
        'apps/cli/src/providers/lifecycle/transientManagedEndpoint.ts',
        'apps/cli/src/providers/managed/types.ts',
        'packages/plugins/cliproxyapi/src/managed.ts',
        'packages/plugins/cliproxyapi/src/provider/managedRuntime.ts',
      ]),
      findIdentifierOffenders({
        roots: [
          join(cliSourceRoot, 'daemon', 'spawn'),
          join(cliSourceRoot, 'daemon', 'startup'),
          join(cliSourceRoot, 'providers', 'discovery'),
          join(cliSourceRoot, 'providers', 'lifecycle'),
        ],
        identifiers: [
          'buildManagedProviderStartRequest',
          'createManagedProviderRequestAuthCapabilityPathBinding',
          'createManagedProviderStart',
          'createProviderManagedLocalServicesExec',
          'createProviderManagedLocalServicesDispatch',
          'DaemonManagedProviderBindingResult',
          'ManagedProviderEndpointLaunchFailure',
          'ManagedProviderEndpointLaunchFailureCode',
          'ManagedProviderEndpointLaunchResult',
          'ManagedProviderEndpointReadiness',
          'ManagedProviderEndpointRecoveryFailureCode',
          'ManagedProviderEndpointRecoveryResult',
          'ManagedProviderRuntimePreparation',
          'ProviderManagedLocalServiceStartRequestV1',
          'ProviderManagedLocalServiceStartResponseV1',
          'ProviderManagedLocalServicesDispatch',
          'ProviderManagedLocalServicesDispatchInput',
          'PROVIDER_MANAGED_LOCAL_SERVICE_ENV_KEYS',
          'TransientManagedProviderEndpointResult',
          'managedPurposeBindingsMatchFacet',
          'prepareDaemonManagedProviderBinding',
          'prepareManagedProviderEndpointLaunch',
          'prepareTransientManagedProviderEndpoint',
          'resolveManagedProviderRuntimeLaunch',
          'selectProviderManagedLocalServicesEnvironment',
          'startAuthorizedManagedProviderRuntime',
          'verifyRetainedManagedProviderRuntimeArtifact',
        ],
      }),
    ]);
    expect({ existingFiles, identifierOffenders }).toEqual({
      existingFiles: [],
      identifierOffenders: [],
    });
  });

  it('requires the public runtime owner and retired predecessor absence in release admission', async () => {
    const releaseAdmissionPath = join(
      repoRoot,
      'scripts',
      'release',
      'qualified-connected-accounts-v4-activation-admission.mjs',
    );
    const releaseAdmission = await import(pathToFileURL(releaseAdmissionPath).href) as {
      QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT?: readonly Readonly<{
        key: string;
        checks: readonly Readonly<{
          path: string;
          content?: string;
          absent?: boolean;
        }>[];
      }>[];
    };
    const rollbackSupport =
      releaseAdmission.QUALIFIED_CONNECTED_ACCOUNTS_V4_ROLLBACK_SUPPORT ?? [];

    expect(rollbackSupport.some(({ key }) => (
      key === 'managedLocalServiceRunAttachment'
    ))).toBe(false);
    const publicRuntime = rollbackSupport.find(({ key }) => (
      key === 'publicManagedProviderRuntime'
    ));
    expect(publicRuntime?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'apps/cli/src/providers/lifecycle/publicManagedProviderRuntimeStart.ts',
      }),
      expect.objectContaining({
        path: 'apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts',
      }),
      {
        path: 'apps/cli/src/providers/lifecycle/managedEndpointRecovery.ts',
        absent: true,
      },
      {
        path: 'apps/cli/src/providers/discovery/managedStart.ts',
        absent: true,
      },
    ]));
  });

  it('retains the public three-reason SVC09 vertical, runner authority, and generic daemon owners', async () => {
    const publicRuntimePath = join(
      repoRoot,
      'packages/plugins/cliproxyapi/src/provider/publicManagedRuntime.ts',
    );
    const publicRuntimeSource = await readFile(publicRuntimePath, 'utf8');
    const publicRuntime = sourceIdentifiers(publicRuntimePath, publicRuntimeSource);
    expectIdentifiers(publicRuntime, [
      'CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME',
      'ManagedProviderRuntime',
      'supervise',
    ]);
    expectCall(sourceCalls(publicRuntimePath, publicRuntimeSource), 'supervise');

    const managedServicesBarrelPath = join(
      repoRoot,
      'packages/plugin-sdk/src/managed-services/index.ts',
    );
    const managedServicesBarrelSource = await readFile(
      managedServicesBarrelPath,
      'utf8',
    );
    expect(sourceExportModuleSpecifiers(
      managedServicesBarrelPath,
      managedServicesBarrelSource,
    )).toEqual(new Set(['./contract.js']));

    const managedServicesContractPath = join(
      repoRoot,
      'packages/plugin-sdk/src/managed-services/contract.ts',
    );
    const managedServicesContract = sourceExportedTypeDeclarationIdentifiers(
      managedServicesContractPath,
      await readFile(managedServicesContractPath, 'utf8'),
    );
    expectIdentifiers(managedServicesContract, [
      'ManagedProviderEndpoint',
      'ManagedProviderRuntime',
      'ManagedServices',
    ]);

    const managedServicesOwner = await readIdentifiers(
      'apps/cli/src/plugins/runtime/invocation/services/managedServicesOwner.ts',
    );
    expectIdentifiers(managedServicesOwner, ['createManagedServicesOwner', 'supervise']);

    const reasonFiles = Object.freeze([
      Object.freeze({
        path: 'apps/cli/src/providers/connections/service/localOperations.ts',
        reason: 'explicitStartLocal',
        call: 'startManagedProviderRuntime',
      }),
      Object.freeze({
        path: 'apps/cli/src/providers/probe/managedRuntime.ts',
        reason: 'catalogProbe',
        call: 'startPublicManagedProviderRuntime',
      }),
      Object.freeze({
        path: 'apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts',
        reason: 'sessionDemand',
        call: 'startPublicManagedProviderRuntime',
      }),
    ]);
    for (const entry of reasonFiles) {
      const path = join(repoRoot, entry.path);
      const source = await readFile(path, 'utf8');
      expect(readReasonPropertyValues(path, source)).toContain(entry.reason);
      expectCall(sourceCalls(path, source), entry.call);
    }

    const explicitStartForwarderPath = join(
      repoRoot,
      'apps/cli/src/providers/connections/publicManagedRuntimeStart.ts',
    );
    const explicitStartForwarderSource = await readFile(
      explicitStartForwarderPath,
      'utf8',
    );
    const explicitStartForwarder = sourceIdentifiers(
      explicitStartForwarderPath,
      explicitStartForwarderSource,
    );
    expectIdentifiers(explicitStartForwarder, [
      'createPublicManagedProviderRuntimeStartOperation',
      'startPublicManagedProviderRuntime',
    ]);
    expectCall(
      sourceCalls(explicitStartForwarderPath, explicitStartForwarderSource),
      'startPublicManagedProviderRuntime',
    );

    const runnerCustodyPath = join(
      repoRoot,
      'apps/cli/src/agent/runtime/session/process/runnerManagedServicesCustody.ts',
    );
    const runnerCustodySource = await readFile(runnerCustodyPath, 'utf8');
    const runnerCustody = sourceIdentifiers(runnerCustodyPath, runnerCustodySource);
    expectIdentifiers(runnerCustody, [
      'RunnerManagedProviderRetainedAuthorityV1',
      'releaseAdoptedProviderAuthority',
      'retainAdoptedProviderAuthority',
    ]);
    const runnerCustodyCalls = sourceCalls(runnerCustodyPath, runnerCustodySource);
    expectCall(runnerCustodyCalls, 'retainAdoptedProviderAuthority');
    expectCall(runnerCustodyCalls, 'releaseAdoptedProviderAuthority');
    const sessionRegistry = await readIdentifiers(
      'apps/cli/src/daemon/sessionRegistry.ts',
    );
    expectIdentifiers(sessionRegistry, [
      'RunnerManagedProviderRetainedAuthorityV1Schema',
      'updateSessionMarkerRunnerManagedProviderAuthority',
    ]);

    const daemonLocalServicesPath = join(
      repoRoot,
      'apps/cli/src/daemon/local/services/runtime.ts',
    );
    const daemonLocalServicesSource = await readFile(daemonLocalServicesPath, 'utf8');
    const daemonLocalServices = sourceIdentifiers(
      daemonLocalServicesPath,
      daemonLocalServicesSource,
    );
    // `managedRoutes` was listed here as a scope fence — "the Provider contraction must not
    // sweep away the generic daemon local-services owners" — never as a product contract for
    // managed local services. The managed local-service runtime was itself removed as a
    // producerless spine (RU2 surfaces finalization, DEC-6), so the fence no longer applies
    // to it; its absence is now asserted by the census below.
    expectIdentifiers(daemonLocalServices, [
      'createLocalServicesDaemonRuntime',
      'launcherRoutes',
      'syncHostedWebStaticAssets',
    ]);
    expect(daemonLocalServices.has('transferTrustedManagedLocalService')).toBe(false);
  });
});
