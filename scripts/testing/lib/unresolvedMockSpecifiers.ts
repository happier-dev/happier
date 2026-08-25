import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * `vi.mock('<specifier>')` is a plain string key. Neither TypeScript nor Vitest ever
 * resolves it: TypeScript has no relation between the literal and a module, and Vitest
 * deliberately accepts specifiers for modules that do not exist yet (virtual modules,
 * modules created by a plugin). A specifier that stops resolving after a rename or a
 * deletion therefore keeps its call green while silently installing no mock at all —
 * the real module loads, and every `expect(spyFromTheFactory).not.toHaveBeenCalled()`
 * built on that factory becomes true by construction.
 *
 * This owner resolves the first-party specifier forms the repository actually uses —
 * relative paths and the `@/` source alias — so that rot is a wiring issue instead of
 * an invisible one.
 */

export interface UnresolvedMockSpecifier {
  filePath: string;
  line: number;
  specifier: string;
}

export interface MockSpecifierFile {
  filePath: string;
  content: string;
}

/** `@/` alias roots, keyed by the owning workspace directory. */
const ALIAS_SOURCE_ROOTS: readonly (readonly [string, string])[] = Object.freeze([
  ['apps/cli/', 'apps/cli/src'],
  ['apps/server/', 'apps/server/sources'],
  ['apps/ui/', 'apps/ui/sources'],
  ['apps/website/', 'apps/website/src'],
  ['apps/desktop/', 'apps/desktop/src'],
  ['apps/docs/', 'apps/docs/src'],
  // packages/tests drives the UI and CLI sources through `appSourceAliasesPlugin`,
  // which falls back to the UI source root for every importer outside apps/cli.
  ['packages/tests/', 'apps/ui/sources'],
]);

const MODULE_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.svg', '.md',
]);

/** React Native / web platform suffixes Metro and the Vitest stubs both honour. */
const PLATFORM_SUFFIXES = Object.freeze(['.native', '.web', '.ios', '.android']);

// Anchored at statement start so a `vi.mock(...)` quoted inside a codemod fixture string
// is not mistaken for a real mock call.
const MOCK_CALL_RE = /^\s*(?:await\s+)?vi\s*\.\s*(?:mock|doMock)\s*\(\s*(['"])([^'"\n]+)\1/;

export function isCheckedMockSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/');
}

export function collectMockSpecifiers(file: MockSpecifierFile): readonly UnresolvedMockSpecifier[] {
  const found: UnresolvedMockSpecifier[] = [];
  const lines = file.content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const match = MOCK_CALL_RE.exec(lines[index]!);
    if (match) found.push({ filePath: file.filePath, line: index + 1, specifier: match[2]! });
  }

  return found;
}

function resolveAliasBase(rootDir: string, filePath: string, specifier: string): string | null {
  const owner = ALIAS_SOURCE_ROOTS.find(([workspaceDirectory]) => filePath.startsWith(workspaceDirectory));
  if (!owner) return null;
  return resolve(rootDir, owner[1], specifier.slice('@/'.length));
}

export type ModuleExistsProbe = (absolutePath: string) => boolean;

export function resolvesToModule(
  basePath: string,
  moduleExists: ModuleExistsProbe,
): boolean {
  if (moduleExists(basePath)) return true;

  const authoredExtension = /\.(?:js|mjs|cjs|jsx)$/.exec(basePath);
  if (authoredExtension) {
    const stem = basePath.slice(0, -authoredExtension[0].length);
    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.d.ts']) {
      if (moduleExists(stem + extension)) return true;
    }
  }

  for (const extension of MODULE_EXTENSIONS) {
    if (moduleExists(basePath + extension)) return true;
    if (moduleExists(`${basePath}/index${extension}`)) return true;
  }

  for (const suffix of PLATFORM_SUFFIXES) {
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      if (moduleExists(basePath + suffix + extension)) return true;
    }
  }

  return false;
}

