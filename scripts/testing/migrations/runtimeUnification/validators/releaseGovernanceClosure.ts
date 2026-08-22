import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const VALIDATOR_ID = 'RU2-release-governance-closure';

export type ReleaseGovernanceClosureCheckId =
  | 'preview-diagnostics-egress'
  | 'release-test-honesty'
  | 'surface-context-placement'
  | 'pms-observability-owner'
  | 'first-audit-reachability';

export interface ReleaseGovernanceClosureFile {
  filePath: string;
  content: string;
}

export interface ReleaseGovernanceClosureViolation {
  checkId: ReleaseGovernanceClosureCheckId;
  filePath: string;
  line: number;
  message: string;
}

export interface ReleaseGovernanceClosureResult {
  ok: boolean;
  validatorId: typeof VALIDATOR_ID;
  violations: readonly ReleaseGovernanceClosureViolation[];
  scannedFiles: readonly string[];
}

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEFAULT_CHECKS: readonly ReleaseGovernanceClosureCheckId[] = Object.freeze([
  'preview-diagnostics-egress',
  'release-test-honesty',
  'surface-context-placement',
  'pms-observability-owner',
  'first-audit-reachability',
]);

const SCAN_ROOTS = Object.freeze([
  'apps/cli/src/daemon/browser',
  'apps/cli/src/daemon/peer/mediation/observability',
  'apps/cli/src/daemon/startDaemon.ts',
  'apps/cli/src/rpc/handlers/executionRuns',
  'apps/ui/sources/app/(app)/_layout.tsx',
  'apps/ui/sources/components/browser',
  'apps/ui/sources/sync/domains/browser',
  'packages/protocol/src/browser',
  'packages/protocol/src/local/services/preview',
  'packages/protocol/src/plugins/contributions/ui',
  'packages/protocol/src/plugins/ui',
  'packages/tests/suites/core-e2e',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  '.expo',
  '.next',
  '.project',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'package-dist',
]);

const RELEASE_REQUIRED_TESTS: readonly RegExp[] = Object.freeze([
  /^apps\/cli\/src\/daemon\/browser\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /^packages\/protocol\/src\/local\/services\/preview\/diagnostics\/v1\.test\.ts$/,
  /^packages\/protocol\/src\/devices\/simulator\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /^packages\/protocol\/src\/features\/payload\/capabilities\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /^packages\/protocol\/src\/plugins\/ui\/surfaceContext\.test\.ts$/,
  /^apps\/cli\/src\/daemon\/browser\/automation\/adapters\/controlBridge\.test\.ts$/,
  /^apps\/cli\/src\/daemon\/peer\/mediation\/observability\/events\.test\.ts$/,
  /^apps\/cli\/src\/daemon\/peer\/mediation\/observability\/runtimeActionExecutor\.test\.ts$/,
  /^apps\/ui\/sources\/components\/browser\/BrowserShell\.test\.tsx$/,
  /^apps\/ui\/sources\/components\/browser\/surfaces\/browserPresentationPortal\.test\.tsx$/,
  /^apps\/ui\/sources\/components\/browser\/surfaces\/useBrowserSurfaceHostProps\.retention\.test\.tsx$/,
  /^apps\/ui\/sources\/sync\/domains\/browser\/context\/annotationAdapter\.test\.ts$/,
  /^apps\/ui\/sources\/sync\/domains\/browser\/context\/runtimeAnnotationExecutor\.test\.ts$/,
  /^packages\/tests\/suites\/core-e2e\/browser.*\.test\.ts$/,
  /^packages\/tests\/suites\/core-e2e\/peerMediationObservability.*\.test\.ts$/,
]);

export function validateReleaseGovernanceClosure(options?: Readonly<{
  rootDir?: string;
  files?: readonly ReleaseGovernanceClosureFile[];
  enabledChecks?: readonly ReleaseGovernanceClosureCheckId[];
}>): ReleaseGovernanceClosureResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const enabledChecks = new Set(options?.enabledChecks ?? DEFAULT_CHECKS);
  const files = (options?.files ?? collectSourceFiles(rootDir, SCAN_ROOTS)).map((file) => ({
    filePath: normalizeRepoPath(file.filePath),
    content: file.content,
  }));
  const violations: ReleaseGovernanceClosureViolation[] = [];

  if (enabledChecks.has('preview-diagnostics-egress')) {
    violations.push(...validatePreviewDiagnosticsEgress(files));
  }
  if (enabledChecks.has('release-test-honesty')) {
    violations.push(...validateReleaseTestHonesty(files));
  }
  if (enabledChecks.has('surface-context-placement')) {
    violations.push(...validateSurfaceContextPlacement(files));
  }
  if (enabledChecks.has('pms-observability-owner')) {
    violations.push(...validatePmsObservabilityOwner(files));
  }
  if (enabledChecks.has('first-audit-reachability')) {
    violations.push(...validateFirstAuditReachability(files));
  }

  return {
    ok: violations.length === 0,
    validatorId: VALIDATOR_ID,
    violations,
    scannedFiles: files.map((file) => file.filePath).sort((left, right) => left.localeCompare(right)),
  };
}

