import { normalizeCodeLanguageId } from '@/utils/code/normalizeCodeLanguageId';
import type { FindOptions, FindStatus } from '@happier-dev/plugin-ui/presentation';

export type CodeEditorFindTarget = Readonly<{ line: number; column?: number }>;
export type CodeEditorFindSnapshot = Readonly<{ query: string; options: FindOptions; status: FindStatus }>;
export type CodeEditorFindHandle = Readonly<{
    /** Monaco owns its widget; CodeMirror uses the host's shared bar. */
    presentation: 'native' | 'shared';
    /** Reveal/focus Find without replacing query state owned by the engine. */
    open: () => void;
    seed: (query: string, options: FindOptions, target?: CodeEditorFindTarget) => void;
    set: (query: string, options: FindOptions) => void;
    step: (direction: 1 | -1) => void;
    close: () => void;
    getSnapshot: () => CodeEditorFindSnapshot;
    subscribe: (listener: () => void) => () => void;
    containsFocus: () => boolean;
    isOpen: () => boolean;
    isInputFocused: () => boolean;
}>;

export type CodeEditorProps = Readonly<{
    resetKey: string;
    value: string;
    language: string | null;
    onChange: (value: string) => void;
    testID?: string;
    readOnly?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
}>;

export type CodeEditorHandle = Readonly<{
    getValue: () => string;
    flushPendingChange: () => Promise<void>;
    /** Move editing focus into the incumbent platform surface. */
    focus?: () => void;
    find?: CodeEditorFindHandle;
}>;

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
