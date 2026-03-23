export function resolveExecutionRunLauncherContainerStyle(presentation: 'screen' | 'panel' = 'screen') {
    if (presentation === 'panel') {
        return {
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 16,
        } as const;
    }

    return {
        gap: 16,
    } as const;
}
