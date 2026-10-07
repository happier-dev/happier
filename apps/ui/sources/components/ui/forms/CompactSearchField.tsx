import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { HAPPIER_SEARCH_FIELD_METRICS, HappierSearchFieldBox } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierNativeMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

import { Icon } from '@/components/ui/icons/Icon';
import { resolveThemeControlEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { TextInput } from '@/components/ui/text/Text';
import { isTouchPrimaryPointer, resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

/**
 * The compact search field's measures, for every search field that is not a page-wide `SearchHeader`
 * (page, rail and inline placements, and any search field drawn in the same shape). The lab's field:
 * 32px tall under a precise pointer, the glass 10px in and 8px before the text. On a touch-primary
 * device the field takes the platform touch floor instead.
 */
export const COMPACT_SEARCH_FIELD_METRICS = HAPPIER_SEARCH_FIELD_METRICS;

// Callers place the field; the shared owner retains its frame, colours and padding.
type CompactSearchFieldLayoutStyle = Pick<ViewStyle,
    | 'flex' | 'flexGrow' | 'flexShrink' | 'flexBasis' | 'minWidth' | 'width' | 'maxWidth'
    | 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'marginHorizontal'
>;

/** The field's height here: the touch floor where a finger is the pointer, else the compact height. */
export function resolveCompactSearchFieldHeightPx(platform: string = Platform.OS): number {
    return isTouchPrimaryPointer(platform) ? resolveMinimumInteractiveTargetSize(platform) : COMPACT_SEARCH_FIELD_METRICS.heightPx;
}

/**
 * The compact bordered search field of navigation rails and collection lists: a paper-coloured well
 * with a hairline, a small magnifying glass and a single-line input. Page-wide search above a long
 * list keeps using `SearchHeader`.
 *
 * `placement="page"` is the field above a configuration page's list (People, Teams, Machines…): it
 * takes the page's content column — the same width cap and inset as the sheets below it — so it never
 * spans the whole pane. Inline (a rail, a section row) it adds no geometry of its own.
 */
export const CompactSearchField = React.memo(function CompactSearchField(props: Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    /** Test id of the text input itself. */
    testID?: string;
    /** Native placement geometry only; the shared field owns its frame and padding. */
    style?: StyleProp<CompactSearchFieldLayoutStyle>;
    /**
     * Runs the search on Enter or the keyboard's search key, for lists whose query is an explicit
     * request (a remote search) rather than a filter applied as the user types.
     */
    onSubmitEditing?: () => void;
    /** `false` while the list behind the field cannot be searched (for example, offline). */
    editable?: boolean;
    placement?: 'inline' | 'page';
} & CompactSearchFieldInputOptions>) {
    const field = <CompactSearchFieldFrame {...props} />;
    return props.placement === 'page' ? (
        <PageSearchColumn testID={props.testID ? `${props.testID}.column` : undefined}>{field}</PageSearchColumn>
    ) : field;
});

/** The page's content column, measured like `ItemGroup`'s: capped width, centred, the sheet inset. */
function PageSearchColumn(props: Readonly<{ testID?: string; children: React.ReactNode }>) {
    const maxWidth = useLayoutMaxWidth();
    // Like `ItemGroup`: a full-width band centring a capped column, so it lines up with the sheets
    // whatever width the list header it sits in was given.
    return (
        <View style={compactSearchFieldStyles.pageBand}>
            <View
                testID={props.testID}
                style={[compactSearchFieldStyles.pageColumn, { maxWidth, paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() }]}
            >
                {props.children}
            </View>
        </View>
    );
}

/**
 * Options for a field whose owner manages its open lifetime (a search the user opens and closes): a
 * trailing control inside the well (for example a close button), focus on mount, and the input's key
 * and focus events.
 */
type CompactSearchFieldInputOptions = Readonly<{
    /** Drawn inside the well after the input, before the trailing inset. */
    trailing?: React.ReactNode;
    /** The input's accessible name when it differs from the placeholder. */
    accessibilityLabel?: string;
    autoFocus?: boolean;
    onKeyPress?: React.ComponentProps<typeof TextInput>['onKeyPress'];
    onFocus?: () => void;
    onBlur?: () => void;
}>;

const CompactSearchFieldFrame = React.memo(function CompactSearchFieldFrame(props: Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    testID?: string;
    style?: StyleProp<CompactSearchFieldLayoutStyle>;
    onSubmitEditing?: () => void;
    editable?: boolean;
}> & CompactSearchFieldInputOptions) {
    const { theme } = useUnistyles();
    const styles = compactSearchFieldStyles;
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    // The whole drawn field is the touch target: a tap on the glass, the padding or the border
    // focuses the input. On phones it takes the shared native touch floor; pointer platforms keep
    // the rail's density.
    const nativeMinimumTargetSize = useHappierNativeMinimumInteractiveTargetSize();
    const focusInput = React.useCallback(() => inputRef.current?.focus?.(), []);
    return (
        <View testID={props.testID ? `${props.testID}.layout` : undefined} style={props.style}>
            <HappierSearchFieldBox
                testID={props.testID}
                onFocusInput={focusInput}
                colors={{ backgroundColor: theme.colors.edge.fill, borderColor: theme.colors.border.default, edge: resolveThemeControlEdge(theme, 'default') }}
                radius={theme.borderRadius.lg}
                minimumTargetSize={nativeMinimumTargetSize ?? resolveCompactSearchFieldHeightPx()}
                leading={
                    <Icon name="magnifying-glass" size={COMPACT_SEARCH_FIELD_METRICS.iconSizePx} color={theme.colors.text.secondary} />
                }
                trailing={props.trailing}
            >
                <TextInput
                    ref={inputRef}
                    testID={props.testID}
                    placeholder={props.placeholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={props.value}
                    onChangeText={props.onChangeText}
                    onSubmitEditing={props.onSubmitEditing}
                    returnKeyType={props.onSubmitEditing ? 'search' : undefined}
                    editable={props.editable}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus={props.autoFocus}
                    onKeyPress={props.onKeyPress}
                    onFocus={props.onFocus}
                    onBlur={props.onBlur}
                    accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
                    style={styles.input}
                />
            </HappierSearchFieldBox>
        </View>
    );
});

const compactSearchFieldStyles = StyleSheet.create((theme) => ({
    input: {
        flex: 1,
        padding: 0,
        margin: 0,
        minHeight: 20,
        color: theme.colors.text.primary,
    },
    pageBand: {
        alignSelf: 'stretch',
        alignItems: 'center',
        paddingTop: 12,
    },
    pageColumn: {
        width: '100%',
    },
}));
