import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { LanguageIntelligenceDiagnostic, LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';

import type { DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { useAskSessionReveal } from '@/components/ui/code/selection/useAskSessionReveal';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';
import type {
  Rect,
  TextEditorHandle,
  CodeEditorLanguageCommand,
  CodeEditorLanguageIntelligence,
} from '@/components/ui/code/editor/codeEditorTypes';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { CodeLineDiagnosticRange } from '@/components/ui/code/view/CodeLineRow';
import type { FileCodeIntelligenceBinding } from '@/components/workspaces/files/file/FileContentPanel';
import {
  useWorkspaceFileOpener,
  type WorkspaceFileOpenTarget,
} from '@/components/workspaces/files/useWorkspaceFileOpener';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useWorkspaceRefs } from '@/sync/store/hooks';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readWorkspaceFileEditorHolder, subscribeFileEditorActionOwners } from '@/sync/ops/actions/scopeActionFamily';
import { workspaceReadFile, workspaceStatFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { decodeWorkspaceFileText } from '@/sync/ops/workspaceFileSystem/workspaceFileTextDecoding';
import { askCodeDiagnosticsToFix } from '@/sync/domains/workspaces/languageIntelligence/askCodeDiagnosticsToFix';
import { useAskSelectionTargetContext } from '@/components/ui/code/selection/useAskSelection';
import { selectCodeDiagnostics } from '@/sync/domains/workspaces/languageIntelligence/codeDiagnostics';
import { resolveCodeIdentifier, type CodeIdentifier, type CodeIntelligencePosition } from '@/sync/domains/workspaces/languageIntelligence/codeIdentifiers';
import type {
  CodeIntelligenceController,
  CodeIntelligenceSnapshot,
} from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import {
  useCodeIntelligence,
  useCodeIntelligenceSnapshot,
} from '@/sync/domains/workspaces/languageIntelligence/useCodeIntelligence';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { refreshWorkspaceFileDetails } from '../details/workspaceFileDetails/refreshWorkspaceFileDetails';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useDeviceType, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useFileEditorAiSuggestionSource } from '@/providers/hooks/useFileEditorAiSuggestionSource';
import { recordFileEditorAiSuggestionUsage } from '@/sync/store/files/fileEditorAiSuggestionUsage';
import type { CodeInlineSuggestionPort } from '@/sync/domains/workspaces/languageIntelligence/codeInlineSuggestions';
import { AiSuggestionStatus, resolveAiSuggestionFooterState, type AiSuggestionFooterState } from '@/components/workspaces/files/file/editor/AiSuggestionStatus';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';

import {
  CodeIntelligenceCard,
  CodeProblemsSheet,
  type CodeIntelligenceCardModel,
} from './CodeIntelligenceCard';
import { CodeReferencesPanel } from './CodeReferencesPanel';
import {
  formatProblemsFact,
  isCodeReferenceResultPartial,
  readCodeHoverContent,
  readLanguageServerLabel,
  resolveLanguageStateNote,
} from './codeIntelligencePresentation';
import {
  publishCodeIntelligencePaneProducer,
  refreshCodeIntelligencePaneProducer,
  releaseCodeIntelligencePaneProducer,
  type CodeIntelligencePaneProducer,
} from './codeIntelligencePaneStore';
import type { CodeReferenceRow } from './CodeReferencesList';
import { CodeEditSetPopover, type CodeEditSetRequest } from './CodeEditSetPopover';

/** The open rename / quick-fix flow, outside React like the card: only its leaf re-renders. */
function createEditSetStore() {
  let request: CodeEditSetRequest | null = null;
  const listeners = new Set<() => void>();
  const set = (next: CodeEditSetRequest | null) => {
    request = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => request,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (next: CodeEditSetRequest) => set(next),
    close: () => set(null),
  };
}
type EditSetStore = ReturnType<typeof createEditSetStore>;

type CardState = Readonly<{
  anchor: Rect | null;
  via: 'hover' | 'tap' | 'command';
  references: boolean;
  /** Phones: Problems open as a sheet from the meta fact (L3 `ls2-P`). */
  problems?: boolean;
}>;

/**
 * The File page's pointer and card state, outside React: pointer motion never re-renders the page.
 * Only the card leaf subscribes to it.
 */
function createCardInteraction() {
  let state: CardState | null = null;
  let dwell: ReturnType<typeof setTimeout> | null = null;
  let away: ReturnType<typeof setTimeout> | null = null;
  let cardHovered = false;
  let remembered: Rect | null = null;
  const listeners = new Set<() => void>();
  const set = (next: CardState | null) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const clearTimers = () => {
    if (dwell) clearTimeout(dwell);
    if (away) clearTimeout(away);
    dwell = null;
    away = null;
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (next: CardState) => {
      clearTimers();
      set(next);
    },
    close: () => {
      clearTimers();
      cardHovered = false;
      set(null);
    },
    /** A pointer resting on a name asks once it has rested (`overlay.popover.hoverOpenDelayMs`). */
    dwell: (run: () => void) => {
      if (away) {
        clearTimeout(away);
        away = null;
      }
      if (dwell) clearTimeout(dwell);
      dwell = setTimeout(() => {
        dwell = null;
        run();
      }, motionTokens.overlay.popover.hoverOpenDelayMs);
    },
    /** The pointer left the name: a hover card leaves too unless the pointer moved onto it. */
    leave: () => {
      if (dwell) {
        clearTimeout(dwell);
        dwell = null;
      }
      if (state?.via !== 'hover' || away) return;
      away = setTimeout(() => {
        away = null;
        if (!cardHovered && state?.via === 'hover') set(null);
      }, motionTokens.overlay.popover.hoverOpenDelayMs);
    },
    setCardHovered: (hovered: boolean) => {
      cardHovered = hovered;
      if (!hovered && state?.via === 'hover') {
        if (away) clearTimeout(away);
        away = setTimeout(() => {
          away = null;
          if (!cardHovered) set(null);
        }, motionTokens.overlay.popover.hoverOpenDelayMs);
      }
    },
    /** Where the last explicit gesture happened, for a card that answers it later (outside definitions). */
    remember: (anchor: Rect | null) => {
      remembered = anchor;
    },
    remembered: () => remembered,
    dispose: () => {
      clearTimers();
      listeners.clear();
    },
  };
}
type CardInteraction = ReturnType<typeof createCardInteraction>;

