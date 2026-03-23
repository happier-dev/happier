const GEMINI_PROMPT_DEBUG_PREVIEW_LENGTH = 100;

export function formatGeminiPromptDebugSummary(prompt: string): string {
    const preview = prompt.slice(0, GEMINI_PROMPT_DEBUG_PREVIEW_LENGTH);
    const suffix = prompt.length > GEMINI_PROMPT_DEBUG_PREVIEW_LENGTH ? '...' : '';

    return `[gemini] Sending prompt to Gemini (length: ${prompt.length}): ${preview}${suffix}`;
}
