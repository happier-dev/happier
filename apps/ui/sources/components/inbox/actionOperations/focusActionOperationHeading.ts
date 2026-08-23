export function focusActionOperationHeading(
    node: Readonly<{ focus?: () => void }> | null,
    options: Readonly<{
        platform: string;
        setNativeFocus: (node: Readonly<{ focus?: () => void }>) => void;
    }>,
): void {
    node?.focus?.();
    if (!node || options.platform === 'web') return;
    options.setNativeFocus(node);
}
