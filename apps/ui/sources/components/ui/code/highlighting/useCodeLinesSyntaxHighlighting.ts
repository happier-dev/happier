import { useCodeSyntaxHighlighting, type CodeSyntaxHighlightingConfig } from './useCodeSyntaxHighlighting';

export type CodeLinesSyntaxHighlightingConfig = Readonly<{
    mode: CodeSyntaxHighlightingConfig['mode'];
    language: CodeSyntaxHighlightingConfig['language'];
    maxBytes: CodeSyntaxHighlightingConfig['maxBytes'];
    maxLines: CodeSyntaxHighlightingConfig['maxLines'];
    maxLineLength: CodeSyntaxHighlightingConfig['maxLineLength'];
}>;

export function useCodeLinesSyntaxHighlighting(filePath: string | null): CodeLinesSyntaxHighlightingConfig {
    return useCodeSyntaxHighlighting({ filePath });
}