export type UseFilePageCodeIntelligenceInput = Readonly<{
  scopeId: string;
  scope: WorkspaceScopeBase | null;
  filePath: string;
  language: string | null;
  /** Text files that a person reads or edits; binary, partial and deleted files have no language features. */
  enabled: boolean;
  /** A full-text outline can be available without server/pointer presentation (Markdown). */
  outlineEnabled?: boolean;
  active: boolean;
  editing?: boolean;
  liveValue: Readonly<{
    get(): string;
    subscribe?(listener: () => void): () => void;
  }>;
  /** View/Changes coordinates address the displayed saved text, not a retained draft. */
  displayedText?: string;
  getReadSelectionRange?: () => LanguageIntelligenceRange | null;
  getUnsaved: () => boolean;
  editorHandleRef: React.RefObject<TextEditorHandle | null>;
  sessionId: string | null;
  accountId: string | null;
  machineName: string;
  machineUnreachable: boolean;
  agentName: string | null;
  /** Phones: bring the tapped line (1-based) into the top of the view, above the name sheet (LS2 T); null lets it go. */
  revealLine?: (line: number | null) => void;
}>;

/** One stable selection of the controller's snapshot, re-rendering its caller only when `select` changes. */
function useControllerSelector<T>(
  controller: CodeIntelligenceController | null,
  select: (snapshot: CodeIntelligenceSnapshot) => T,
  key: (value: T) => string,
): T | null {
  const cache = React.useRef<{
    snapshot: CodeIntelligenceSnapshot | null;
    value: T | null;
    key: string;
  }>({ snapshot: null, value: null, key: '' });
  const getSnapshot = React.useCallback(() => {
    const snapshot = controller?.getSnapshot() ?? null;
    if (!snapshot) return null;
    if (cache.current.snapshot === snapshot) return cache.current.value;
    const value = select(snapshot);
    const nextKey = key(value);
    cache.current = {
      snapshot,
      value: nextKey === cache.current.key ? cache.current.value : value,
      key: nextKey,
    };
    return cache.current.value;
  }, [controller, select, key]);
  const subscribe = React.useCallback(
    (listener: () => void) =>
      controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, () => null);
}

const selectSummary = (snapshot: CodeIntelligenceSnapshot) => snapshot;

/** The share of a phone screen kept free under the code while a sheet is up (the sheet's tallest form). */
const PHONE_SHEET_RESERVE = 0.6;

/**
 * P7's File page composition (N5: regions handed to the PAGE owner): the one controller, the read
 * view's pointer binding, the "3 problems" fact, the language state note, the card leaf, the `⋯`
 * commands, `@` symbols for Search and the References / Problems producer for the pane.
 */
