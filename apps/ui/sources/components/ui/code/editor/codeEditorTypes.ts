import { normalizeCodeLanguageId } from '@/utils/code/normalizeCodeLanguageId';
import type { CodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import type { LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';

/** Engine adapters consume the one controller; no transport, document or server owner lives here. */
export type CodeEditorLanguageIntelligence = Pick<CodeIntelligenceController, 'request' | 'getSnapshot' | 'subscribe'> & Readonly<{
    path: string;
    inlayHints: 'off' | 'parameters' | 'all';
    semanticHighlighting: boolean;
    nextEditSuggestions?: Pick<CodeIntelligenceController['nextEditSuggestions'], 'getSnapshot' | 'subscribe' | 'trigger' | 'dismiss' | 'tab'>;
    /** Tab/Esc hints beside a next edit; off where the phone key row carries Go/Apply/Dismiss instead. Default on. */
    nextEditKeys?: boolean;
    /** File-owner previews: mounted drafts first, otherwise the canonical file reader. */
    referencePreview?: Readonly<{
        readText(path: string, signal: AbortSignal): Promise<string | null>;
        openLocation(location: Readonly<{ path: string; range: LanguageIntelligenceRange }>): void | Promise<void>;
    }>;
}>;

export { CODE_EDITOR_LANGUAGE_COMMANDS } from '@happier-dev/plugin-ui/presentation/codeEditor';
export type { CodeEditorFindTarget, CodeEditorFindSnapshot, CodeEditorFindHandle, CodeEditorLanguageCommand, CodeEditorCommand, CodeEditorHistory, EditorDocumentHistory, Rect, EditorDecorationLayer, EditorDecoration, EditorBlameTone, CodeEditorDocumentChange, CodeEditorInlineContext, CodeEditorInlineSuggestion, CodeEditorInlineEvent, CodeEditorInlineSuggestions, CodeEditorProps } from '@happier-dev/plugin-ui/presentation';
import type { CodeEditorHandle as PortableCodeEditorHandle } from '@happier-dev/plugin-ui/presentation';
export type { CodeEditorSelectionRange, CodeEditorCompletionPosition, CodeEditorCompletionItem, CodeEditorCompletionSource } from '@happier-dev/plugin-ui/presentation';
export type CodeEditorHandle = PortableCodeEditorHandle & Readonly<{
    setLanguageIntelligence?: (port: CodeEditorLanguageIntelligence | null) => void;
    getSignatureHelp?: () => import('@happier-dev/protocol/machines/languageIntelligence').LanguageIntelligenceSignatureHelp | null;
    subscribeSignatureHelp?: (listener: () => void) => () => void;
}>;

/** Shared text-buffer capability for hosts that can also render a rich editor. */
export type TextEditorHandle = Pick<CodeEditorHandle, 'getValue' | 'flushPendingChange' | 'focus' | 'find'> & Partial<CodeEditorHandle>;

export function resolveMonacoLanguageId(language: string | null): string {
    const raw = normalizeCodeLanguageId(language);
    if (!raw) return 'plaintext';

    // Normalize common aliases/variants.
    if (raw === 'text' || raw === 'plaintext') return 'plaintext';
    if (raw === 'typescript' || raw === 'tsx') return 'typescript';
    if (raw === 'javascript' || raw === 'jsx') return 'javascript';
    if (raw === 'mdx') return 'markdown';
    if (raw === 'jsonc' || raw === 'json5') return 'json';
    if (raw === 'bash' || raw === 'zsh' || raw === 'dotenv' || raw === 'ssh-config') return 'shell';

    // Best-effort: pass through known language ids (Monaco basic languages are registered at runtime on web).
    return raw;
}
