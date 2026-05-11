import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';

export const bugReportComposerStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    scrollView: {
        flex: 1,
    },
    contentContainer: {
        paddingTop: Platform.select({ ios: 20, default: 16 }),
        paddingBottom: Platform.select({ ios: 34, default: 16 }),
        gap: 20,
    },
    section: {
        backgroundColor: theme.colors.surface.base,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        padding: Platform.select({ ios: 18, default: 20 }),
        gap: 14,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    sectionHeader: {
        gap: 6,
    },
    sectionFields: {
        gap: 18,
    },
    field: {
        gap: 6,
    },
    sectionTitle: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase' as const,
        fontWeight: Platform.select({ ios: 'normal', default: '500' }) as any,
    },
    helperText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    label: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    input: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.colors.text.primary,
        fontSize: 15,
    },
    inputError: {
        borderColor: theme.colors.state.danger.foreground,
    },
    errorText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        lineHeight: 18,
    },
    textArea: {
        minHeight: 100,
        textAlignVertical: 'top' as const,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    similarIssuesList: {
        gap: 10,
    },
    similarIssueRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingVertical: 12,
        paddingHorizontal: 12,
    },
    similarIssueRowSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.surface.inset,
    },
    similarIssueTitle: {
        color: theme.colors.text.primary,
        fontSize: 14,
        fontWeight: '700',
    },
    toggleRows: {
        gap: 16,
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        paddingVertical: 2,
    },
    previewButton: {
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingVertical: 10,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
    },
    previewButtonDisabled: {
        opacity: 0.5,
    },
    previewButtonText: {
        color: theme.colors.text.primary,
        fontSize: Platform.select({ ios: 15, default: 15 }),
        fontWeight: '600',
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    chipActive: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background,
    },
    chipText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    chipTextActive: {
        color: theme.colors.button.primary.tint,
    },
    submitButton: {
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        marginTop: 2,
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        backgroundColor: theme.colors.button.primary.background,
        paddingVertical: Platform.select({ ios: 12, default: 12 }),
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: Platform.select({ ios: 15, default: 15 }),
        fontWeight: '700',
    },
}));
