export function getGlobalHookSettings(): string | null {
    return null;
}

export function setGlobalHookSettings(_value: string): void {
    // Web QA/dev bundles do not persist native React DevTools hook settings.
}
