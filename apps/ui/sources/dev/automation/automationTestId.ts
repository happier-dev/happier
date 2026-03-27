export function resolveAutomationTestIdLabelEnabled(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

export function resolveAutomationAccessibilityLabel(props: Readonly<{
    testID?: string;
    accessibilityLabel?: string;
}>): string | undefined {
    const accessibilityLabel = (props.accessibilityLabel ?? '').trim();
    const testID = (props.testID ?? '').trim();

    if (!resolveAutomationTestIdLabelEnabled()) return accessibilityLabel.length > 0 ? accessibilityLabel : undefined;

    if (testID.length > 0) return testID;
    return accessibilityLabel.length > 0 ? accessibilityLabel : undefined;
}
