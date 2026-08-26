import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import {
  AgentRuntimeJsonValueSchema as canonicalAgentRuntimeJsonValueSchema,
  AgentSessionProviderBindingV1Schema as canonicalAgentSessionProviderBindingV1Schema,
  AgentSessionRuntimeEventSchema as canonicalAgentSessionRuntimeEventSchema,
} from '@happier-dev/protocol/runtime';
import {
  createAcpToolNameInferencePreset as canonicalCreateAcpToolNameInferencePreset,
  normalizeAcpPermissionIntent as canonicalNormalizeAcpPermissionIntent,
  resolveAcpToolPermissionPolicy as canonicalResolveAcpToolPermissionPolicy,
} from '@happier-dev/agents/acpPresets';
import type {
  HandoffImportResultV1 as CanonicalHandoffImportResultV1,
  RuntimeOutboundTranscriptToolNormalizationV1 as CanonicalRuntimeOutboundTranscriptToolNormalizationV1,
} from '@happier-dev/agents';
import type {
  AgentSessionProviderBinding as CanonicalAgentSessionProviderBinding,
  ConnectedServicesProviderStateSharingPolicyV1 as CanonicalConnectedServicesProviderStateSharingPolicyV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionRuntimeEvent as CanonicalAgentSessionRuntimeEvent,
} from '@happier-dev/protocol/runtime';

import * as agentRuntimeProjection from './projections.js';
import type {
  AgentSessionRuntimeEvent,
  AgentSessionProviderBinding,
  AgentSessionProviderBindingUpstream,
  ConnectedServicesProviderStateSharingPolicyV1,
  AgentTranscriptSessionEventPublisher,
  ForkAvailabilityRequestV1,
  ForkSessionMetadata,
  ForkSurfaceV1,
  HandoffImportResultV1,
  RuntimeOutboundTranscriptToolNormalizationV1,
} from './projections.js';
import type { AgentTerminalSessionStateUpdate } from './surfaces.js';

function propertyType(
  checker: ts.TypeChecker,
  owner: ts.Type,
  propertyName: string,
): ts.Type | undefined {
  const property = checker.getPropertyOfType(owner, propertyName);
  const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
  return property && declaration
    ? checker.getTypeOfSymbolAtLocation(property, declaration)
    : undefined;
}

function runtimeEventPayloadTypeOwner(
  program: ts.Program,
  schemaExportName: 'AgentSessionRuntimeEventSchema',
): string {
  const checker = program.getTypeChecker();
  const schemaSymbol = moduleExports(program, 'src/agentRuntime/projections.ts')
    .find((candidate) => candidate.name === schemaExportName);
  const declaration = schemaSymbol?.valueDeclaration ?? schemaSymbol?.declarations?.[0];
  if (!schemaSymbol || !declaration) throw new Error(`Missing ${schemaExportName}`);
  const schemaType = checker.getTypeOfSymbolAtLocation(schemaSymbol, declaration);
  const parseType = propertyType(checker, schemaType, 'parse');
  const parseSignature = parseType === undefined
    ? undefined
    : checker.getSignaturesOfType(parseType, ts.SignatureKind.Call)[0];
  const eventType = parseSignature === undefined
    ? undefined
    : checker.getReturnTypeOfSignature(parseSignature);
  if (!eventType) throw new Error(`Missing ${schemaExportName} output type`);
  const toolCallType = eventType.isUnion()
    ? eventType.types.find((candidate) => {
      const kindType = propertyType(checker, candidate, 'kind');
      return kindType !== undefined && checker.typeToString(kindType) === '"tool-call"';
    })
    : undefined;
  const inputType = toolCallType && propertyType(checker, toolCallType, 'input');
  const owner = inputType?.aliasSymbol?.declarations?.[0]?.getSourceFile().fileName;
  if (!owner) throw new Error(`Missing ${schemaExportName} tool-call input type owner`);
  return owner;
}

const APPROVED_VALUE_ONLY_EXPORTS = [
  'ACP_AGENT_CLI_TRANSPORT_TIMEOUTS',
  'ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES',
  'ACP_WRITE_LIKE_PERMISSION_KINDS',
  'createExecutionRunHostBackendFromSessionRuntime',
] as const;

