import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { HAPPIER_SEARCH_FIELD_METRICS, HappierSearchFieldBox } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { resolveThemeControlEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { TextInput } from '@/components/ui/text/Text';

/**
 * The compact search field's measures, for every search field that is not a page-wide `SearchHeader`
 * (page, rail and inline placements, and any search field drawn in the same shape). The lab's field:
 * 32px tall under every pointer, the glass 10px in and 8px before the text. A finger reaches the
 * touch target through the shared hit area; the field is never drawn taller for it.
 */
export const COMPACT_SEARCH_FIELD_METRICS = HAPPIER_SEARCH_FIELD_METRICS;

// Callers place the field; the shared owner retains its frame, colours and padding.
type CompactSearchFieldLayoutStyle = Pick<ViewStyle,
    | 'flex' | 'flexGrow' | 'flexShrink' | 'flexBasis' | 'minWidth' | 'width' | 'maxWidth'
    | 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'marginHorizontal'
>;

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
    /**
     * One control on the field's row, after the field (a page's filter chip). The field keeps the
     * remaining width, so the pair spans exactly the content column.
     */
    accessory?: React.ReactNode;
    /** `below` stacks the accessory under the field at the column's full width (a phone, where beside it would squeeze the field). */
    accessoryPlacement?: 'beside' | 'below';
} & CompactSearchFieldInputOptions>) {
    const frame = <CompactSearchFieldFrame {...props} />;
    const field = props.accessory && props.accessoryPlacement === 'below' ? (
        <View style={compactSearchFieldStyles.accessoryStack}>
            {frame}
            {props.accessory}
        </View>
    ) : props.accessory ? (
        <View style={compactSearchFieldStyles.accessoryRow}>
            <View style={compactSearchFieldStyles.accessoryField}>{frame}</View>
            {props.accessory}
        </View>
    ) : frame;
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
    /** Resolves to the field's drawn frame, for what opens under the field (a list's filter editor). */
    anchorRef?: React.RefObject<View | null>;
    /** The input's accessible name when it differs from the placeholder. */
    accessibilityLabel?: string;
    autoFocus?: boolean;
    /** The input itself, for an owner that moves focus (a menu's search focuses on open). */
    inputRef?: React.Ref<React.ElementRef<typeof TextInput>>;
    onKeyPress?: React.ComponentProps<typeof TextInput>['onKeyPress'];
    onFocus?: () => void;
    onBlur?: () => void;
    /** Web composite-list relationships, owned by the searchable collection. */
    role?: 'combobox';
    'aria-autocomplete'?: 'list';
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-activedescendant'?: string;
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
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    // The whole drawn field is the press target: a tap on the glass, the padding or the border
    // focuses the input, and under a finger the shared hit area reaches past the 32px well.
    const focusInput = React.useCallback(() => inputRef.current?.focus?.(), []);
    const ownerRef = props.inputRef;
    const setInput = React.useCallback((node: React.ElementRef<typeof TextInput> | null) => {
        inputRef.current = node;
        if (typeof ownerRef === 'function') ownerRef(node);
        else if (ownerRef) (ownerRef as React.MutableRefObject<React.ElementRef<typeof TextInput> | null>).current = node;
    }, [ownerRef]);
    return (
        <View ref={props.anchorRef} collapsable={false} testID={props.testID ? `${props.testID}.layout` : undefined} style={props.style}>
            <HappierSearchFieldBox
                testID={props.testID}
                onFocusInput={focusInput}
                colors={{ backgroundColor: theme.colors.edge.fill, borderColor: theme.colors.border.default, edge: resolveThemeControlEdge(theme, 'default') }}
                radius={theme.borderRadius.lg}
                leading={
                    <Icon name="magnifying-glass" size={COMPACT_SEARCH_FIELD_METRICS.iconSizePx} color={theme.colors.text.secondary} />
                }
                trailing={props.trailing}
            >
                <TextInput
                    ref={setInput}
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
                    {...(Platform.OS === 'web' ? {
                        role: props.role,
                        'aria-autocomplete': props['aria-autocomplete'],
                        'aria-controls': props['aria-controls'],
                        'aria-expanded': props['aria-expanded'],
                        'aria-activedescendant': props['aria-activedescendant'],
                    } : {})}
                    style={styles.input}
                />
            </HappierSearchFieldBox>
        </View>
    );
});

const compactSearchFieldStyles = StyleSheet.create((theme) => ({
    input: {
        flex: 1,
        minWidth: 0,
        padding: 0,
        margin: 0,
        minHeight: 20,
        color: theme.colors.text.primary,
    },
    pageBand: {
        alignSelf: 'stretch',
        alignItems: 'center',
        paddingTop: theme.space.s12,
    },
    pageColumn: {
        width: '100%',
    },
    accessoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    accessoryStack: {
        gap: theme.space.s8,
        alignItems: 'stretch',
    },
    accessoryField: {
        flex: 1,
        minWidth: 0,
    },
}));