function validatePreviewDiagnosticsEgress(
  files: readonly ReleaseGovernanceClosureFile[],
): ReleaseGovernanceClosureViolation[] {
  const file = files.find((candidate) =>
    candidate.filePath === 'packages/protocol/src/local/services/preview/diagnostics/v1.ts'
  );
  if (!file) return [];

  const violations: ReleaseGovernanceClosureViolation[] = [];
  const duplicatePatterns = [
    /\bSAFE_HEADER_NAMES\b/,
    /\bSAFE_HEADER\b/,
    /\bsanitizeUrl\b/,
    /\bsanitizeHeaderNames\b/,
  ];
  for (const pattern of duplicatePatterns) {
    const line = findLine(file.content, pattern);
    if (line !== 0) {
      violations.push(violation(
        'preview-diagnostics-egress',
        file.filePath,
        line,
        'RP-ARCH-2: preview diagnostics must reuse the canonical browser diagnostics egress classifier/header redactor instead of local SAFE_HEADER/URL sanitizer logic.',
      ));
    }
  }
  if (
    !/\bredactDiagnosticsHeaders\b/.test(file.content)
    || !/\bredactDiagnosticsUrl\b/.test(file.content)
  ) {
    violations.push(violation(
      'preview-diagnostics-egress',
      file.filePath,
      1,
      'RP-ARCH-2: preview diagnostics must import and consume redactDiagnosticsHeaders/redactDiagnosticsUrl from the canonical egress owner.',
    ));
  }
  return violations;
}

function validateReleaseTestHonesty(
  files: readonly ReleaseGovernanceClosureFile[],
): ReleaseGovernanceClosureViolation[] {
  const violations: ReleaseGovernanceClosureViolation[] = [];
  for (const file of files) {
    if (!isReleaseRequiredTest(file.filePath)) continue;
    const softImportLine = findLine(file.content, /import\s*\([^)]*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/);
    if (softImportLine !== 0) {
      violations.push(violation(
        'release-test-honesty',
        file.filePath,
        softImportLine,
        'RP-TEST-2: release-required tests must not soft-skip module load with import(...).catch(() => null).',
      ));
    }
  }
  return violations;
}