const DECLARATION_CLOSURE_GENUINE_EXPORTS = [
  'AcpForkSessionRequestV1',
  'AcpForkSessionResultV1',
  'AcpLoadSessionRequestV1',
  'AcpLoadSessionResultV1',
  'AgentProviderBindingLaunchMaterializationV1',
  'AttachSurfaceStaticMetadataV1',
  'CheckpointAvailabilityRequestV1',
  'CheckpointAvailabilityOperationV1',
  'CheckpointDescriptorV1',
  'CheckpointProviderTargetRefV1',
  'CheckpointRestoreAnchorEvidenceV1',
  'CheckpointRestoreAnchorV1',
  'CheckpointRestoreScopeV1',
  'CheckpointTimingV1',
  'CreateCheckpointRequestV1',
  'ListCheckpointsRequestV1',
  'ProviderBindingCanonicalJsonValue',
  'RecoverableTurnFailurePromptMode',
  'RecoverableTurnFailureSecondFailureDecision',
  'ResolveCheckpointRestoreTargetRequestV1',
  'RestoreCheckpointFailureCodeV1',
  'RestoreCheckpointByAnchorRequestV1',
  'RestoreCheckpointByTargetRequestV1',
  'RestoreCheckpointRequestV1',
  'ShellCommandDialect',
] as const;

const DECLARATION_REFINED_EXPORTS = new Set([
  'AcpForkSessionResultV1',
  'AcpLoadSessionResultV1',
  'AcpSessionOperationsV1',
  'AgentRuntimeJsonValueSchema',
  'AgentAuthorRestoreCheckpointResult',
  'AgentTerminalSessionIdentityFieldId',
  'AgentTerminalSessionStateUpdate',
  'AgentSessionProviderBindingV1Schema',
  'AgentSessionRuntimeEventSchema',
  'AttachSessionMetadata',
  'AttachAvailabilityRequest',
  'AttachFailureCode',
  'AttachRequest',
  'AttachSurface',
  'BackendSessionLaunchHintsV1',
  'BackendSurfaceOperationReceiptV1',
  'BackendSurfaceResultV1',
  'CheckpointSurface',
  'ForkAvailabilityRequestV1',
  'ForkRequestV1',
  'ForkResultV1',
  'ForkSessionMetadata',
  'ForkSurfaceV1',
  'HandoffAvailabilityRequestV1',
  'HandoffExportRequestV1',
  'HandoffExportSessionMetadata',
  'HandoffImportResultV1',
  'HandoffMediaScannableRecordsRequestV1',
  'HandoffNativeTranscriptPathCandidateRequestV1',
  'HandoffNativeTranscriptPathCandidateV1',
  'HandoffRuntimeDescriptorV1',
  'HandoffRuntimeLocalExternalSessionSourceV1',
  'HandoffRuntimeLocalMetadataIdentityV1',
  'HandoffRuntimeLocalMetadataRequestV1',
  'HandoffRuntimeLocalMetadataV1',
  'HandoffSurfaceV1',
  'ReplayForkChildLaunchRequestV1',
  'RuntimeOutboundTranscriptToolNormalizationV1',
  'createAcpToolNameInferencePreset',
  'normalizeAcpPermissionIntent',
  'resolveAcpToolPermissionPolicy',
]);

const TESTING_OWNED_EXPORTS = new Set([
  'AgentSessionRuntimeEventKind',
]);

const DAEMON_SEPARATED_EXPORTS = new Set([
  'resolveTerminalPromptWriteTimeoutMs',
]);

const PORTABLE_PROTOCOL_RUNTIME_EXPORTS = new Set([
  'AgentProviderBindingMaterializationV1Schema',
  'AgentRuntimeJsonValueSchema',
  'AgentSessionProviderBindingV1Schema',
  'AgentSessionRealtimeStartRequestV1',
  'AgentSessionRealtimeStartRequestV1Schema',
  'AgentSessionRealtimeStartResultV1Schema',
  'AgentSessionRuntimeEventSchema',
  'SessionContextUsageSnapshotV1',
  'SessionContextUsageSnapshotV1Schema',
  'UsageObservationContext',
  'UsageObservationContextSchema',
  'UsageObservationCost',
  'UsageObservationCostSchema',
  'UsageObservationScope',
  'UsageObservationScopeSchema',
  'UsageObservationTokens',
  'UsageObservationTokensSchema',
]);