export function useFilePageCodeIntelligence(
  input: UseFilePageCodeIntelligenceInput,
) {
  const { theme } = useUnistyles();
  const inlayHints = useSetting('filesEditorInlayHints');
  const semanticHighlighting = useSetting('filesEditorSemanticHighlighting');
  const latest = React.useRef(input);
  latest.current = input;
  const opener = useWorkspaceFileOpener();
  const router = useRouter();
  const workspaceRefs = useWorkspaceRefs();
  // Only pane commands are read here; no scope state, so pane patches do not re-render the page.
  const pane = useAppPaneScope(input.scopeId, () => null);
  const revealSessionColumn = useAskSessionReveal();
  const phone = useDeviceType() === 'phone';
  const interaction = React.useMemo(() => createCardInteraction(), []);
  React.useEffect(() => () => interaction.dispose(), [interaction]);
  const editSets = React.useMemo(() => createEditSetStore(), []);

  const workspaceRefId = React.useMemo(
    () =>
      input.scope
        ? (findWorkspaceRefByScope(workspaceRefs, input.scope)?.id ?? null)
        : null,
    [input.scope, workspaceRefs],
  );
  const fileTarget = React.useMemo<Omit<
    WorkspaceFileOpenTarget,
    'path'
  > | null>(() => {
    if (!input.scope) return null;
    if (workspaceRefId)
      return {
        kind: 'project',
        workspaceRefId,
        serverId: input.scope.serverId,
        machineId: input.scope.machineId,
        rootPath: input.scope.rootPath,
      };
    return input.sessionId
      ? {
          kind: 'session',
          sessionId: input.sessionId,
          serverId: input.scope.serverId,
        }
      : null;
  }, [input.scope, input.sessionId, workspaceRefId]);
  const fileTargetRef = React.useRef(fileTarget);
  fileTargetRef.current = fileTarget;

  const openLocation = React.useCallback(
    async (
      location: Readonly<{
        path: string;
        range: Readonly<{ start: Readonly<{ line: number }> }>;
      }>,
    ) => {
      const target = fileTargetRef.current;
      if (!target) return;
      await opener.open(
        { ...target, path: location.path } as WorkspaceFileOpenTarget,
        {
          intent: 'preview',
          rootPath: input.scope?.rootPath,
          anchor: {
            kind: 'fileLine',
            startLine: location.range.start.line + 1,
          },
        },
      );
    },
    [opener, input.scope?.rootPath],
  );

  const previewLifetime = captureActiveServerAccountScopeLifetime();
  const referencePreview = React.useMemo<CodeEditorLanguageIntelligence['referencePreview']>(() => {
    const scope = input.scope;
    const accountId = input.accountId;
    if (!scope || !accountId || !previewLifetime || previewLifetime.scope.accountId !== accountId
      || !selectActiveServerAccountScopeForServer(previewLifetime.scope, scope.serverId)) return undefined;
    const scopeKey = tryBuildWorkspaceCacheKey(scope);
    const current = () => previewLifetime.isCurrent() && latest.current.accountId === accountId
      && scopeKey !== null && latest.current.scope !== null && tryBuildWorkspaceCacheKey(latest.current.scope) === scopeKey;
    return {
      async readText(path, signal) {
        if (signal.aborted || !current()) return null;
        const held = readWorkspaceFileEditorHolder(scope, accountId, path)?.file?.read();
        if (held) return held.text ?? (held.unsaved ? null : held.savedText);
        // Reuse the File owner's classification, transfer custody and preview budget.
        const result = await refreshWorkspaceFileDetails({ scope, filePath: path, diffMode: 'both', includeDiff: false, signal });
        const file = result.fileContent;
        return signal.aborted || !current() || !file || file.isBinary || file.partial || file.encoding?.reason === 'notUtf8' ? null : file.content;
      },
      async openLocation(location) { if (current()) await openLocation(location); },
    };
  }, [input.scope?.serverId, input.scope?.machineId, input.scope?.rootPath, input.accountId, openLocation, previewLifetime]);
  const editorIntelligencePreferences = React.useMemo(() => ({ inlayHints, semanticHighlighting, referencePreview, nextEditKeys: !phone }), [inlayHints, semanticHighlighting, referencePreview, phone]);

  const showProblems = React.useCallback(() => {
    if (phone)
      interaction.open({
        anchor: null,
        via: 'command',
        references: false,
        problems: true,
      });
    else pane.openRight({ tabId: 'problems' });
  }, [interaction, pane, phone]);

  const aiSettings = useSetting('filesEditorAiSuggestionsV1');
  const aiSource = useFileEditorAiSuggestionSource({ settings: aiSettings, machineId: input.scope?.machineId ?? null,
    serverId: input.scope?.serverId ?? null, active: input.active && input.editing === true });
  const aiLifetime = captureActiveServerAccountScopeLifetime();
  const aiPort = React.useMemo<Omit<CodeInlineSuggestionPort, 'query'>>(() => ({
    getSettings: () => aiSettings,
    getModel: operation => operation === 'nextEdit' ? aiSource.nextEditModel : aiSource.model,
    onUsage: event => { if (aiLifetime?.isCurrent()) recordFileEditorAiSuggestionUsage(aiLifetime.scope, event); },
  }), [aiSettings, aiSource.model, aiSource.nextEditModel, aiLifetime]);
  const { controller, bindEditor } = useCodeIntelligence({
    scope: input.enabled || input.editing === true ? input.scope : null,
    path: input.filePath,
    languageId: input.language,
    active: input.active,
    editorIntelligencePreferences,
    editing: input.editing,
    inlineSuggestions: aiPort,
    liveValue: input.liveValue,
    displayedText: input.displayedText,
    getUnsaved: input.getUnsaved,
    editorHandleRef: input.editorHandleRef,
    openLocation,
    showProblems,
  });

  // The pointer's name changed: ask about it once the pointer rests (both the read view and the editor).
  React.useEffect(() => {
    if (!controller) return;
    let previous = controller.getSnapshot().selection;
    return controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      const selection = snapshot.selection;
      if (selection === previous) return;
      previous = selection;
      // A query re-reads the name it asks about (without the pointer's anchor); only the pointer moves the card.
      if (selection && selection === snapshot.querySelection) return;
      const state = interaction.getState();
      if (state && state.via !== 'hover') return;
      // Phones have no hover; a tap asks instead.
      if (phone) return;
      if (!selection?.anchor) {
        interaction.leave();
        return;
      }
      const anchor = selection.anchor;
      interaction.dwell(() => {
        if (controller.getSnapshot().selection !== selection) return;
        interaction.open({ anchor, via: 'hover', references: false });
        void controller.hover(selection.position);
      });
    });
  }, [controller, interaction, phone]);

  // Shift+F12 and Find references: desktop shows the References tab, a phone grows them in the sheet.
  React.useEffect(() => {
    if (!controller) return;
    let previousKind = controller.getSnapshot().kind;
    let previousQuery = controller.getSnapshot().querySelection;
    let previousResult = controller.getSnapshot().result;
    let previousStatus = controller.getSnapshot().status;
    return controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      const changed =
        snapshot.kind !== previousKind ||
        snapshot.querySelection !== previousQuery;
      const settled = snapshot.result !== previousResult || snapshot.status !== previousStatus;
      previousKind = snapshot.kind;
      previousQuery = snapshot.querySelection;
      previousResult = snapshot.result;
      previousStatus = snapshot.status;
      if (changed && snapshot.kind === 'references') {
        if (phone)
          interaction.open({
            anchor: interaction.getState()?.anchor ?? null,
            via: 'tap',
            references: true,
          });
        else {
          interaction.close();
          pane.openRight({ tabId: 'references' });
        }
      }
      if (
        (changed || settled) &&
        snapshot.kind === 'definition' &&
        snapshot.status === 'ready' &&
        snapshot.result &&
        'locations' in snapshot.result &&
        snapshot.result.locations.length > 0 &&
        snapshot.result.locations.every(
          (location) =>
            'outsideWorkspace' in location && location.outsideWorkspace,
        )
      ) {
        interaction.open({
          anchor:
            interaction.getState()?.anchor ??
            interaction.remembered() ??
            snapshot.querySelection?.anchor ??
            null,
          via: 'command',
          references: false,
        });
      }
    });
  }, [controller, interaction, pane, phone]);

  const viewBinding = React.useMemo<FileCodeIntelligenceBinding | null>(
    () =>
      controller
        ? {
            semantic: { controller, enabled: input.active && !input.editing && semanticHighlighting },
            getDiagnosticsByLine: createDiagnosticsByLineReader(
              controller,
              () => latest.current.filePath,
            ),
            subscribeDiagnostics: controller.subscribe,
            onPointer: (line, character, rect) =>
              controller.inspect({
                line: line - 1,
                character,
                ...(rect ? { anchor: rect } : {}),
              }),
            onPointerAway: () => {
              controller.inspect(null);
              interaction.leave();
            },
            onActivate: (line, character, activation) => {
              const position = { line: line - 1, character };
              controller.inspect({
                ...position,
                ...(activation.rect ? { anchor: activation.rect } : {}),
              });
              if (!controller.getSnapshot().selection) return false;
              if (activation.via === 'touch') {
                // After the sheet's room under the code has been laid out, so the line can scroll above it.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => latest.current.revealLine?.(line)),
                );
                interaction.open({
                  anchor: activation.rect,
                  via: 'tap',
                  references: false,
                });
                void controller.hover(position);
                return true;
              }
              interaction.close();
              interaction.remember(activation.rect);
              void controller.definition(position);
              return true;
            },
          }
        : null,
    [controller, interaction, input.active, input.editing, semanticHighlighting],
  );

  const snapshotForPage = useControllerSelector(
    controller,
    selectSummary,
    React.useCallback(
      (snapshot: CodeIntelligenceSnapshot) => {
        const note = resolveLanguageStateNote({
          snapshot,
          machineName: latest.current.machineName,
          machineUnreachable: latest.current.machineUnreachable,
        });
        const file = selectCodeDiagnostics(
          controller?.getDiagnosticsProjection() ?? {
            revision: -1,
            entries: {},
          },
          latest.current.filePath,
        );
        return JSON.stringify([
          note?.kind ?? null,
          note?.text ?? null,
          note?.detail ?? null,
          note?.action ?? null,
          file.state,
          file.count,
          snapshot.diagnostics?.count ?? null,
          snapshot.diagnostics?.state ?? null,
          snapshot.problemsScope ?? 'open',
          snapshot.projectDiagnostics?.state ?? null,
          snapshot.projectDiagnostics?.count ?? null,
        ]);
      },
      [controller],
    ),
  );
  const languageNote = snapshotForPage
    ? resolveLanguageStateNote({
        snapshot: snapshotForPage,
        machineName: input.machineName,
        machineUnreachable: input.machineUnreachable,
      })
    : null;
  const fileProblems = controller
    ? selectCodeDiagnostics(
        controller.getDiagnosticsProjection(),
        input.filePath,
      )
    : null;
  const problemsText = fileProblems
    ? formatProblemsFact({
        count: fileProblems.count,
        state: fileProblems.state,
        errors: fileProblems.items.filter((item) => item.severity === 'error')
          .length,
      })
    : null;
  const headerFacts = React.useMemo<readonly DetailsTabHeaderMetaFact[]>(
    () =>
      problemsText
        ? [
            {
              key: 'problems',
              text: problemsText,
              tone: 'failure',
              onPress: showProblems,
              testID: 'file-details-problems-fact',
              accessibilityLabel: t('files.pane.intelligence.showProblems'),
            },
          ]
        : [],
    [problemsText, showProblems],
  );

  const restart = React.useCallback(() => {
    void controller?.restart();
  }, [controller]);
  // One Check problems for the ⋯ entry, the shortcut's menu twin and the Problems tab's own button.
  const checkProblems = React.useCallback(() => {
    showProblems();
    void controller?.checkProblems();
  }, [controller, showProblems]);
  const checkProjectProblems = React.useCallback(() => {
    showProblems();
    void controller?.projectDiagnostics();
  }, [controller, showProblems]);
  // A missing managed server installs where every Machine install lives (the Machine's installables).
  const machineId = input.scope?.machineId ?? null;
  const serverId = input.scope?.serverId;
  const openInstallables = React.useCallback(() => {
    if (!machineId) return;
    router.push(
      machinePageHref({
        door: 'rail',
        target: { machineId, ...(serverId ? { serverId } : {}) },
        tab: { id: 'setup', page: 'tools' },
      }) as never,
    );
  }, [machineId, router, serverId]);
  const notice =
    languageNote ? (
      <SurfaceFreshnessLine
        testID="file-language-state-note"
        tone={languageNote.kind === 'failure' ? 'warning' : 'neutral'}
        busy={languageNote.kind === 'progress'}
        reason={
          languageNote.detail
            ? `${languageNote.text} ${languageNote.detail}`
            : languageNote.text
        }
        action={
          languageNote.action === 'restart'
            ? { label: t('files.pane.intelligence.restart'), onPress: restart }
            : languageNote.action === 'install' && machineId
              ? { label: t('common.install'), onPress: openInstallables }
              : undefined
        }
      />
    ) : null;

  // Ask {agent} to fix N problems (P5's Ask owner, one batch); unsaved-only problems save first.
  const projectScope = snapshotForPage?.problemsScope === 'project';
  const allProblems = projectScope ? snapshotForPage?.projectDiagnostics : snapshotForPage?.diagnostics;
  const readUnsavedProblems = React.useCallback(() => {
    const current = latest.current;
    if (!controller || !current.scope || !current.accountId) return false;
    const { scope, accountId } = current;
    const snapshot = controller.getSnapshot();
    const items = snapshot.problemsScope === 'project' ? snapshot.projectDiagnostics?.items ?? []
      : selectCodeDiagnostics(controller.getDiagnosticsProjection()).items;
    return items.some(item =>
      readWorkspaceFileEditorHolder(scope, accountId, item.path)?.file?.read().unsaved === true);
  }, [controller]);
  const unsaved = React.useSyncExternalStore(subscribeFileEditorActionOwners, readUnsavedProblems, () => false);
  const askCount =
    allProblems?.state === 'ready' ? (allProblems.count ?? 0) : 0;
  const askLabel =
    askCount > 0
      ? input.agentName
        ? unsaved
          ? t('files.pane.intelligence.saveAndAskAgent', {
              agent: input.agentName,
              count: askCount,
            })
          : t('files.pane.intelligence.askAgent', {
              agent: input.agentName,
              count: askCount,
            })
        : unsaved
          ? t('files.pane.intelligence.saveAndAsk', { count: askCount })
          : t('files.pane.intelligence.ask', { count: askCount })
      : null;
  // Without a Session composer on this page, Ask lands where the selection toolbar's Ask does (P5).
  const readAskTarget = React.useCallback(
    () => ({ openDetailsTab: pane.openDetailsTab }),
    [pane],
  );
  const askTargetContext = useAskSelectionTargetContext(readAskTarget);
  const askToFix = React.useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    if (!controller || !current.scope) return false;
    const workspaceScope = current.scope;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const owner = controller;
    const snapshot = owner.getSnapshot();
    const project = snapshot.problemsScope === 'project';
    const projection = project ? snapshot.projectDiagnostics : owner.getDiagnosticsProjection();
    if (!projection) return false;
    let failureMessage = t('errors.operationFailed');
    const failedRead = () => { failureMessage = t('files.fileReadFailed'); return null; };
    const result = await askCodeDiagnosticsToFix({
      projection,
      workspaceScope,
      sessionTarget: current.sessionId
        ? {
            sessionId: current.sessionId,
            revealSessionColumn,
          }
        : null,
      targetContext: askTargetContext(),
      isCurrent: () =>
        latestController.current === owner && (lifetime?.isCurrent() ?? true),
      readFile: async (path) => {
        if (!current.accountId) return failedRead();
        const held = readWorkspaceFileEditorHolder(workspaceScope, current.accountId, path)?.file?.read();
        if (held) return held;
        // View already holds this file's saved bytes even when no editor commands are mounted.
        if (path === current.filePath) {
          if (current.getUnsaved()) { failureMessage = t('files.fileWriteFailed'); return null; }
          return { savedText: current.displayedText ?? current.liveValue.get(), unsaved: false };
        }
        // Root diagnostics can include another read-only file with no editor-action holder.
        // Read each unique target only when Ask needs its saved context.
        const stat = await workspaceStatFile(workspaceScope, path);
        if (!lifetime?.isCurrent() || !stat.success || !stat.exists || stat.kind !== 'file' || typeof stat.sizeBytes !== 'number') return failedRead();
        const file = await workspaceReadFile(workspaceScope, path, { maxBytes: stat.sizeBytes, knownSizeBytes: stat.sizeBytes });
        if (!file.success) return failedRead();
        const decoded = await decodeWorkspaceFileText(file.content);
        return decoded.kind === 'text' ? { savedText: decoded.text, unsaved: false } : failedRead();
      },
      saveFileEdits: async (path) => {
        if (!current.accountId) return false;
        const holder = readWorkspaceFileEditorHolder(workspaceScope, current.accountId, path);
        const saved = await holder?.save();
        const succeeded = saved?.status === 'saved' || saved?.status === 'clean';
        if (!succeeded) failureMessage = t('files.fileWriteFailed');
        return succeeded;
      },
    });
    if (result.created === 0 && latestController.current === owner && lifetime?.isCurrent())
      Modal.alert(t('common.error'), failureMessage);
    return result.created > 0;
  }, [askTargetContext, controller, revealSessionColumn]);
  const latestController = React.useRef(controller);
  latestController.current = controller;

  const openReference = React.useCallback(
    (row: CodeReferenceRow) => {
      void openLocation({
        path: row.path,
        range: { start: { line: row.line } },
      });
    },
    [openLocation],
  );
  const openProblem = React.useCallback(
    (item: LanguageIntelligenceDiagnostic) => {
      void openLocation(item);
    },
    [openLocation],
  );

  // The pane's References / Problems tabs read this page while it is the active one.
  const askModel = React.useMemo(
    () => (askLabel ? { label: askLabel, run: askToFix } : null),
    [askLabel, askToFix],
  );
  // The page takes the tabs when it becomes active and keeps them while it stays open: choosing
  // Problems in the page's own column makes the page inactive, and the tab must not vanish with it.

  // ⌘P / @ queries project symbols, retaining this holder's outline as the explicit local baseline.
  const symbols = React.useMemo<WorkspaceSymbolSearchInput | null>(() => {
    if (!input.scope || !input.accountId || !(input.outlineEnabled ?? input.enabled))
      return null;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return null;
    const owner = controller;
    const holder = input.liveValue;
    const path = input.filePath;
    const scopeId = input.scopeId;
    return {
      target: {
        kind: 'workspaceFile',
        scope: input.scope,
        path: input.filePath,
        workspaceRefId,
        sessionId: workspaceRefId ? null : input.sessionId,
        serverId: input.scope.serverId,
        accountId: input.accountId,
      },
      resolverKey: `${input.scopeId}:${input.filePath}`,
      getText: () => latest.current.displayedText ?? latest.current.liveValue.get(),
      flushPendingChange: async () => {
        await latest.current.editorHandleRef.current?.flushPendingChange();
      },
      ...(owner ? { getServerOutline: (signal: AbortSignal) => owner.outline(signal) } : {}),
      ...(owner ? { getWorkspaceSymbols: (query: string, signal: AbortSignal) => owner.workspaceSymbol(query, signal) } : {}),
      isCurrent: () => latestController.current === owner && latest.current.liveValue === holder
        && latest.current.filePath === path && latest.current.scopeId === scopeId,
      accountLifetime: lifetime,
      language: input.language ?? 'text',
      isDark: theme.dark === true,
      unavailableHint: t('common.unavailable'),
      loadingHint: t('files.pane.intelligence.checking'),
      baselineHint: t('universalSearch.quickOpen.symbolsInFile', { file: input.filePath.split('/').at(-1) ?? input.filePath }),
    };
  }, [
    controller,
    input.accountId,
    input.enabled,
    input.outlineEnabled,
    input.liveValue,
    input.filePath,
    input.language,
    input.scope,
    input.scopeId,
    input.sessionId,
    theme.dark,
    workspaceRefId,
  ]);
  const publication = React.useRef<Readonly<{ scopeId: string; producer: CodeIntelligencePaneProducer }> | null>(null);
  React.useEffect(() => {
    const current = publication.current;
    const release = () => {
      if (current) releaseCodeIntelligencePaneProducer(current.scopeId, current.producer);
      publication.current = null;
    };
    if (!controller) return release();
    const producer: CodeIntelligencePaneProducer = {
      controller,
      path: input.filePath,
      machineName: input.machineName,
      machineUnreachable: input.machineUnreachable,
      openReference,
      openProblem,
      checkProblems,
      checkProjectProblems,
      ask: askModel,
    };
    const scopeId = input.scopeId;
    if (input.active) {
      release();
      publishCodeIntelligencePaneProducer(scopeId, producer);
      publication.current = { scopeId, producer };
      return;
    }
    // Stepped back: refresh what it offers (its Ask follows its problems) while it still owns the tabs.
    if (current?.scopeId === scopeId && refreshCodeIntelligencePaneProducer(scopeId, current.producer, producer))
      publication.current = { scopeId, producer };
    else release();
  }, [
    askModel,
    checkProblems,
    checkProjectProblems,
    controller,
    input.active,
    input.filePath,
    input.machineName,
    input.machineUnreachable,
    input.scopeId,
    openProblem,
    openReference,
  ]);

  React.useEffect(() => () => {
    const current = publication.current;
    if (current) releaseCodeIntelligencePaneProducer(current.scopeId, current.producer);
  }, []);

  const search = React.useMemo(
    () =>
      input.scope
        ? {
            scope: {
              accountId: input.accountId,
              serverId: input.scope.serverId,
              sessionId: workspaceRefId ? null : input.sessionId,
              machineId: input.scope.machineId,
              rootPath: input.scope.rootPath,
            },
            ...(symbols ? { symbols } : {}),
          }
        : undefined,
    [input.accountId, input.scope, input.sessionId, workspaceRefId, symbols],
  );

  // F2 / Alt+Enter, the ⋯ menu and the card's Fix: the name at the editor's caret, else the name last pointed at.
  const openEditSet = React.useCallback(
    (op: CodeEditSetRequest['op']): 'handled' | 'pass' => {
      if (!controller) return 'pass';
      const editor = latest.current.editorHandleRef.current;
      const cursor = editor?.getCursorPosition?.();
      const snapshot = controller.getSnapshot();
      const known = snapshot.querySelection ?? snapshot.selection;
      const position = cursor
        ? { line: cursor.line - 1, character: cursor.character }
        : known?.position;
      if (!position) return 'pass';
      const identifier = cursor
        ? resolveCodeIdentifier(latest.current.liveValue.get(), position, latest.current.language)
        : known?.identifier ?? null;
      if (!identifier) return 'pass';
      // The card's anchor, else the pointer's name (a query re-reads its name without the anchor), else the caret's line.
      const anchor = interaction.getState()?.anchor
        ?? (cursor ? (editor?.getLineRect?.(position.line + 1) ?? null)
          : (snapshot.selection?.anchor ?? known?.anchor ?? interaction.remembered()));
      interaction.close();
      editSets.open({ op, anchor, line: position.line, character: identifier.startCharacter, symbol: identifier.symbol });
      return 'handled';
    },
    [controller, editSets, interaction],
  );
  useKeyboardShortcutHandlers(
    React.useMemo(
      () =>
        input.active && controller
          ? {
              'code.rename': () => openEditSet('rename'),
              'code.quickFix': () => openEditSet('fixes'),
              'code.checkProjectProblems': () => { checkProjectProblems(); return 'handled' as const; },
            }
          : {},
      [controller, input.active, openEditSet, checkProjectProblems],
    ),
  );

  const navigate = React.useCallback((kind: 'typeDefinition' | 'implementation', inspected?: CodeIntelligencePosition) => {
    if (!controller) return 'pass' as const;
    const cursor = latest.current.editorHandleRef.current?.getCursorPosition?.();
    const position = inspected ?? (cursor ? { line: cursor.line - 1, character: cursor.character } : controller.getSnapshot().selection?.position);
    if (!position) return 'pass' as const;
    void controller.request(kind, { position }).then(result => {
      if (result?.status !== 'ok' || (result.kind !== 'typeDefinition' && result.kind !== 'implementation')) return;
      const target = result.locations.find(location => !location.outsideWorkspace);
      if (target) void openLocation(target);
    });
    return 'handled' as const;
  }, [controller, openLocation]);
  const editorCommands = React.useMemo(() => {
    const run = (command: CodeEditorLanguageCommand) => {
      const editor = latest.current.editorHandleRef.current;
      if (!latest.current.editing && ['format', 'formatSelection', 'organizeImports'].includes(command)) {
        if (!controller) return 'pass' as const;
        const range = command === 'formatSelection' ? latest.current.getReadSelectionRange?.() : undefined;
        if (command === 'formatSelection' && !range) return 'pass' as const;
        interaction.close();
        editSets.open({ op: command as 'format' | 'formatSelection' | 'organizeImports', anchor: null,
          line: 0, character: 0, symbol: '', ...(range ? { range } : {}) });
        return 'handled' as const;
      }
      if (!latest.current.editing || !editor?.runCommand) return 'pass' as const;
      if (command === 'peekReferences' && phone && controller) {
        const at = editor.getCursorPosition?.();
        if (at) void controller.references({ line: at.line - 1, character: at.character });
      } else editor.runCommand(command);
      return 'handled' as const;
    };
    return {
      'code.goToTypeDefinition': () => navigate('typeDefinition'), 'code.goToImplementation': () => navigate('implementation'),
      'code.format': () => run('format'), 'code.formatSelection': () => run('formatSelection'), 'code.organizeImports': () => run('organizeImports'),
      ...(input.editing ? {
        'code.suggest': () => run('suggest'), 'code.signatureHelp': () => run('signatureHelp'),
        'code.expandSelection': () => run('expandSelection'), 'code.shrinkSelection': () => run('shrinkSelection'), 'code.peekReferences': () => run('peekReferences'),
      } : {}),
    };
  }, [controller, editSets, input.editing, interaction, navigate, phone]);
  useKeyboardShortcutHandlers(React.useMemo(() => input.active ? editorCommands : {}, [editorCommands, input.active]));

  const menuCommands = React.useMemo(
    () =>
      controller
        ? {
            // Keyboard dispatch consumes handled/pass; menu invocation has no propagation result.
            ...Object.fromEntries(Object.entries(editorCommands).map(([id, run]) => [id, () => { run(); }])) as {
              [Key in keyof typeof editorCommands]: () => void;
            },
            'code.rename': () => {
              openEditSet('rename');
            },
            'code.quickFix': () => {
              openEditSet('fixes');
            },
            'code.goToDefinition': () => {
              runCursor(controller, input.editorHandleRef, 'definition');
            },
            'code.showInfo': () => {
              const anchor = runCursor(
                controller,
                input.editorHandleRef,
                'hover',
              );
              if (anchor !== undefined)
                interaction.open({ anchor, via: 'command', references: false });
            },
            'code.restart': restart,
            'code.showProblems': checkProblems,
            'code.checkProjectProblems': checkProjectProblems,
          }
        : undefined,
    [checkProblems, checkProjectProblems, controller, editorCommands, input.editorHandleRef, interaction, openEditSet, restart],
  );

  const saveThisFile = React.useCallback(async () => {
    const current = latest.current;
    if (!current.scope || !current.accountId) return false;
    const saved = await readWorkspaceFileEditorHolder(current.scope, current.accountId, current.filePath)?.save();
    return saved?.status === 'saved' || saved?.status === 'clean';
  }, []);
  const layer = controller ? (
    <FileCodeIntelligenceCardLayer
      controller={controller}
      interaction={interaction}
      machineName={input.machineName}
      machineUnreachable={input.machineUnreachable}
      filePath={input.filePath}
      scopeId={input.scopeId}
      onOpenReference={openReference}
      onQuickFix={() => openEditSet('fixes')}
      onRename={() => openEditSet('rename')}
      onTypeDefinition={position => { navigate('typeDefinition', position); }}
      onImplementation={position => { navigate('implementation', position); }}
    />
  ) : null;
  // The rename / quick-fix flow mounts inside the page body: its review takes that region like Changes do.
  const editSetLayer = controller && input.scope ? (
    <FileCodeEditSetLayer
      store={editSets}
      controller={controller}
      scope={input.scope}
      accountId={input.accountId}
      filePath={input.filePath}
      languageId={input.language}
      machineName={input.machineName}
      readText={input.liveValue.get}
      isUnsaved={input.getUnsaved}
      save={saveThisFile}
    />
  ) : null;

  // Phones: while the name sheet is up, the code gets room beneath it so the tapped line can sit above it.
  const { height: windowHeight } = usePresentationWindowDimensions();
  const phoneSheetOpen = React.useSyncExternalStore(
    interaction.subscribe,
    () => phone && interaction.getState() !== null,
    () => false,
  );
  const wasPhoneSheetOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasPhoneSheetOpen.current && !phoneSheetOpen) latest.current.revealLine?.(null);
    wasPhoneSheetOpen.current = phoneSheetOpen;
  }, [phoneSheetOpen]);
  const phoneSheetInset = phoneSheetOpen
    ? Math.round(windowHeight * PHONE_SHEET_RESERVE)
    : 0;
  const openAiSettings = React.useCallback(() => {
    router.push(buildSettingHref('/settings/source-control', SOURCE_CONTROL_SETTINGS.settings.aiSuggestionsEnabled) as never);
  }, [router]);
  const aiFooter = input.editing && controller
    ? <><FileAiSuggestionStatus controller={controller} enabled={aiSettings.enabled} onOpenSettings={openAiSettings} /><FileNextEditAnnouncer controller={controller} /></> : null;
  return {
    controller,
    bindEditor,
    viewBinding,
    phoneSheetInset,
    headerFacts,
    notice,
    aiFooter,
    layer,
    editSetLayer,
    menuCommands,
    symbols,
    search,
    showProblems,
  };
}