export function collectUnresolvedMockSpecifiers(
  files: readonly MockSpecifierFile[],
  options: Readonly<{ rootDir?: string; moduleExists?: ModuleExistsProbe }> = {},
): readonly UnresolvedMockSpecifier[] {
  const rootDir = options.rootDir ?? process.cwd();
  const moduleExists = options.moduleExists ?? ((absolutePath: string) => existsSync(absolutePath));
  const unresolved: UnresolvedMockSpecifier[] = [];

  for (const file of files) {
    for (const found of collectMockSpecifiers(file)) {
      if (!isCheckedMockSpecifier(found.specifier)) continue;

      const basePath = found.specifier.startsWith('@/')
        ? resolveAliasBase(rootDir, file.filePath, found.specifier)
        : resolve(rootDir, dirname(file.filePath), found.specifier);

      // A workspace without a known `@/` root cannot be judged here; skip rather than
      // report an alias this checker does not own.
      if (basePath === null) continue;

      if (!resolvesToModule(basePath, moduleExists)) unresolved.push(found);
    }
  }

  return unresolved;
}

/**
 * Known-inert mock specifiers inherited from earlier renames and deletions, recorded on
 * 2026-08-21 by a repository-wide resolve sweep. Every entry is a mock that installs
 * nothing today: the real module loads instead, and any spy taken from its factory can
 * never be called. Repointing one is a per-test decision, not a rename: measured on
 * apps/cli/src/api/api.connectedServices*.test.ts, correcting './configuration' to
 * '@/configuration' activates the factory for the first time and turns 11 tests red,
 * because the factory never carried the members the client actually reads.
 *
 * This list is a shrinking backlog, not an allowance: a declared entry that no longer
 * appears, or that starts resolving, is reported as stale so the exception cannot rot
 * silently the way the mocks it covers did.
 */
export const DECLARED_UNRESOLVED_MOCK_SPECIFIERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.manager.test.ts": ["../../../plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent"],
  "apps/cli/src/api/api.connectedServicesV2.test.ts": ["./configuration"],
  "apps/cli/src/api/api.connectedServicesV3.test.ts": ["./configuration"],
  "apps/ui/sources/__tests__/routes/(app)/index.setupContinuation.native.spec.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/__tests__/routes/(app)/session/[id]/runs.test.tsx": ["@/react-native-unistyles"],
  "apps/ui/sources/__tests__/routes/(app)/session/sessionIdParamParsing.spec.tsx": ["@/sync/domains/auth/useAuth"],
  "apps/ui/sources/__tests__/routes/(app)/settings/session.subAgentGate.test.tsx": ["./sessionI18n"],
  "apps/ui/sources/__tests__/routes/(app)/setup.desktop.test.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/__tests__/routes/(app)/setup.localRelayStatus.spec.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/__tests__/routes/(app)/setup.spec.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/__tests__/routes/(app)/setup.web.test.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/__tests__/routes/(app)/setup.wizard.spec.tsx": ["@/components/onboarding/PreAuthOnboardingWizardEntry"],
  "apps/ui/sources/components/navigation/shell/MainView.primaryPaneGettingStarted.test.tsx": ["@/components/ui/navigation/TabBar","@/hooks/session/useVisibleSessionListViewData"],
  "apps/ui/sources/components/sessions/agentInput/AgentInput.actionBarScroll.test.tsx": ["./PathAndResumeRow","./ResumeChip","@/components/tools/normalization/policy/permissionSummary"],
  "apps/ui/sources/components/sessions/agentInput/AgentInput.permissionPromptSurface.test.tsx": ["./PathAndResumeRow","./ResumeChip","./actionBarLogic","./attachActionBarMouseDragScroll"],
  "apps/ui/sources/components/sessions/agentInput/AgentInput.permissionRequests.test.tsx": ["./PathAndResumeRow","./ResumeChip","./actionBarLogic"],
  "apps/ui/sources/components/sessions/files/views/SessionRepositoryTreeBrowserView.folderUpload.dom.test.tsx": ["@/components/sessions/files/content/ChangedFilesTreeList","@/components/sessions/files/content/SearchResultsList","@/components/sessions/files/repositoryTree/RepositoryTreeDropOverlay","@/components/sessions/files/repositoryTree/RepositoryTreeTransferStatusBar","@/components/sessions/files/repositoryTree/WebDropTargetView","@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal","@/components/sessions/files/repositoryTree/showUploadConflictResolutionDialog"],
  "apps/ui/sources/components/sessions/panes/SessionRightPanel.gitSubTabs.test.tsx": ["@/components/sessions/files/SourceControlOperationsHistorySection"],
  "apps/ui/sources/components/sessions/panes/git/SessionRightPanelGitCommitTab.draftDebounce.test.tsx": ["@/components/sessions/files/SourceControlBranchSummary","@/components/sessions/sourceControl/changes/ScmChangeRow","@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard"],
  "apps/ui/sources/components/sessions/shell/SessionView.attachmentsGating.test.tsx": ["@/sync/ops/sessionSwitch"],
  "apps/ui/sources/components/sessions/shell/SessionView.dataReadyGate.test.tsx": ["@/components/appShell/panes/useRegisterSessionPaneDriver","@/sync/domains/session/activeViewingSession"],
  "apps/ui/sources/components/sessions/shell/SessionView.infoNavigation.test.tsx": ["@/components/appShell/panes/useRegisterSessionPaneDriver","@/sync/domains/session/activeViewingSession"],
  "apps/ui/sources/components/sessions/shell/SessionView.rightPaneAutoOpen.test.tsx": ["@/sync/acp/sessionModeControl","@/sync/ops/actions/sessionActionExecutor"],
  "apps/ui/sources/components/sessions/shell/SessionView.sendAttachmentsResumable.feat.attachments.uploads.test.tsx": ["@/sync/acp/sessionModeControl","@/sync/ops/sessionSwitch"],
  "apps/ui/sources/components/sessions/shell/SessionView.sendMessage.resumeInactive.pendingQueue.test.tsx": ["@/sync/acp/sessionModeControl"],
  "apps/ui/sources/components/sessions/shell/SessionView.transcriptRender.seqOnly.test.tsx": ["@/sync/ops/actions/sessionActionExecutor"],
  "apps/ui/sources/components/sessions/transcript/MessageView.jumpHighlight.test.tsx": ["@/components/sessions/sessionMedia/SessionMediaInlineImages"],
  "apps/ui/sources/components/sessions/transcript/MessageView.messagePinButton.test.tsx": ["@/components/sessions/sessionMedia/SessionMediaInlineImages"],
  "apps/ui/sources/components/sessions/transcript/MessageView.unsupportedContent.test.tsx": ["@/components/sessions/sessionMedia/SessionMediaInlineImages","@/components/sessions/transcript/messageCopyVisibility"],
  "apps/ui/sources/hooks/session/useSessionExecutionRunLaunchability.test.tsx": ["@/hooks/server/useSessionMachineReachability"],
  "apps/ui/sources/voice/agent/initializeVoiceAgentHandle.spec.ts": ["@/voice/agent/resolveVoiceAgentModels"],
});