function validateSurfaceContextPlacement(
  files: readonly ReleaseGovernanceClosureFile[],
): ReleaseGovernanceClosureViolation[] {
  const registry = files.find((candidate) =>
    candidate.filePath === 'packages/protocol/src/plugins/contributions/ui/surfaceRegistry.ts'
  );
  if (!registry) return [];

  const violations: ReleaseGovernanceClosureViolation[] = [];
  if (!/\bPLUGIN_UI_DESTINATION_BINDING_SLOTS_V1\b/.test(registry.content)) {
    violations.push(violation(
      'surface-context-placement',
      registry.filePath,
      1,
      'RP-ARCH-3: UI destination admission must derive from the canonical direct destination-slot registry.',
    ));
  }
  if (!/\bresolvePluginUiDestinationBindingSlotV1\b/.test(registry.content)) {
    violations.push(violation(
      'surface-context-placement',
      registry.filePath,
      1,
      'RP-ARCH-3: UI destination binding must resolve through the direct slot owner.',
    ));
  }
  const startsWithLine = findLine(registry.content, /\.startsWith\s*\(/);
  if (startsWithLine !== 0) {
    violations.push(violation(
      'surface-context-placement',
      registry.filePath,
      startsWithLine,
      'RP-ARCH-3: UI destination admission must not classify direct bindings with open-ended startsWith prefix checks.',
    ));
  }
  return violations;
}

function validatePmsObservabilityOwner(
  files: readonly ReleaseGovernanceClosureFile[],
): ReleaseGovernanceClosureViolation[] {
  const violations: ReleaseGovernanceClosureViolation[] = [];
  const routeFile = files.find((file) =>
    file.filePath === 'apps/cli/src/daemon/peer/mediation/observability/routes.ts'
      && /\bregisterDaemonPeerMediationObservabilityRoutes\b/.test(file.content)
  );
  if (routeFile) {
    const hasProductionConsumer = files.some((file) =>
      !isTestFile(file.filePath)
      && file.filePath !== routeFile.filePath
      && /\bregisterDaemonPeerMediationObservabilityRoutes\b/.test(file.content)
    );
    if (!hasProductionConsumer) {
      violations.push(violation(
        'pms-observability-owner',
        routeFile.filePath,
        findLine(routeFile.content, /\bregisterDaemonPeerMediationObservabilityRoutes\b/) || 1,
        'RP-PMS-OBS-1: daemon PMS observability socket route is exported without a production registration; remove it or wire it as the single production route owner.',
      ));
    }
  }

  if (!hasProductionMatch(files, 'apps/cli/src/daemon/startDaemon.ts', /setPeerMediationObservabilityRuntimeActionContextProvider/)) {
    violations.push(violation(
      'pms-observability-owner',
      'apps/cli/src/daemon/startDaemon.ts',
      1,
      'RP-PMS-OBS-1: daemon startup must publish the PMS observability runtime-action context from the single live owner.',
    ));
  }
  if (!hasProductionMatch(files, 'apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts', /createPeerMediationObservabilityDaemonRuntimeActionExecutor/)) {
    violations.push(violation(
      'pms-observability-owner',
      'apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts',
      1,
      'RP-PMS-OBS-1: execution-run dispatch must route PMS observability ActionSpecs to the live daemon executor.',
    ));
  }
  return violations;
}

function validateFirstAuditReachability(
  files: readonly ReleaseGovernanceClosureFile[],
): ReleaseGovernanceClosureViolation[] {
  const violations: ReleaseGovernanceClosureViolation[] = [];
  const targets = [
    {
      label: 'captureSnapshot',
      ownerPath: 'apps/cli/src/daemon/browser/context/capture.ts',
      ownerPattern: /\bcaptureSnapshot\b/,
      consumerPath: 'apps/cli/src/daemon/browser/automation/adapters/controlBridge.ts',
      consumerPattern: /\bbrowserContext\b[\s\S]*\bcaptureSnapshot\b|\bcaptureSnapshot\b[\s\S]*\bbrowserContext\b/,
      testPatterns: [
        /routes the production snapshot verb through the rich browser-context snapshot producer/,
        /captureSnapshot \(BA-2 combined op\)/,
      ],
    },
    {
      label: 'parseLocator/resolveLocator',
      ownerPath: 'apps/cli/src/daemon/browser/automation/locators.ts',
      ownerPattern: /\bparseLocator\b[\s\S]*\bresolveLocator\b/,
      consumerPath: 'apps/cli/src/daemon/browser/automation/adapters/controlBridge.ts',
      consumerPattern: /\bparseLocator\b[\s\S]*\bsynthesizeLocator(?:Element)?Expression\b/,
      testPatterns: [
        /resolves semantic and CSS locators through the production query and wait paths/,
        /resolves semantic and CSS locators before dispatching input commands/,
      ],
    },
    {
      label: 'keep-alive portal',
      ownerPath: 'apps/ui/sources/components/browser/surfaces/browserPresentationRetention.tsx',
      ownerPattern: /\bBrowserPresentationRetentionProvider\b[\s\S]*\bBrowserKeepAliveBinder\b/,
      consumerPath: 'apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx',
      consumerPattern: /\bBrowserKeepAliveBinder\b[\s\S]*\bkeepAliveAboveRouter\b/,
      secondaryConsumerPath: 'apps/ui/sources/app/(app)/_layout.tsx',
      secondaryConsumerPattern: /\bBrowserPresentationRetentionProvider\b/,
      testPatterns: [
        /BrowserKeepAliveBinder hosts children in the portal when enabled/,
        /persists retention across a consumer remount/,
      ],
    },
    {
      label: 'annotation adapter attach',
      ownerPath: 'apps/ui/sources/sync/domains/browser/context/annotationAdapter.ts',
      ownerPattern: /\bcreateBrowserContextAnnotationAdapter\b/,
      consumerPath: 'apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx',
      consumerPattern: /\breadRegisteredBrowserContextAnnotationAdapter\b[\s\S]*\.dispatch\(/,
      testPatterns: [
        /uses an injected annotation capture provider to produce the media draft before attaching/,
        /captures a host-owned annotation draft as a stale-safe composer attachment/,
      ],
    },
    {
      label: 'PMS observability route ownership',
      ownerPath: 'apps/cli/src/daemon/peer/mediation/observability/runtimeActionExecutor.ts',
      ownerPattern: /\bcreatePeerMediationObservabilityDaemonRuntimeActionExecutor\b/,
      consumerPath: 'apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts',
      consumerPattern: /\bcreatePeerMediationObservabilityDaemonRuntimeActionExecutor\b/,
      secondaryConsumerPath: 'apps/cli/src/daemon/startDaemon.ts',
      secondaryConsumerPattern: /\bsetPeerMediationObservabilityRuntimeActionContextProvider\b/,
      testPatterns: [
        /peerMediation\.observability\.subscribe/,
        /peerMediation\.observability\.snapshot/,
      ],
    },
  ] as const;

  for (const target of targets) {
    if (!hasProductionMatch(files, target.ownerPath, target.ownerPattern)) {
      violations.push(reachabilityViolation(target.label, target.ownerPath, 'owner is missing or no longer declares the built capability'));
      continue;
    }
    if (!hasProductionMatch(files, target.consumerPath, target.consumerPattern)) {
      violations.push(reachabilityViolation(target.label, target.consumerPath, 'production consumer is missing; test-only consumers are not sufficient'));
    }
    if (
      target.secondaryConsumerPath
      && target.secondaryConsumerPattern
      && !hasProductionMatch(files, target.secondaryConsumerPath, target.secondaryConsumerPattern)
    ) {
      violations.push(reachabilityViolation(target.label, target.secondaryConsumerPath, 'secondary production assembly point is missing'));
    }
    const hasAssembledTest = files.some((file) =>
      isTestFile(file.filePath)
      && target.testPatterns.some((pattern) => pattern.test(file.content))
    );
    if (!hasAssembledTest) {
      violations.push(reachabilityViolation(target.label, '<tests>', 'assembled cross-boundary test evidence is missing'));
    }
  }
  return violations;
}

function reachabilityViolation(
  label: string,
  filePath: string,
  detail: string,
): ReleaseGovernanceClosureViolation {
  return violation(
    'first-audit-reachability',
    filePath,
    1,
    `RP-REACH-1: ${label} is DONE-coded without complete production reachability: ${detail}.`,
  );
}

function hasProductionMatch(
  files: readonly ReleaseGovernanceClosureFile[],
  filePath: string,
  pattern: RegExp,
): boolean {
  return files.some((file) =>
    file.filePath === filePath
    && !isTestFile(file.filePath)
    && pattern.test(file.content)
  );
}

function isReleaseRequiredTest(filePath: string): boolean {
  return RELEASE_REQUIRED_TESTS.some((pattern) => pattern.test(filePath));
}

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

function findLine(content: string, pattern: RegExp): number {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return 0;
}

function violation(
  checkId: ReleaseGovernanceClosureCheckId,
  filePath: string,
  line: number,
  message: string,
): ReleaseGovernanceClosureViolation {
  return { checkId, filePath, line, message };
}

function collectSourceFiles(
  rootDir: string,
  roots: readonly string[],
): ReleaseGovernanceClosureFile[] {
  const files: ReleaseGovernanceClosureFile[] = [];
  for (const scanRoot of roots) {
    const absoluteRoot = resolve(rootDir, scanRoot);
    if (!existsSync(absoluteRoot)) continue;
    const stats = statSync(absoluteRoot);
    if (stats.isFile()) {
      if (SOURCE_FILE_PATTERN.test(scanRoot)) {
        files.push({
          filePath: normalizeRepoPath(relative(rootDir, absoluteRoot)),
          content: readFileSync(absoluteRoot, 'utf8'),
        });
      }
      continue;
    }
    collectSourceFilesFromDirectory(rootDir, absoluteRoot, files);
  }
  return files;
}

function collectSourceFilesFromDirectory(
  rootDir: string,
  directory: string,
  out: ReleaseGovernanceClosureFile[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) continue;
      collectSourceFilesFromDirectory(rootDir, join(directory, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_FILE_PATTERN.test(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    out.push({
      filePath: normalizeRepoPath(relative(rootDir, absolutePath)),
      content: readFileSync(absolutePath, 'utf8'),
    });
  }
}

function shouldIgnoreDirectory(directoryName: string): boolean {
  return directoryName.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(directoryName);
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}