/**
 * The predicted next edit is drawn inside the engine, so a screen reader hears it here: once when it is offered and
 * once when its preview opens (P7 A3 accessibility). Renders nothing and never re-renders on keystrokes.
 */
function FileNextEditAnnouncer(props: Readonly<{ controller: CodeIntelligenceController }>) {
  React.useEffect(() => {
    const operation = props.controller.nextEditSuggestions;
    let announced: string | null = null;
    return operation.subscribe(() => {
      const snapshot = operation.getSnapshot();
      const first = snapshot.suggestion?.edits[0];
      if (!snapshot.suggestion || !first || (snapshot.status !== 'ready' && snapshot.status !== 'preview')) { announced = null; return; }
      const key = `${snapshot.suggestion.id}:${snapshot.status}`;
      if (announced === key) return;
      announced = key;
      const line = first.range.start.line + 1;
      const result = snapshot.suggestion.previewText.split(/\r\n|\r|\n/u)[first.range.start.line]?.trim() ?? first.newText;
      announceAccessibilityMessage(snapshot.status === 'ready'
        ? t('files.editing.aiSuggestions.nextEditAnnounceReady', { line })
        : t('files.editing.aiSuggestions.nextEditAnnouncePreview', { line, text: result }));
    });
  }, [props.controller]);
  return null;
}

