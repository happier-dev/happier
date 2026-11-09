import * as React from 'react';

import type { TextEditorHandle, EditorDecoration, Rect, CodeEditorLanguageIntelligence } from '@/components/ui/code/editor/codeEditorTypes';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineCodeIntelligenceFallback, machineLanguageIntelligenceSync, machineLanguageIntelligenceQuery,
    machineLanguageIntelligenceWatch, machineLanguageIntelligenceRestartAction } from '@/sync/ops/machineLanguageIntelligence';
import { useWorkspaceFileWriteSettlements } from '@/sync/domains/session/changes/hooks/useWorkspaceFileWriteSettlements';
import { bindCodeDiagnosticDecorations } from './codeDiagnostics';
import { forwardCodeIntelligenceSettlements } from './codeIntelligenceSettlements';
import { bindCodeIntelligenceEditor } from './bindCodeIntelligenceEditor';
import type { CodeIntelligenceController, CodeIntelligenceControllerInput, CodeIntelligenceSnapshot } from './createCodeIntelligenceController';
import { useCodeIntelligenceController } from './useCodeIntelligenceController';
import { DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1 } from '@happier-dev/protocol/account/settings/accountSettings';
import type { CodeInlineSuggestionPort, CodeInlineSuggestionUsage } from './codeInlineSuggestions';
import type { LanguageIntelligenceQueryInput } from '@happier-dev/protocol/machines/languageIntelligence';

export type UseCodeIntelligenceInput = Readonly<{
    scope: WorkspaceScopeBase | null;
    path: string;
    languageId: string | null;
    /** Command focus only; the mounted File page owns the document lifetime. */
    active: boolean;
    /** Entering Edit warms the existing holder; reading modes stay on demand. */
    editing?: boolean;
    editorIntelligencePreferences?: Pick<CodeEditorLanguageIntelligence, 'inlayHints' | 'semanticHighlighting' | 'referencePreview' | 'nextEditKeys'>;
    inlineSuggestions?: Omit<CodeInlineSuggestionPort, 'query'>;
    /** P4 owns the buffer; this hook never subscribes the File page to keystrokes. */
    liveValue: Readonly<{ get(): string; subscribe?(listener: () => void): () => void }>;
    /** Selected reading text; undefined keeps the editor's live draft basis. */
    displayedText?: string;
    unsaved?: boolean;
    /** Prefer P4 readSnapshot().dirty so the first edit is fenced before a React commit. */
    getUnsaved?(): boolean;
    editorHandleRef?: React.RefObject<TextEditorHandle | null>;
    accountLifetime?: ServerAccountScopeLifetime | null;
    openLocation: CodeIntelligenceControllerInput['openLocation'];
    showProblems?(): void;
    onDiagnosticPress?(item: Extract<EditorDecoration, { severity: string }>, rect: Rect | null): void;
}>;

const INACTIVE_SNAPSHOT: CodeIntelligenceSnapshot = Object.freeze({ mode: 'fallback', status: 'idle', selection: null, querySelection: null, kind: null, result: null });
const noSubscription = () => () => undefined;
const getInactiveSnapshot = () => INACTIVE_SNAPSHOT;

/** Presentation leaves subscribe here; the File page keeps one stable controller. */
export function useCodeIntelligenceSnapshot(controller: CodeIntelligenceController | null): CodeIntelligenceSnapshot {
    return React.useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? getInactiveSnapshot, getInactiveSnapshot);
}