export interface MockSpecifierIssue {
  filePath: string;
  message: string;
}

export function collectMockSpecifierIssues(
  files: readonly MockSpecifierFile[],
  options: Readonly<{
    rootDir?: string;
    moduleExists?: ModuleExistsProbe;
    declared?: Readonly<Record<string, readonly string[]>>;
  }> = {},
): readonly MockSpecifierIssue[] {
  const declared = options.declared ?? DECLARED_UNRESOLVED_MOCK_SPECIFIERS;
  const unresolved = collectUnresolvedMockSpecifiers(files, options);
  const issues: MockSpecifierIssue[] = [];

  const observed = new Map<string, Set<string>>();
  for (const entry of unresolved) {
    const specifiers = observed.get(entry.filePath) ?? new Set<string>();
    specifiers.add(entry.specifier);
    observed.set(entry.filePath, specifiers);

    if (declared[entry.filePath]?.includes(entry.specifier)) continue;
    issues.push({
      filePath: entry.filePath,
      message: `Line ${entry.line}: vi.mock('${entry.specifier}') resolves to no module, so the mock is never installed and the real module loads.`,
    });
  }

  const scanned = new Set(files.map((file) => file.filePath));
  for (const [filePath, specifiers] of Object.entries(declared)) {
    if (!scanned.has(filePath)) {
      issues.push({
        filePath,
        message: 'Declared unresolved mock specifiers name a file that no longer exists; drop the declaration.',
      });
      continue;
    }
    for (const specifier of specifiers) {
      if (observed.get(filePath)?.has(specifier)) continue;
      issues.push({
        filePath,
        message: `Declared unresolved mock specifier '${specifier}' now resolves or is gone; drop the declaration.`,
      });
    }
  }

  return issues;
}
