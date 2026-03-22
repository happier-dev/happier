export function splitCommaSeparatedLabels(value: string): string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function looksLikeFreeformQuestionHintLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('type') || normalized.includes('enter') || normalized.includes('your own answer');
}
