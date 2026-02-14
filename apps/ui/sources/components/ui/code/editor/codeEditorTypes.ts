export type CodeEditorProps = Readonly<{
    resetKey: string;
    value: string;
    language: string | null;
    onChange: (value: string) => void;
    readOnly?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
}>;

export function resolveMonacoLanguageId(language: string | null): string {
    if (!language) return 'plaintext';
    const lang = language.toLowerCase();
    if (lang === 'ts' || lang === 'typescript') return 'typescript';
    if (lang === 'js' || lang === 'javascript') return 'javascript';
    if (lang === 'json') return 'json';
    if (lang === 'md' || lang === 'markdown') return 'markdown';
    if (lang === 'py' || lang === 'python') return 'python';
    return 'plaintext';
}