/** Only this quiet footer leaf observes inference state; keystrokes never subscribe the File page. */
function FileAiSuggestionStatus(props: Readonly<{ controller: CodeIntelligenceController; enabled: boolean; onOpenSettings(): void }>) {
  const operation = props.controller.inlineSuggestions;
  const enabled = props.enabled;
  const read = React.useCallback((): AiSuggestionFooterState => resolveAiSuggestionFooterState(operation.getSnapshot(), { enabled }), [enabled, operation]);
  const state = React.useSyncExternalStore(operation.subscribe, read, () => null);
  return <AiSuggestionStatus state={state} onOpenSettings={props.onOpenSettings} />;
}

/**
 * This file's problems by 1-based line for squiggles (View and Changes), re-read only when the
 * diagnostics projection changes, so pointer answers never re-render the code rows.
 */
function createDiagnosticsByLineReader(
  controller: CodeIntelligenceController,
  path: () => string,
): () => ReadonlyMap<number, readonly CodeLineDiagnosticRange[]> | undefined {
  let projection: ReturnType<CodeIntelligenceController['getDiagnosticsProjection']> | null = null;
  let forPath = '';
  let value: ReadonlyMap<number, readonly CodeLineDiagnosticRange[]> | undefined;
  return () => {
    const next = controller.getDiagnosticsProjection();
    const currentPath = path();
    if (next === projection && currentPath === forPath) return value;
    projection = next;
    forPath = currentPath;
    const byLine = new Map<number, CodeLineDiagnosticRange[]>();
    for (const item of selectCodeDiagnostics(next, currentPath, { currentOnly: true }).items) {
      const { start, end } = item.range;
      for (let line = start.line; line <= end.line; line++) {
        const list = byLine.get(line + 1) ?? [];
        byLine.set(line + 1, list);
        list.push({
          start: line === start.line ? start.character : 0,
          // Through the line's end; rows clamp to their text.
          end: line === end.line ? Math.max(end.character, start.line === end.line ? start.character + 1 : 0) : Number.MAX_SAFE_INTEGER,
          severity: item.severity,
        });
      }
    }
    value = byLine.size > 0 ? byLine : undefined;
    return value;
  };
}