export function useCodeIntelligence(input: UseCodeIntelligenceInput) {
    const latest = React.useRef(input);
    latest.current = input;
    const lifetime = input.scope
        ? input.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : input.accountLifetime
        : null;
    const serverId = input.scope?.serverId;
    const machineId = input.scope?.machineId;
    const rootPath = input.scope?.rootPath;
    const hasInlineSuggestions = Boolean(input.inlineSuggestions);
    const controllerInput = React.useMemo<CodeIntelligenceControllerInput | null>(() => {
        if (!serverId || !machineId || !rootPath || !lifetime) return null;
        return {
            scope: { serverId, machineId, rootPath }, path: input.path, languageId: input.languageId, accountLifetime: lifetime,
            getText: () => latest.current.displayedText ?? latest.current.liveValue.get(),
            getUnsaved: () => latest.current.getUnsaved?.() ?? latest.current.unsaved === true,
            subscribeText: listener => latest.current.liveValue.subscribe?.(listener) ?? (() => undefined),
            flushPendingChange: async () => { await latest.current.editorHandleRef?.current?.flushPendingChange(); },
            query: (request, signal) => machineCodeIntelligenceFallback(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
            languageServer: {
                sync: (request, signal) => machineLanguageIntelligenceSync(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
                query: (request, signal) => machineLanguageIntelligenceQuery(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
                watch: (request, signal) => machineLanguageIntelligenceWatch(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
                restart: signal => machineLanguageIntelligenceRestartAction(machineId, { rootPath }, { serverId, accountId: lifetime.scope.accountId, signal }),
            },
            ...(hasInlineSuggestions ? { inlineSuggestions: {
                getSettings: () => latest.current.inlineSuggestions?.getSettings() ?? DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1,
                getModel: (operation: Parameters<CodeInlineSuggestionPort['getModel']>[0]) => latest.current.inlineSuggestions?.getModel(operation) ?? null,
                query: (request: LanguageIntelligenceQueryInput, signal: AbortSignal) => machineLanguageIntelligenceQuery(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
                onUsage: (event: CodeInlineSuggestionUsage) => { if (lifetime.isCurrent()) latest.current.inlineSuggestions?.onUsage?.(event); },
            } } : {}),
            openLocation: location => latest.current.openLocation(location),
        };
    }, [input.path, input.languageId, input.liveValue, serverId, machineId, rootPath, lifetime, hasInlineSuggestions]);
    const controller = useCodeIntelligenceController(controllerInput);
    React.useEffect(() => {
        controller?.inlineSuggestions.setActive(input.active && input.editing === true);
    }, [controller, input.active, input.editing]);
    React.useEffect(() => { controller?.inlineSuggestions.refresh(); }, [controller, input.inlineSuggestions]);
    React.useEffect(() => {
        if (input.editing) void controller?.activate();
    }, [controller, input.editing]);
    React.useEffect(() => {
        // A presentation switch changes coordinates, not document ownership.
        // Reuse the passive controller and its versioned sync; dirty custody
        // continues to come from P4 even while saved bytes are displayed.
        controller?.dismiss();
        void controller?.syncDocument();
    }, [controller, input.displayedText]);
    useWorkspaceFileWriteSettlements(input.scope, paths => { void forwardCodeIntelligenceSettlements(paths, {
        acceptsExternalChanges: () => controller?.getSnapshot().capabilities?.acceptsExternalChanges === true,
        syncExternal: paths => controller?.external(paths) ?? Promise.resolve(),
    }); });

    const editorBinding = React.useRef<(() => void) | null>(null);
    const bindEditor = React.useCallback(() => {
        editorBinding.current?.();
        const editor = latest.current.editorHandleRef?.current;
        if (!controller || !editor) { editorBinding.current = null; return; }
        const stopPosition = bindCodeIntelligenceEditor(controller, editor, { path: latest.current.path,
            inlayHints: latest.current.editorIntelligencePreferences?.inlayHints ?? 'off', semanticHighlighting: latest.current.editorIntelligencePreferences?.semanticHighlighting ?? true,
            referencePreview: latest.current.editorIntelligencePreferences?.referencePreview, nextEditKeys: latest.current.editorIntelligencePreferences?.nextEditKeys });
        const stopDiagnostics = editor.setDecorations ? bindCodeDiagnosticDecorations({ handle: { setDecorations: editor.setDecorations }, path: latest.current.path,
            getProjection: controller.getDiagnosticsProjection, subscribe: controller.subscribe }) : () => undefined;
        const stopDecoration = editor.onDecorationPress?.((layer, item) => {
            if (layer === 'diagnostic' && 'severity' in item) latest.current.onDiagnosticPress?.(item, editor.getLineRect?.(item.startLine) ?? null);
        });
        editorBinding.current = () => { stopPosition(); stopDiagnostics(); stopDecoration?.(); };
    }, [controller, input.editorIntelligencePreferences]);
    React.useEffect(() => {
        bindEditor();
        return () => { editorBinding.current?.(); editorBinding.current = null; };
    }, [bindEditor]);
    const runAtCursor = React.useCallback((kind: 'hover' | 'definition' | 'references') => {
        if (!controller) return 'pass' as const;
        const cursor = latest.current.editorHandleRef?.current?.getCursorPosition?.();
        const position = cursor ? { line: cursor.line - 1, character: cursor.character } : controller.getSnapshot().selection?.position;
        if (!position) return 'pass' as const;
        void controller[kind](position);
        return 'handled' as const;
    }, [controller]);
    const runProblem = React.useCallback((direction: 1 | -1) => {
        if (!controller || !controller.getSnapshot().diagnostics?.items.length) return 'pass' as const;
        const cursor = latest.current.editorHandleRef?.current?.getCursorPosition?.();
        void controller.problem(direction, cursor ? { line: cursor.line - 1, character: cursor.character } : undefined);
        return 'handled' as const;
    }, [controller]);
    useKeyboardShortcutHandlers(React.useMemo(() => input.active && controller ? {
        'code.goToDefinition': () => runAtCursor('definition'),
        'code.findReferences': () => runAtCursor('references'),
        'code.showInfo': () => runAtCursor('hover'),
        'code.showProblems': () => { latest.current.showProblems?.(); void controller.checkProblems(); return 'handled' as const; },
        'code.problem.next': () => runProblem(1),
        'code.problem.previous': () => runProblem(-1),
        'code.restart': () => { void controller.restart(); return 'handled' as const; },
    } : {}, [input.active, controller, runAtCursor, runProblem]));

    return React.useMemo(() => ({ controller, bindEditor }), [controller, bindEditor]);
}
