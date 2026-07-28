export function looksLikeFreeformQuestionHintLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('type') || normalized.includes('enter') || normalized.includes('your own answer');
}
