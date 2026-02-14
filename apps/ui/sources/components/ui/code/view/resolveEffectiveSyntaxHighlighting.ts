import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

export type EffectiveSyntaxHighlighting = Readonly<{
    mode: 'off' | 'simple' | 'advanced';
    language: string | null;
    maxLineLength: number;
}>;

export function resolveEffectiveSyntaxHighlighting(params: Readonly<{
    lines: readonly CodeLine[];
    config?: CodeLinesSyntaxHighlightingConfig;
}>): EffectiveSyntaxHighlighting {
    const cfg = params.config;
    if (!cfg || cfg.mode === 'off') {
        return { mode: 'off', language: null, maxLineLength: 0 };
    }

    // Best-effort perf guardrails: treat JS string length as bytes (works well for ASCII source).
    if (params.lines.length > cfg.maxLines) {
        return { mode: 'off', language: null, maxLineLength: 0 };
    }
    let totalChars = 0;
    for (const line of params.lines) {
        totalChars += (line.renderCodeText ?? '').length;
        if (totalChars > cfg.maxBytes) {
            return { mode: 'off', language: null, maxLineLength: 0 };
        }
    }

    return { mode: cfg.mode, language: cfg.language, maxLineLength: cfg.maxLineLength };
}

