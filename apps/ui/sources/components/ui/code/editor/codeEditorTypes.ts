import { normalizeCodeLanguageId } from '@/utils/code/normalizeCodeLanguageId';

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