/** F12 / Info at the editor's caret; returns the anchor for a card, or undefined when there is no caret. */
function runCursor(
  controller: CodeIntelligenceController,
  editorHandleRef: React.RefObject<TextEditorHandle | null>,
  kind: 'definition' | 'hover',
): Rect | null | undefined {
  const editor = editorHandleRef.current;
  const cursor = editor?.getCursorPosition?.();
  const position = cursor
    ? { line: cursor.line - 1, character: cursor.character }
    : controller.getSnapshot().selection?.position;
  if (!position) return undefined;
  void controller[kind](position);
  return editor?.getLineRect?.(position.line + 1) ?? null;
}

const EMPTY_NAMES: readonly CodeIdentifier[] = [];

/** The card leaf: the only component that follows the pointer's answers. */
function FileCodeIntelligenceCardLayer(
  props: Readonly<{
    controller: CodeIntelligenceController;
    interaction: CardInteraction;
    machineName: string;
    machineUnreachable: boolean;
    filePath: string;
    scopeId: string;
    onOpenReference: (row: CodeReferenceRow) => void;
    onQuickFix: () => void;
    onRename: () => void;
    onTypeDefinition: (position: CodeIntelligencePosition) => void;
    onImplementation: (position: CodeIntelligencePosition) => void;
  }>,
) {
  const { controller, interaction } = props;
  const writeClipboard = useClipboardWrite();
  const state = React.useSyncExternalStore(
    interaction.subscribe,
    interaction.getState,
    () => null,
  );
  const snapshot = useCodeIntelligenceSnapshot(state ? controller : null);
  const query = snapshot.querySelection ?? snapshot.selection;
  const model = React.useMemo<CodeIntelligenceCardModel>(() => {
    const hover =
      snapshot.kind === 'hover' ? readCodeHoverContent(snapshot.result) : null;
    const position = query?.position;
    const diagnostics = selectCodeDiagnostics(
      controller.getDiagnosticsProjection(),
      props.filePath,
      { currentOnly: true },
    ).items;
    const diagnostic = position
      ? (diagnostics.find(
          (item) =>
            (item.range.start.line < position.line ||
              (item.range.start.line === position.line &&
                item.range.start.character <= position.character)) &&
            (item.range.end.line > position.line ||
              (item.range.end.line === position.line &&
                item.range.end.character >= position.character)),
        ) ?? null)
      : null;
    const outside =
      snapshot.kind === 'definition' &&
      snapshot.result &&
      'locations' in snapshot.result
        ? (snapshot.result.locations.find(
            (location) =>
              'outsideWorkspace' in location && location.outsideWorkspace,
          )?.path ?? null)
        : null;
    const progress = resolveLanguageStateNote({
      snapshot,
      machineName: props.machineName,
      machineUnreachable: props.machineUnreachable,
    });
    const server = readLanguageServerLabel(snapshot.servers, hover?.serverLabel);
    const references =
      state?.references && snapshot.kind === 'references'
        ? {
            rows:
              snapshot.result && 'locations' in snapshot.result
                ? snapshot.result.locations.map((location) => ({
                    path: location.path,
                    line: location.range.start.line,
                    startCharacter: location.range.start.character,
                    endCharacter:
                      location.range.end.line === location.range.start.line
                        ? location.range.end.character
                        : location.range.start.character,
                    lineText: 'lineText' in location ? location.lineText : '',
                  }))
                : [],
            textMatches: snapshot.mode === 'fallback',
            partial: isCodeReferenceResultPartial(snapshot.result),
            searching:
              snapshot.status === 'searching' || snapshot.status === 'loading',
          }
        : null;
    return {
      name: query?.identifier ?? null,
      names: query?.names ?? EMPTY_NAMES,
      hover,
      diagnostic,
      outsidePath: outside,
      progress: progress?.kind === 'progress' ? progress : null,
      searching: snapshot.status === 'searching',
      sourceLabel:
        snapshot.mode === 'server' && server
          ? `${server} · ${props.machineName}`
          : null,
      references,
    };
  }, [
    controller,
    props.filePath,
    props.machineName,
    props.machineUnreachable,
    query,
    snapshot,
    state?.references,
  ]);
  // A hover with nothing to say stays closed; a tap, a command or a phone sheet always answers.
  const quietHover =
    state?.via === 'hover' &&
    !model.hover &&
    !model.diagnostic &&
    !model.progress &&
    !model.outsidePath;
  const open =
    state !== null &&
    !quietHover &&
    (state.via !== 'hover' ||
      snapshot.status !== 'searching' ||
      Boolean(model.hover));
  const close = React.useCallback(() => {
    interaction.close();
    controller.dismiss();
  }, [controller, interaction]);
  const position = query?.position ?? null;
  if (state?.problems) {
    return <CodeProblemsSheet scopeId={props.scopeId} onRequestClose={close} />;
  }
  return (
    <CodeIntelligenceCard
      open={open}
      anchor={state?.anchor ?? query?.anchor ?? null}
      model={model}
      referencesContent={model.references ? (
        <CodeReferencesPanel
          key={props.filePath}
          controller={controller}
          position={position}
          supportsCalls={snapshot.capabilities?.callHierarchy === true}
          references={{
            ...model.references,
            progress: model.progress,
            onOpen: row => {
              interaction.close();
              props.onOpenReference(row);
            },
          }}
        />
      ) : null}
      onRequestClose={close}
      onHoverChange={interaction.setCardHovered}
      onDefinition={() => {
        if (position) {
          interaction.close();
          void controller.definition(position);
        }
      }}
      onReferences={() => {
        if (position) void controller.references(position);
      }}
      onCopyName={() => {
        if (model.name) void writeClipboard(model.name.symbol);
      }}
      onCopyPath={(path) => {
        void writeClipboard(path);
      }}
      onChooseName={(name) => {
        if (!position) return;
        const next = { line: position.line, character: name.startCharacter };
        controller.inspect(next);
        void controller.hover(next);
      }}
      onOpenReference={(row) => {
        interaction.close();
        props.onOpenReference(row);
      }}
      onQuickFix={props.onQuickFix}
      onRename={props.onRename}
      onTypeDefinition={snapshot.capabilities?.typeDefinition && position ? () => {
        interaction.close(); props.onTypeDefinition(position);
      } : undefined}
      onImplementation={snapshot.capabilities?.implementation && position ? () => {
        interaction.close(); props.onImplementation(position);
      } : undefined}
    />
  );
}

/** The rename / quick-fix leaf: mounts the flow only while one is open. */
function FileCodeEditSetLayer(
  props: Readonly<{
    store: EditSetStore;
    controller: CodeIntelligenceController;
    scope: WorkspaceScopeBase;
    accountId: string | null;
    filePath: string;
    languageId: string | null;
    machineName: string;
    readText: () => string;
    isUnsaved: () => boolean;
    save: () => Promise<boolean>;
  }>,
) {
  const request = React.useSyncExternalStore(props.store.subscribe, props.store.get, () => null);
  if (!request) return null;
  const server = readLanguageServerLabel(props.controller.getSnapshot().servers);
  return (
    <CodeEditSetPopover
      key={`${request.op}:${request.line}:${request.character}`}
      request={request}
      scope={props.scope}
      accountId={props.accountId}
      filePath={props.filePath}
      languageId={props.languageId}
      readText={props.readText}
      isUnsaved={props.isUnsaved}
      save={props.save}
      syncDocument={props.controller.syncDocument}
      sourceLabel={server ? `${server} · ${props.machineName}` : null}
      onRequestClose={props.store.close}
    />
  );
}