const INDEX_PORTABLE_PROTOCOL_RUNTIME_EXPORTS = new Set([
  ...PORTABLE_PROTOCOL_RUNTIME_EXPORTS,
  'SkillCatalogItemV1',
  'SkillCatalogV1',
  'VendorPluginCatalogItemV1',
  'VendorPluginCatalogV1',
]);

function createSdkProgram(): ts.Program {
  const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`Unable to parse ${configPath}`);
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
}

function sourceFile(program: ts.Program, relativePath: string): ts.SourceFile {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  const source = program.getSourceFile(`${packageRoot}/${relativePath}`);
  if (!source) throw new Error(`Missing source module: ${relativePath}`);
  return source;
}

function moduleExports(program: ts.Program, relativePath: string): readonly ts.Symbol[] {
  const source = sourceFile(program, relativePath);
  const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
  return program.getTypeChecker().getExportsOfModule(moduleSymbol);
}

function canonicalSymbol(program: ts.Program, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? program.getTypeChecker().getAliasedSymbol(symbol)
    : symbol;
}

function exportedSymbol(
  program: ts.Program,
  relativePath: string,
  exportName: string,
): ts.Symbol {
  const symbol = moduleExports(program, relativePath)
    .find((candidate) => candidate.name === exportName);
  if (!symbol) throw new Error(`Missing ${exportName} from ${relativePath}`);
  return canonicalSymbol(program, symbol);
}

function ownerSymbol(
  program: ts.Program,
  specifier: string,
  exportName: string,
): ts.Symbol {
  const containingFile = sourceFile(program, 'src/agentRuntime/projections.ts').fileName;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (!resolved) {
    throw new Error(`Unable to resolve ${specifier} from src/agentRuntime/projections.ts`);
  }
  const ownerSource = program.getSourceFile(resolved.resolvedFileName);
  if (!ownerSource) throw new Error(`Missing resolved source for ${specifier}`);
  const ownerModule = program.getTypeChecker().getSymbolAtLocation(ownerSource);
  if (!ownerModule) throw new Error(`Missing module symbol for ${specifier}`);
  const symbol = program.getTypeChecker().getExportsOfModule(ownerModule)
    .find((candidate) => candidate.name === exportName);
  if (!symbol) throw new Error(`Missing ${exportName} from ${specifier}`);
  return canonicalSymbol(program, symbol);
}

function directNamedExports(source: string): readonly Readonly<{
  name: string;
  ownerName: string;
  specifier: string;
}>[] {
  const parsed = ts.createSourceFile(
    'projections.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return parsed.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) {
      return [];
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    return statement.exportClause.elements.map((element) => ({
      name: element.name.text,
      ownerName: element.propertyName?.text ?? element.name.text,
      specifier: moduleSpecifier,
    }));
  });
}

function namedExportsFromSpecifier(
  source: string,
  specifier: string,
): readonly string[] {
  const parsed = ts.createSourceFile(
    'projection-owner.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return parsed.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) {
      return [];
    }
    return statement.exportClause.elements.map((element) => element.name.text);
  });
}

