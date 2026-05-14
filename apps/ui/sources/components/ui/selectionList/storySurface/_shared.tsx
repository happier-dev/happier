/**
 * FR4-14 — shared primitives for the SelectionList story surface.
 *
 * Constants, fixture data, layout primitives, and `makeVariantProps` are
 * extracted here so each domain-specific variant module (basic, dynamic,
 * path, worktree, transition) can import a stable contract instead of
 * forking helpers per file.
 */

import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { SelectionList } from '../SelectionList';
import { selectionListTestId } from '../_shared';
import type {
    SelectionListInputBehavior,
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

// ─── Constants exported for variant fixtures ──────────────────────────────

export const STORY_NOW = Date.now();

export const FAVORITES_OPTIONS: ReadonlyArray<SelectionListOption> = [
    { id: 'fav-1', label: '~/Development/happier', subtitle: 'starred 3d ago' },
    { id: 'fav-2', label: '~/Documents/projects', subtitle: 'starred 2w ago' },
];

export const RECENT_OPTIONS: ReadonlyArray<SelectionListOption> = [
    { id: 'rec-1', label: '~/Downloads', subtitle: '5m ago' },
    { id: 'rec-2', label: '/tmp/release-staging', subtitle: '1h ago' },
];

// ─── Styles ───────────────────────────────────────────────────────────────

export const storyStylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.background.canvas,
        flexGrow: 1,
    },
    variantBlock: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 8,
    },
    variantTitle: {
        fontSize: Platform.select({ ios: 13, default: 14 }),
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        letterSpacing: 0.5,
    },
    variantHost: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        overflow: 'hidden',
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

export function makeVariantProps(rootStep: SelectionListStep, testID: string): SelectionListProps {
    return {
        rootStep,
        onSelect: () => {},
        onRequestClose: () => {},
        keyboardHintsEnabled: true,
        // Disable transitions in the story surface so the visual is stable
        // for screenshot diffs; the cross-slide is independently covered by
        // motion primitive tests.
        disableTransitions: true,
        testID,
        selectedOptionId: null,
        maxHeight: 360,
    };
}

export type VariantBlockProps = Readonly<{
    title: string;
    children: React.ReactNode;
    testID: string;
}>;

export function VariantBlock(props: VariantBlockProps): React.ReactElement {
    return (
        <View testID={props.testID} style={storyStylesheet.variantBlock}>
            <Text style={storyStylesheet.variantTitle}>{props.title}</Text>
            <View style={storyStylesheet.variantHost}>{props.children}</View>
        </View>
    );
}

/**
 * Convenience helper to compose `selectionListTestId(rootTestID, slug)` while
 * keeping the variant module call sites short. Re-exports the shared util.
 */
export function storyVariantTestId(rootTestID: string, slug: string): string {
    return selectionListTestId(rootTestID, slug);
}

export function makeStoryPathInputBehavior(): SelectionListInputBehavior {
    return {
        getFilterQueryFromInput: (input) => {
            const trimmed = input.replace(/[\\/]+$/, '');
            const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
            return index >= 0 ? trimmed.slice(index + 1) : trimmed;
        },
        getDynamicSectionSeed: (input) => input,
        onBackspaceAtEnd: (input) => walkUpPathInput(input, false),
        onBackUp: (input) => walkUpPathInput(input, true),
        shouldSuppressAutocomplete: (input) => input.endsWith('/') || input.endsWith('\\'),
    };
}

function walkUpPathInput(input: string, force: boolean): string | null {
    if (input === '/' || input === '\\' || input === '~/' || input === '~\\' || input.length === 0) {
        return null;
    }
    if (!force && !input.endsWith('/') && !input.endsWith('\\')) return null;
    const trimmed = input.replace(/[\\/]+$/, '');
    if (trimmed === '' || trimmed === '~') return null;
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (index < 0) return null;
    const next = trimmed.slice(0, index + 1);
    return next === '' ? null : next;
}

// Re-export for convenience so consuming variant modules don't need to also
// import from the parent index.
export { SelectionList };
export type { SelectionListInputBehavior, SelectionListProps, SelectionListStep, SelectionListOption };
