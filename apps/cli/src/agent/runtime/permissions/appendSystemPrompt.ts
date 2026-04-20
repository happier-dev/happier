type AppendSystemPromptFieldCarrier = Readonly<{
    appendSystemPrompt?: unknown;
}> | null | undefined;

function hasAppendSystemPromptField(value: AppendSystemPromptFieldCarrier): value is Readonly<{
    appendSystemPrompt?: unknown;
}> {
    return !!value && Object.prototype.hasOwnProperty.call(value, 'appendSystemPrompt');
}

function normalizeAppendSystemPromptValue(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function resolveAppendSystemPromptModeOverride(
    metadata: AppendSystemPromptFieldCarrier,
): { appendSystemPrompt?: string | null } {
    if (!hasAppendSystemPromptField(metadata)) {
        return {};
    }

    return {
        appendSystemPrompt: normalizeAppendSystemPromptValue(metadata.appendSystemPrompt),
    };
}

export function resolveAppendSystemPromptBaseOverride(mode: AppendSystemPromptFieldCarrier): string | null | undefined {
    if (!hasAppendSystemPromptField(mode)) {
        return undefined;
    }

    return normalizeAppendSystemPromptValue(mode.appendSystemPrompt);
}

export function resolveAppendSystemPromptQueueKeyValue(
    mode: AppendSystemPromptFieldCarrier,
): string | null | '__unset__' {
    if (!hasAppendSystemPromptField(mode)) {
        return '__unset__';
    }

    return normalizeAppendSystemPromptValue(mode.appendSystemPrompt);
}
