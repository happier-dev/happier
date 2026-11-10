import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderConnectionIdSchema, ProviderModelIdSchema } from '../../providers/ids.js';

export const FilesEditorAiSuggestionsV1Schema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.boolean(), false),
    nextEditEnabled: z._default(z.boolean(), false),
    mode: z._default(z.enum(['automatic', 'onRequest']), 'automatic'),
    connectionId: z._default(z.nullable(ProviderConnectionIdSchema), null),
    modelId: z._default(z.nullable(ProviderModelIdSchema), null),
    nextEditModelId: z._default(z.nullable(ProviderModelIdSchema), null),
    delay: z._default(z.enum(['fast', 'normal', 'relaxed']), 'normal'),
    excludedGlobs: z._default(z.array(z.string().check(z.minLength(1))), ['**/.env*', '**/secrets', '**/secrets/**', '**/secrets.*']),
    disabledLanguageIds: z._default(z.array(z.string().check(z.minLength(1))), []),
}));

export type FilesEditorAiSuggestionsV1 = z.infer<typeof FilesEditorAiSuggestionsV1Schema>;
export const DEFAULT_FILES_EDITOR_AI_SUGGESTIONS_V1: FilesEditorAiSuggestionsV1 = FilesEditorAiSuggestionsV1Schema.parse({});

export type FilesEditorAiSuggestionOperation = 'inline' | 'nextEdit';

/** The configured candidate only. Admission must still check its declared operation;
 * an explicit next-edit choice never falls back to another model. */
export function resolveFilesEditorAiSuggestionModelId(settings: FilesEditorAiSuggestionsV1, operation: FilesEditorAiSuggestionOperation): string | null {
    return operation === 'nextEdit' ? settings.nextEditModelId ?? settings.modelId : settings.modelId;
}

/** Pause preferences, not inference deadlines or measured latency promises. Normal follows the editor's 250ms preference. */
export function resolveFilesEditorAiSuggestionDelayMs(delay: FilesEditorAiSuggestionsV1['delay']): number {
    return { fast: 125, normal: 250, relaxed: 500 }[delay];
}

function matchesExcludedGlob(path: string, pattern: string): boolean {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    let expression = '^';
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (char === '*' && normalized[index + 1] === '*') {
            index += 1;
            if (normalized[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
            else expression += '.*';
        } else if (char === '*') expression += '[^/]*';
        else if (char === '?') expression += '[^/]';
        else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${expression}$`).test(path);
}

/** One policy decision shared by the editor and the Machine before resolving credentials. */
export function resolveFilesEditorAiSuggestionPolicy(
    settings: FilesEditorAiSuggestionsV1,
    document: Readonly<{ path: string; languageId: string; operation?: FilesEditorAiSuggestionOperation }>,
): 'off' | 'excluded' | 'language_disabled' | 'model_unavailable' | null {
    if (!settings.enabled) return 'off';
    const path = document.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (settings.excludedGlobs.some((pattern) => matchesExcludedGlob(path, pattern))) return 'excluded';
    if (settings.disabledLanguageIds.includes(document.languageId)) return 'language_disabled';
    if (!settings.connectionId || !resolveFilesEditorAiSuggestionModelId(settings, document.operation ?? 'inline')) return 'model_unavailable';
    return null;
}
