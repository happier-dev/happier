// Expo's `expo-system-ui` is native-focused; the web bundle should not depend on it.
// Provide a minimal no-op surface so web export/build does not fail closed when the module
// is missing or intentionally excluded from the web runtime.

export async function setBackgroundColorAsync(_color: string): Promise<void> {}
