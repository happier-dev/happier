import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type InventoryFile } from './migrationTypes.ts';
import {
  buildV2ZeroInventoryReportEntries,
  type V2ZeroInventoryReport,
} from './v2ZeroInventory.ts';

export interface V2ZeroInventoryEnforcementBaseline {
  maxAllowedCounts: Readonly<Record<string, number>>;
}

export interface V2ZeroInventoryEnforcementResult {
  ok: boolean;
  errors: readonly string[];
}

const FIXED_AGENT_BACKEND_RETIREMENT_OPERATIONS = [
  'startSession',
  'loadSession',
  'loadSessionWithReplayCapture',
  'sendPrompt',
  'sendSteerPrompt',
  'cancel',
  'onMessage',
  'offMessage',
  'respondToPermission',
  'waitForResponseComplete',
  'dispose',
] as const;
const LOAD_RUN_IDENTIFIER_PATTERN = /\bloadRun\b/;
const EXECUTION_RUN_INTENT_OWNER_FENCE_ALLOWLIST = [
  /^apps\/cli\/src\/agent\/executionRuns\/profiles\//,
  /^apps\/cli\/src\/agent\/executionRuns\/policy\//,
  /^apps\/cli\/src\/agent\/executionRuns\/policy\/executionRunPermissionInteractionPolicy\.ts$/,
  /^apps\/cli\/src\/agent\/executionRuns\/policy\/intentPolicyRegistry\.ts$/,
  /^apps\/cli\/src\/agent\/executionRuns\/runtime\/executionRunApplyAction\.ts$/,
  /^apps\/cli\/src\/agent\/executionRuns\/runtime\/voiceAgentTurnStreams\.ts$/,
  /^apps\/cli\/src\/agent\/executionRuns\/runtime\/executionRunManager\/ensureExecutionRun\.ts$/,
  /^apps\/cli\/src\/agent\/executionRuns\/runtime\/executionRunManager\/startExecutionRun\.ts$/,
  /^apps\/cli\/src\/rpc\/handlers\/executionRuns\.ts$/,
  /^apps\/cli\/src\/session\/services\/executionRunStartDefaults\.ts$/,
] as const;
const EXECUTION_RUN_INTENT_BRANCH_FILE_SCOPE = [
  /^apps\/cli\/src\/agent\/executionRuns\//,
  /^apps\/cli\/src\/rpc\/handlers\/executionRuns\.ts$/,
  /^apps\/cli\/src\/session\/services\/executionRunStartDefaults\.ts$/,
] as const;
const EXECUTION_RUN_INTENT_LITERAL_PATTERN = /['"`](?:review|plan|delegate|voice_agent|memory_hints)['"`]/;
const EXECUTION_RUN_INTENT_BRANCH_PATTERN = new RegExp([
  String.raw`\bif\s*\([^)]*\b(?:run\.intent|args\.params\.intent|parsed\.data\.intent|params\.intent|intent)\b[^)]*`,
  String.raw`['"\`](?:review|plan|delegate|voice_agent|memory_hints)['"\`][^)]*\)`,
  '|',
  String.raw`\bswitch\s*\(\s*(?:run\.intent|args\.params\.intent|parsed\.data\.intent|params\.intent|intent)\s*\)`,
].join(''));

function stripCommentsOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

export function loadV2ZeroInventoryEnforcementBaseline(params: Readonly<{
  rootDir: string;
  baselinePath: string;
}>): V2ZeroInventoryEnforcementBaseline {
  const absolutePath = resolve(params.rootDir, params.baselinePath);
  const raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
  assert.ok(raw && typeof raw === 'object', 'baseline must be an object');

  const record = raw as Partial<V2ZeroInventoryEnforcementBaseline>;
  assert.ok(record.maxAllowedCounts && typeof record.maxAllowedCounts === 'object', 'baseline.maxAllowedCounts must exist');

  for (const [key, value] of Object.entries(record.maxAllowedCounts)) {
    assert.ok(typeof value === 'number' && Number.isFinite(value), `baseline.maxAllowedCounts[${key}] must be a finite number`);
  }

  return { maxAllowedCounts: record.maxAllowedCounts };
}

export function enforceV2ZeroInventoryBaseline(report: V2ZeroInventoryReport, baseline: V2ZeroInventoryEnforcementBaseline): V2ZeroInventoryEnforcementResult {
  const actualCounts = new Map(report.categories.map((category) => [category.id, category.count] as const));
  const errors: string[] = [];

  for (const categoryId of actualCounts.keys()) {
    if (!(categoryId in baseline.maxAllowedCounts)) {
      errors.push(`- ${categoryId}: missing from baseline maxAllowedCounts`);
    }
  }

  for (const [categoryId, maxAllowed] of Object.entries(baseline.maxAllowedCounts)) {
    const actual = actualCounts.get(categoryId) ?? 0;
    if (actual > maxAllowed) {
      errors.push(`- ${categoryId}: ${actual} > maxAllowed ${maxAllowed}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function enforceExecutionRunBackendRegistryImportAllowlist(files: readonly InventoryFile[]): V2ZeroInventoryEnforcementResult {
  const importPattern = /\bfrom\s+['"][^'"]*executionRunBackendRegistry[^'"]*['"]/;
  const allowed = new Set<string>([
    'apps/cli/src/agent/runtime/registry/createCliBindings.ts',
    'apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts',
  ]);

  const offenders = files
    .filter((file) => importPattern.test(file.content))
    .map((file) => file.filePath)
    .filter((filePath) => !allowed.has(filePath))
    .sort((left, right) => left.localeCompare(right));

  const errors: string[] = [];
  if (offenders.length > 0) {
    errors.push(
      '- executionRunBackendRegistry import must remain compatibility-only and stay within the allowlist:',
      ...offenders.map((filePath) => `  - ${filePath}`),
    );
  }

  // Stop-the-line: the legacy execution-run backend registry must remain review-engine-only.
  //
  // Concrete enforcement: the REGISTRY object literal must remain empty; review engines are added
  // via the listNativeReviewEngineDescriptors() loop in the module.
  const registryFile = files.find((file) =>
    file.filePath === 'apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts'
  );
  if (registryFile) {
    const match = /const\s+REGISTRY\s*:[^=]*=\s*\{([\s\S]*?)\n\};/m.exec(registryFile.content);
    if (match) {
      const raw = match[1] ?? '';
      const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
      const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
      if (withoutLineComments.trim().length > 0) {
        errors.push(
          '- executionRunBackendRegistry must not define inline descriptors (review engines are the only allowed entries):',
          '  - apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts',
        );
      }
    }
  }

  if (errors.length === 0) {
    return { ok: true, errors: [] };
  }

  return { ok: false, errors };
}

export function enforceRuntimeCoreSessionCommandRoutingNoLoadRun(files: readonly InventoryFile[]): V2ZeroInventoryEnforcementResult {
  // A backend with a `getRuntimeCore()` binding must not keep a parallel session-routing truth via `loadRun`.
  //
  // This is a stop-the-line guardrail: session entrypoints must flow through SessionHostBridge ->
  // EngineRegistry -> runtimeCore.createSessionRuntime(...), so the shared seam stays operational.
  const runtimeCoreBackends = new Set<string>();

  for (const file of files) {
    const match = /^apps\/cli\/src\/backends\/([^/]+)\/index\.ts$/.exec(file.filePath);
    if (!match) {
      continue;
    }

    const backendId = match[1];
    const codeText = stripCommentsOnly(file.content);
    if (/\bgetRuntimeCore\b/.test(codeText)) {
      runtimeCoreBackends.add(backendId);
    }
  }

  // Explicit compatibility-only exceptions (must remain rare and documented in the umbrella plan).
  const allowlistedCommandFiles = new Set<string>([]);
  const allowlistedLoadRunCallsites = new Set<string>([]);

  const errors: string[] = [];
  const helperIndirectedLoadRunFiles = files
    .filter((file) => isProductionTypeScriptFile(file.filePath))
    .filter((file) => !allowlistedLoadRunCallsites.has(file.filePath))
    .filter((file) => !isBackendSessionCommandFile(file.filePath))
    .filter((file) => LOAD_RUN_IDENTIFIER_PATTERN.test(stripCommentsOnly(file.content)))
    .map((file) => file.filePath)
    .sort((left, right) => left.localeCompare(right));

  for (const filePath of helperIndirectedLoadRunFiles) {
    errors.push(`- runtimeCore-backed session routing must not retain helper-indirected loadRun routing: ${filePath}`);
  }

  const hiddenLoadRunCallsites = files
    .filter((file) => isProductionTypeScriptFile(file.filePath))
    .filter((file) => !allowlistedLoadRunCallsites.has(file.filePath))
    .filter((file) => {
      const codeText = stripCommentsOnly(file.content);
      return /\brunBackendSessionCliCommand\s*\(\s*\{/.test(codeText) && LOAD_RUN_IDENTIFIER_PATTERN.test(codeText);
    })
    .map((file) => file.filePath)
    .sort((left, right) => left.localeCompare(right));

  for (const filePath of hiddenLoadRunCallsites) {
    errors.push(`- session routing must not hide loadRun behind runBackendSessionCliCommand callsites: ${filePath}`);
  }

  for (const backendId of Array.from(runtimeCoreBackends).sort((left, right) => left.localeCompare(right))) {
    const commandFilePath = `apps/cli/src/backends/${backendId}/cli/command.ts`;
    if (allowlistedCommandFiles.has(commandFilePath)) {
      continue;
    }

    const commandFile = files.find((file) => file.filePath === commandFilePath);
    if (!commandFile) {
      continue;
    }

    const codeText = stripCommentsOnly(commandFile.content);
    if (/\bloadRun\b/.test(codeText)) {
      errors.push(`- runtimeCore backend session command must not use loadRun: ${commandFilePath}`);
      continue;
    }

    if (!/\bbackendIdForSessionRuntime\b/.test(codeText)) {
      errors.push(`- runtimeCore backend session command must declare backendIdForSessionRuntime: ${commandFilePath}`);
      continue;
    }

    const expectedIdPattern = new RegExp(`\\bbackendIdForSessionRuntime\\s*:\\s*['"]${backendId}['"]`);
    if (!expectedIdPattern.test(codeText)) {
      errors.push(`- backendIdForSessionRuntime must match backend folder id "${backendId}": ${commandFilePath}`);
    }
  }

  if (errors.length === 0) {
    return { ok: true, errors: [] };
  }

  return { ok: false, errors };
}

const SHARED_D3_RUNTIME_FOR_LOOP_RETIREMENT_ALLOWLIST = new Set<string>([
  'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
]);

const ACP_SHARED_SESSION_COMPATIBILITY_ALLOWLIST = new Set<string>([
  'apps/cli/src/agent/acp/catalog/builtIn/run.ts',
  'apps/cli/src/agent/acp/catalog/builtIn/sessionPlan.ts',
  'apps/cli/src/agent/acp/catalog/configured/sessionPlan.ts',
  'apps/cli/src/agent/acp/catalog/configured/runConfiguredAcpBackend.ts',
  'apps/cli/src/agent/acp/catalog/configured/startupOverrides.ts',
  'apps/cli/src/agent/acp/runtime/definition/runtimeCore.ts',
]);

function isProductionTypeScriptFile(filePath: string): boolean {
  return filePath.startsWith('apps/cli/src/')
    && /\.(?:[cm]?tsx?)$/.test(filePath)
    && !/\.(?:test|spec)\.tsx?$/.test(filePath);
}

function isBackendSessionCommandFile(filePath: string): boolean {
  return /^apps\/cli\/src\/backends\/[^/]+\/cli\/command\.ts$/.test(filePath);
}

function isSharedRuntimeGovernanceTestFile(filePath: string): boolean {
  return filePath.startsWith('apps/cli/src/agent/runtime/')
    && /\.(?:test|spec)\.tsx?$/.test(filePath);
}

export function enforceSharedRuntimeForLoopCompatibilityRetirement(
  files: readonly InventoryFile[],
): V2ZeroInventoryEnforcementResult {
  const errors: string[] = [];

  for (const file of files) {
    if (!file.filePath.startsWith('apps/cli/src/agent/runtime/')) {
      continue;
    }
    if (SHARED_D3_RUNTIME_FOR_LOOP_RETIREMENT_ALLOWLIST.has(file.filePath) || isSharedRuntimeGovernanceTestFile(file.filePath)) {
      continue;
    }

    const codeText = stripCommentsOnly(file.content);
    const hasCompatibilityType = /\bRuntimeForLoopCompatibility\b/.test(codeText);
    const hasCompatibilityAdapter = /\bcreateRuntimeTurnOperationsFromRuntimeForLoop\b/.test(codeText);

    if (!hasCompatibilityType && !hasCompatibilityAdapter) {
      continue;
    }

    const survivingSymbols = [
      ...(hasCompatibilityType ? ['RuntimeForLoopCompatibility'] : []),
      ...(hasCompatibilityAdapter ? ['createRuntimeTurnOperationsFromRuntimeForLoop'] : []),
    ];
    errors.push(
      `- shared D3 closure is blocked by retired runtime compatibility symbols in ${file.filePath}: ${survivingSymbols.join(', ')}`,
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function enforceSharedSessionCanonicalPlanBoundary(
  files: readonly InventoryFile[],
): V2ZeroInventoryEnforcementResult {
  const errors: string[] = [];
  const sessionBridgeContract = files.find((file) =>
    file.filePath === 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts'
  );
  const sessionHostBridge = files.find((file) =>
    file.filePath === 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts'
  );
  const hostSessionRuntime = files.find((file) =>
    file.filePath === 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts'
  );

  if (!sessionBridgeContract) {
    errors.push('- missing governance source file: apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts');
  }
  if (!sessionHostBridge) {
    errors.push('- missing governance source file: apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts');
  }
  if (!hostSessionRuntime) {
    errors.push('- missing governance source file: apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const contractText = stripCommentsOnly(sessionBridgeContract!.content);
  if (!/\bcreateSessionRuntime\s*\([^)]*\)\s*:\s*Promise<HostSessionRuntimePlan>/.test(contractText)) {
    errors.push(
      '- SessionHostBridge contract must expose createSessionRuntime(...) as Promise<HostSessionRuntimePlan>:',
      `  - ${sessionBridgeContract!.filePath}`,
    );
  }
  if (!/\brunSessionCommand\s*\([^)]*\)\s*:\s*Promise<void>/.test(contractText)) {
    errors.push(
      '- SessionHostBridge contract must expose runSessionCommand(...) as Promise<void>:',
      `  - ${sessionBridgeContract!.filePath}`,
    );
  }
  if (/\bRuntimeTurnOperations\b/.test(contractText)) {
    errors.push(
      '- SessionHostBridge contract must stay canonical and must not expose RuntimeTurnOperations return types:',
      `  - ${sessionBridgeContract!.filePath}`,
    );
  }

  const bridgeText = stripCommentsOnly(sessionHostBridge!.content);
  if (/\bRuntimeTurnOperations\b/.test(bridgeText)) {
    errors.push(
      '- SessionHostBridge must not bless raw RuntimeTurnOperations as a canonical session bridge return shape:',
      `  - ${sessionHostBridge!.filePath}`,
    );
  }

  const sharedSessionFiles = [hostSessionRuntime!];
  for (const file of sharedSessionFiles) {
    const codeText = stripCommentsOnly(file.content);
    const leakingAcpRetirementShape = /\bAcpRuntimeCore\b|\blegacyRuntimeCore\b|\blegacyRuntimeFactory\b/.test(codeText);
    if (!leakingAcpRetirementShape) {
      continue;
    }
    errors.push(
      `- shared host/session runtime owners must stay neutral and must not expose ACP-shaped retirement seams: ${file.filePath}`,
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function enforceAcpSharedSessionCompatibilityAllowlist(
  files: readonly InventoryFile[],
): V2ZeroInventoryEnforcementResult {
  const offenders = files
    .filter((file) => file.filePath.startsWith('apps/cli/src/agent/acp/'))
    .filter((file) => isProductionTypeScriptFile(file.filePath))
    .filter((file) => {
      const codeText = stripCommentsOnly(file.content);
      return /@\/agent\/runtime\/sessionLoop\/|(?:\.\.\/)+agent\/runtime\/sessionLoop\/|\bHostSessionRuntime(?:Plan|RunOptions|Retirement)\b|\brunHostSessionRuntime(?:Plan)?\b|\bcreateCatalogHostSessionRuntimePlan\b/.test(codeText);
    })
    .map((file) => file.filePath)
    .filter((filePath) => !ACP_SHARED_SESSION_COMPATIBILITY_ALLOWLIST.has(filePath))
    .sort((left, right) => left.localeCompare(right));

  if (offenders.length === 0) {
    return { ok: true, errors: [] };
  }

  return {
    ok: false,
    errors: [
      '- ACP-named shared-session compatibility helpers must stay inside the explicit allowlist while OP-B/G remains open:',
      ...offenders.map((filePath) => `  - ${filePath}`),
    ],
  };
}

export function enforceSharedSessionRetirementSurfaceAllowlist(
  files: readonly InventoryFile[],
): V2ZeroInventoryEnforcementResult {
  const offenders = files
    .filter((file) => isProductionTypeScriptFile(file.filePath))
    .filter((file) => {
      const codeText = stripCommentsOnly(file.content);
      return /\bHostSessionRuntimeRetirement\b|\bcreateRetiredHostSessionRuntime\b|\bcreateAcpHostSessionRuntimeRetirement\b/.test(codeText);
    })
    .map((file) => file.filePath)
    .sort((left, right) => left.localeCompare(right));

  if (offenders.length === 0) {
    return { ok: true, errors: [] };
  }

  return {
    ok: false,
    errors: [
      '- Shared-session retirement compatibility symbols are retired and must not exist in production files:',
      ...offenders.map((filePath) => `  - ${filePath}`),
    ],
  };
}

function extractInterfaceMethodNames(content: string, interfaceName: string): string[] {
  const match = new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(content);
  if (!match) {
    return [];
  }

  const names = new Set<string>();
  for (const methodMatch of match[1].matchAll(/(?:^|\n)\s*([A-Za-z_]\w*)\??\s*\(/g)) {
    names.add(methodMatch[1]);
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

function extractStringArrayMembers(content: string, constName: string): string[] {
  const match = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`, 'm').exec(content);
  if (!match) {
    return [];
  }

  const names = new Set<string>();
  for (const memberMatch of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
    names.add(memberMatch[1]);
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

export function enforceAgentBackendOperationSetParity(files: readonly InventoryFile[]): V2ZeroInventoryEnforcementResult {
  const agentBackendFile = files.find((file) => file.filePath === 'apps/cli/src/agent/core/AgentBackend.ts');
  const designPacketFile = files.find((file) =>
    file.filePath === 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts'
  );

  const errors: string[] = [];
  if (!agentBackendFile) {
    errors.push('- missing governance source file: apps/cli/src/agent/core/AgentBackend.ts');
  }
  if (!designPacketFile) {
    errors.push('- missing governance source file: apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const interfaceMethods = extractInterfaceMethodNames(agentBackendFile!.content, 'AgentBackend');
  const mappedOperations = extractStringArrayMembers(designPacketFile!.content, 'AGENT_BACKEND_OPERATION_SET');

  if (interfaceMethods.length === 0) {
    errors.push('- could not parse AgentBackend operation surface from apps/cli/src/agent/core/AgentBackend.ts');
  }
  if (mappedOperations.length === 0) {
    errors.push('- could not parse AGENT_BACKEND_OPERATION_SET from apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const fixedOperations = Array.from(FIXED_AGENT_BACKEND_RETIREMENT_OPERATIONS);
  const fixedSet = new Set(fixedOperations);
  const mappedSet = new Set(mappedOperations);
  const interfaceSet = new Set(interfaceMethods);
  const fixedOnly = fixedOperations.filter((method) => !interfaceSet.has(method));
  const interfaceOnly = interfaceMethods.filter((method) => !mappedSet.has(method));
  const mappedOnly = mappedOperations.filter((method) => !interfaceSet.has(method));
  const interfaceUnexpected = interfaceMethods.filter((method) => !fixedSet.has(method));
  const mappedUnexpected = mappedOperations.filter((method) => !fixedSet.has(method));

  if (fixedOnly.length > 0) {
    errors.push(`- AgentBackend is missing required retirement operations: ${fixedOnly.join(', ')}`);
  }
  if (interfaceUnexpected.length > 0 || mappedUnexpected.length > 0) {
    const unexpected = Array.from(new Set([...interfaceUnexpected, ...mappedUnexpected])).sort((left, right) => left.localeCompare(right));
    errors.push(`- AgentBackend must remain the fixed retirement surface: ${unexpected.join(', ')}`);
  }
  if (interfaceOnly.length > 0) {
    errors.push(`- AgentBackend grew beyond the mapped retirement operation set: ${interfaceOnly.join(', ')}`);
  }
  if (mappedOnly.length > 0) {
    errors.push(`- AGENT_BACKEND_OPERATION_SET drifted out of sync with AgentBackend: ${mappedOnly.join(', ')}`);
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function enforceExecutionRunIntentProfileOwnerFence(
  files: readonly InventoryFile[],
): V2ZeroInventoryEnforcementResult {
  const offenders = files
    .filter((file) => isProductionTypeScriptFile(file.filePath))
    .filter((file) => EXECUTION_RUN_INTENT_BRANCH_FILE_SCOPE.some((pattern) => pattern.test(file.filePath)))
    .filter((file) => {
      const codeText = stripCommentsOnly(file.content);
      return EXECUTION_RUN_INTENT_LITERAL_PATTERN.test(codeText) && EXECUTION_RUN_INTENT_BRANCH_PATTERN.test(codeText);
    })
    .filter((file) => !EXECUTION_RUN_INTENT_OWNER_FENCE_ALLOWLIST.some((pattern) => pattern.test(file.filePath)))
    .map((file) => file.filePath)
    .sort((left, right) => left.localeCompare(right));

  if (offenders.length === 0) {
    return { ok: true, errors: [] };
  }

  return {
    ok: false,
    errors: [
      '- Execution-run intent literals must stay behind the explicit profile/policy/manager owner fence:',
      ...offenders.map((filePath) => `  - ${filePath}`),
    ],
  };
}

export function enforceTrackedV2ZeroReportFreshness(
  report: V2ZeroInventoryReport,
  params: Readonly<{ rootDir: string }>,
): V2ZeroInventoryEnforcementResult {
  const expectedEntries = buildV2ZeroInventoryReportEntries(report);
  const errors: string[] = [];

  for (const [relativePath, expectedContent] of Object.entries(expectedEntries)) {
    const absolutePath = resolve(params.rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      errors.push(`- tracked V2-zero governance artifact is missing: ${relativePath}`);
      continue;
    }

    const actualContent = readFileSync(absolutePath, 'utf8');
    if (actualContent !== expectedContent) {
      errors.push(`- tracked V2-zero governance artifact is stale: ${relativePath}`);
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