async function approvedExportNames(): Promise<readonly string[]> {
  const contractSource = await readFile(
    new URL('../agents.finalProjection.contract.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'agents.finalProjection.contract.ts',
    contractSource,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const contractImport = parsed.statements.find((statement): statement is ts.ImportDeclaration => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === './agentRuntime/index.js'
    && !!statement.importClause?.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.length > 20
  ));
  if (!contractImport?.importClause?.namedBindings
    || !ts.isNamedImports(contractImport.importClause.namedBindings)) {
    throw new Error('Missing the approved Agent runtime projection contract import');
  }
  const names = [
    ...contractImport.importClause.namedBindings.elements
      .map((element) => element.name.text)
      .filter((name) => (
        !TESTING_OWNED_EXPORTS.has(name)
        && !DAEMON_SEPARATED_EXPORTS.has(name)
      )),
    ...APPROVED_VALUE_ONLY_EXPORTS,
    ...DECLARATION_CLOSURE_GENUINE_EXPORTS,
  ].sort();
  expect(new Set(names).size).toBe(names.length);
  return names;
}

describe('Agent runtime package-local publication projection', () => {
  it('contains exactly the approved shared-realm projection and its genuine declaration closure', async () => {
    const program = createSdkProgram();
    expect(moduleExports(program, 'src/agentRuntime/projections.ts')
      .map((symbol) => symbol.name)
      .sort()).toEqual(await approvedExportNames());
  }, 120_000);

  it('publishes the Provider binding schema through the approved versioned materialization identity', async () => {
    const source = await readFile(new URL('./projections.ts', import.meta.url), 'utf8');

    expect(source).toContain('AgentProviderBindingLaunchMaterializationV1');
    expect(source).toMatch(/export const AgentSessionProviderBindingV1Schema:/u);
    expect(source).not.toMatch(
      /export\s*\{[^}]*AgentSessionProviderBindingV1Schema[^}]*\}\s*from/u,
    );
  });

  it('keeps the Node-only prompt timeout on its existing daemon source', () => {
    const program = createSdkProgram();

    expect(exportedSymbol(program, 'src/agentRuntime/index.ts', 'resolveTerminalPromptWriteTimeoutMs'))
      .toBe(exportedSymbol(program, 'src/runtime/promptWriteTimeout.ts', 'resolveTerminalPromptWriteTimeoutMs'));
    expect(moduleExports(program, 'src/agentRuntime/projections.ts')
      .some((symbol) => symbol.name === 'resolveTerminalPromptWriteTimeoutMs')).toBe(false);
  }, 120_000);

  it('directly aliases every final name to its canonical owner', async () => {
    const program = createSdkProgram();
    const source = await readFile(new URL('./projections.ts', import.meta.url), 'utf8');
    const directExports = directNamedExports(source);

    expect(directExports.map((entry) => entry.name).sort())
      .toEqual((await approvedExportNames()).filter((name) => !DECLARATION_REFINED_EXPORTS.has(name)));
    for (const entry of directExports) {
      expect(exportedSymbol(program, 'src/agentRuntime/projections.ts', entry.name)).toBe(
        ownerSymbol(program, entry.specifier, entry.ownerName),
      );
    }
  }, 120_000);

  it('projects the canonical Agent runtime event through a declaration-neutral SDK type', () => {
    const program = createSdkProgram();

    expect(exportedSymbol(program, 'src/agentRuntime/session.ts', 'AgentSessionRuntimeEvent')).not.toBe(
      ownerSymbol(program, '@happier-dev/protocol/runtime', 'AgentSessionRuntimeEvent'),
    );
    expectTypeOf<AgentSessionRuntimeEvent>()
      .toMatchTypeOf<CanonicalAgentSessionRuntimeEvent>();
    expectTypeOf<CanonicalAgentSessionRuntimeEvent>()
      .toMatchTypeOf<AgentSessionRuntimeEvent>();
  }, 120_000);

  it('refines helper-only signatures without changing canonical runtime values or public shapes', () => {
    expect(agentRuntimeProjection.createAcpToolNameInferencePreset)
      .toBe(canonicalCreateAcpToolNameInferencePreset);
    expect(agentRuntimeProjection.normalizeAcpPermissionIntent)
      .toBe(canonicalNormalizeAcpPermissionIntent);
    expect(agentRuntimeProjection.resolveAcpToolPermissionPolicy)
      .toBe(canonicalResolveAcpToolPermissionPolicy);
    expect(agentRuntimeProjection.AgentRuntimeJsonValueSchema)
      .toBe(canonicalAgentRuntimeJsonValueSchema);
    expect(agentRuntimeProjection.AgentSessionProviderBindingV1Schema)
      .toBe(canonicalAgentSessionProviderBindingV1Schema);
    expect(agentRuntimeProjection.AgentSessionRuntimeEventSchema)
      .toBe(canonicalAgentSessionRuntimeEventSchema);
    expectTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionProviderBindingV1Schema.parse>>()
      .toEqualTypeOf<AgentSessionProviderBinding>();
    // The author declarations are structural copies so an emitted external
    // closure never names the private Protocol package. They must stay exactly
    // interchangeable with the canonical owners in both directions. The SDK
    // copy is deliberately `Readonly`, which is the one difference this
    // equality tolerates: every member name, optionality and literal member
    // still has to match the settings owner exactly.
    expectTypeOf<ConnectedServicesProviderStateSharingPolicyV1>()
      .toEqualTypeOf<Readonly<CanonicalConnectedServicesProviderStateSharingPolicyV1>>();
    expectTypeOf<AgentSessionProviderBindingUpstream>()
      .toMatchTypeOf<CanonicalAgentSessionProviderBinding['upstream']>();
    expectTypeOf<CanonicalAgentSessionProviderBinding['upstream']>()
      .toMatchTypeOf<AgentSessionProviderBindingUpstream>();
    expectTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionRuntimeEventSchema.parse>>()
      .toMatchTypeOf<AgentSessionRuntimeEvent>();
    expectTypeOf<AgentSessionRuntimeEvent>()
      .toMatchTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionRuntimeEventSchema.parse>>();
    expectTypeOf<CanonicalAgentSessionProviderBinding>()
      .toMatchTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionProviderBindingV1Schema.parse>>();
    expectTypeOf<CanonicalAgentSessionRuntimeEvent>()
      .toMatchTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionRuntimeEventSchema.parse>>();
    expectTypeOf<AgentSessionRuntimeEvent>()
      .toMatchTypeOf<ReturnType<typeof agentRuntimeProjection.AgentSessionRuntimeEventSchema.parse>>();
    expectTypeOf<ForkAvailabilityRequestV1['parentMetadata']>()
      .toEqualTypeOf<ForkSessionMetadata>();
    expectTypeOf<Parameters<NonNullable<ForkSurfaceV1['evaluateAvailability']>>[0]['parentMetadata']>()
      .toEqualTypeOf<ForkSessionMetadata>();
    expectTypeOf<RuntimeOutboundTranscriptToolNormalizationV1>()
      .toEqualTypeOf<CanonicalRuntimeOutboundTranscriptToolNormalizationV1>();
    expectTypeOf<AgentTerminalSessionStateUpdate['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
    expectTypeOf<Extract<
      AgentTerminalSessionStateUpdate,
      Readonly<{ fieldId: 'identity.runtimeDescriptor' }>
    >['value']>().toEqualTypeOf<RuntimeDescriptorV1>();
    expectTypeOf<NonNullable<HandoffImportResultV1['launch']['sessionStateUpdates']>[number]['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
    expectTypeOf<HandoffImportResultV1>()
      .toMatchTypeOf<CanonicalHandoffImportResultV1>();
  });

  it('owns terminal runtime-descriptor and handoff-import declaration closure in the SDK', async () => {
    const [surfaceSource, projectionSource] = await Promise.all([
      readFile(new URL('./surfaces.ts', import.meta.url), 'utf8'),
      readFile(new URL('./projections.ts', import.meta.url), 'utf8'),
    ]);

    expect(surfaceSource).not.toMatch(/\bRuntimeDescriptorV1\b/u);
    expect(directNamedExports(projectionSource)
      .some((entry) => entry.name === 'HandoffImportResultV1')).toBe(false);
    expect(projectionSource).toMatch(/export type HandoffImportResultV1\s*=\s*Readonly</u);
  });

  it('owns every author-written Agent Session-state result declaration once across both SDK barrels', () => {
    const program = createSdkProgram();
    const declarationNames = [
      'AgentAuthorRestoreCheckpointResult',
      'AgentTerminalSessionStateUpdate',
      'AttachAvailabilityRequest',
      'AttachFailureCode',
      'AttachRequest',
      'BackendSurfaceOperationReceiptV1',
      'BackendSurfaceResultV1',
      'AttachSurface',
      'CheckpointSurface',
      'ForkSurfaceV1',
      'HandoffSurfaceV1',
    ] as const;

    for (const name of declarationNames) {
      const owner = exportedSymbol(program, 'src/agentRuntime/projections.ts', name);
      expect(exportedSymbol(program, 'src/agentRuntime/index.ts', name), name).toBe(owner);
      expect(exportedSymbol(program, 'src/agents/runtime/index.ts', name), name).toBe(owner);
      expect(
        owner.declarations?.some((declaration) => declaration.getSourceFile().fileName.endsWith(
          '/packages/plugin-sdk/src/agentRuntime/projections.ts',
        )),
        name,
      ).toBe(true);
    }
  }, 120_000);

  it('keeps runtime-event schema public output declarations on the SDK strict-JSON projection', () => {
    const program = createSdkProgram();

    for (const schemaName of ['AgentSessionRuntimeEventSchema'] as const) {
      // The SDK declares strict JSON exactly once, at the public `/protocol`
      // facade; `identity.ts` only republishes that declaration as `JsonValue`.
      const owner = runtimeEventPayloadTypeOwner(program, schemaName);
      expect(owner).toMatch(/packages\/plugin-sdk\/src\/protocol\/protocolFacade\.ts$/u);
      expect(owner).not.toMatch(/[\\/]@happier-dev[\\/]protocol[\\/]/u);
    }
  }, 120_000);

  it('routes portable Protocol runtime schemas and types through the narrow runtime owner', async () => {
    const [projectionSource, indexSource] = await Promise.all([
      readFile(new URL('./projections.ts', import.meta.url), 'utf8'),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);
    const directExports = directNamedExports(projectionSource);
    const runtimeExports = directExports.filter((entry) =>
      PORTABLE_PROTOCOL_RUNTIME_EXPORTS.has(entry.name));
    const directlyOwnedRuntimeExports = [...PORTABLE_PROTOCOL_RUNTIME_EXPORTS]
      .filter((name) => !DECLARATION_REFINED_EXPORTS.has(name));

    expect(runtimeExports.map((entry) => entry.name).sort())
      .toEqual(directlyOwnedRuntimeExports.sort());
    expect(new Set(runtimeExports.map((entry) => entry.specifier)))
      .toEqual(new Set(['@happier-dev/protocol/runtime']));
    expect([...namedExportsFromSpecifier(indexSource, '@happier-dev/protocol/runtime')].sort())
      .toEqual([...INDEX_PORTABLE_PROTOCOL_RUNTIME_EXPORTS].sort());
  });

  it('does not publish broad-barrel or host-private Agent lifecycle details', async () => {
    const program = createSdkProgram();
    const names = new Set(
      moduleExports(program, 'src/agentRuntime/projections.ts').map((symbol) => symbol.name),
    );
    const publicRuntimeNames = new Set(
      moduleExports(program, 'src/agents/runtime/index.ts').map((symbol) => symbol.name),
    );
    const publicRuntimeSpecNames = new Set(
      moduleExports(program, 'src/agents/runtime/index.public.ts').map((symbol) => symbol.name),
    );
    const internalBarrelNames = new Set(
      moduleExports(program, 'src/agentRuntime/index.ts').map((symbol) => symbol.name),
    );
    const contextNames = new Set(
      moduleExports(program, 'src/agentRuntime/context.ts').map((symbol) => symbol.name),
    );
    expect(names.has('AgentRuntimeBase')).toBe(false);
    expect(names.has('AgentSessionConversationRollbackReconciliationRequest')).toBe(false);
    expect(names.has('AgentSessionSystemRecordsService')).toBe(false);
    expect(names.has('HostDeclarativeAcpRunnerBinding')).toBe(false);
    expect(names.has('AgentRuntimeExecutionGrant')).toBe(false);
    expect(names.has('RuntimeEventV1')).toBe(false);
    expect(publicRuntimeNames.has('RuntimeEventV1')).toBe(false);
    expect(names.has('RuntimeOutboundTranscriptDispatchInputV1')).toBe(false);
    expect(names.has('RuntimeOutboundTranscriptPostSendEffectV1')).toBe(false);
    expect(names.has('resolveMetadataStringOverrideV1')).toBe(false);
    expect(names.has('buildEncodedPowerShellCommand')).toBe(false);
    expect(publicRuntimeSpecNames.has('buildEncodedPowerShellCommand')).toBe(false);
    expect(internalBarrelNames.has('buildEncodedPowerShellCommand')).toBe(false);
    expect(contextNames.has('AgentTranscriptSourceFactConsumedRequest')).toBe(false);
    expectTypeOf<
      Parameters<NonNullable<AgentTranscriptSessionEventPublisher['markSourceFactConsumed']>>[0]
    >().toEqualTypeOf<Readonly<{
      localId: string;
      reason: 'host_prompt_echo';
    }>>();
  }, 120_000);

  it('leaves the runtime event kind exclusively on /testing', () => {
    const program = createSdkProgram();
    const projectionNames = new Set(
      moduleExports(program, 'src/agentRuntime/projections.ts').map((symbol) => symbol.name),
    );
    const barrelNames = new Set(
      moduleExports(program, 'src/agentRuntime/index.ts').map((symbol) => symbol.name),
    );
    const testingNames = new Set(
      moduleExports(program, 'src/testing/index.ts').map((symbol) => symbol.name),
    );

    expect(projectionNames.has('AgentSessionRuntimeEventKind')).toBe(false);
    expect(barrelNames.has('AgentSessionRuntimeEventKind')).toBe(false);
    expect(testingNames.has('AgentSessionRuntimeEventKind')).toBe(true);
  }, 120_000);
});
