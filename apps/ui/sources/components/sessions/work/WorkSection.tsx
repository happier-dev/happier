import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';
import {
    HAPPIER_PAGE_METRICS,
    HAPPIER_WORK_PANE_METRICS,
    HappierWorkFlatSheet,
    HappierWorkSection,
    HappierWorkSectionEmptyLine,
    happierPageTextMetrics,
    useHappierPageSection,
} from '@happier-dev/plugin-ui/presentation';
import { useSessionInfoDisclosureCommands } from '@/components/sessions/info/useSessionInfoDisclosureCommands';
import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Item } from '@/components/ui/lists/Item';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * One section of the Work pane (and of the in-session agent roster it hosts): Happier core's binding
 * of the shared Work section (`HappierWorkSection` in `@happier-dev/plugin-ui/presentation`, the same
 * owner a plugin's Work-style surface draws with). The two anatomies — `list` for a group of the live
 * work list, `page` for a configuration section laid flat on the pane (lab `convo-W8/W9`) — and the
 * loading skeleton live there; this file supplies core's theme, text owner, count wording and the ⓘ
 * control that explains a configuration section.
 */

export type WorkSectionProps = Readonly<{
    testID: string;
    title: string;
    /**
     * Beside the title, quiet. A number is the rows' count (omitted at 0); a string is the section's
     * own summary ("5 on", "2 changed · 2 added").
     */
    count: number | string;
    countMode?: 'quiet' | 'attention' | 'none';
    /** `list` (default): a group of the live work list. `page`: a configuration section of the pane. */
    anatomy?: 'list' | 'page';
    /** `page` only: what the section is and what it applies to, behind ⓘ. */
    info?: string;
    loading?: boolean;
    /** Anchor for a route that scrolls to this section. */
    nativeID?: string;
    /** One quiet operation on the whole section ("+", ✎, "Use defaults"), at the header's trailing edge. */
    action?: React.ReactNode;
    /** `setup` placement: the row's leading glyph. */
    icon?: IconName;
    /** `setup` placement: the closed row's value ("Release reviewer", "On", "5 on"); defaults to the count. */
    summary?: string;
    /**
     * `setup` placement: whether the row opens when this device remembers no choice. Omitted, the Setup
     * owner's default applies (Instructions open); a section with nothing to read yet passes `false`, so it
     * stays a closed value row ("Add") that opens on its create flow (lab csinfo I2min).
     */
    setupDefaultExpanded?: boolean;
    children?: React.ReactNode;
}>;

/**
 * Where a Session's configuration sections are drawn. `pane` (default): laid flat on the Work pane
 * (lab `convo-W8/W9`). `page`: the Session's Info page (coordination lab P1i), where the same section
 * components take the configuration-page section anatomy — title, its explanation above the rows, one
 * sheet — so a section moves between hosts without a second component. `setup`: one row of Session
 * Info's Setup section (calm-shell lab csinfo I2), naming the section with its current value and
 * opening it in place; the section's own body is the row's body.
 */
export type WorkSectionPlacement = 'pane' | 'page' | 'setup';

const WorkSectionPlacementContext = React.createContext<WorkSectionPlacement>('pane');

export function WorkSectionPlacementProvider(props: Readonly<{ value: WorkSectionPlacement; children?: React.ReactNode }>) {
    return <WorkSectionPlacementContext.Provider value={props.value}>{props.children}</WorkSectionPlacementContext.Provider>;
}

export const WorkSection = React.memo((props: WorkSectionProps) => {
    const placement = React.useContext(WorkSectionPlacementContext);
    if (placement === 'setup' && props.anatomy === 'page') return <WorkSectionAsSetupRow {...props} />;
    return placement === 'page' && props.anatomy === 'page'
        ? <WorkSectionOnPage {...props} />
        : <WorkSectionOnPane {...props} />;
});

/**
 * Which Setup rows are open: the Setup composition owns it (with its device memory); a row reads and
 * changes its own entry by the section's key.
 */
export type WorkSectionSetupDisclosure = Readonly<{
    isExpanded: (sectionKey: string, sectionDefault?: boolean) => boolean;
    setExpanded: (sectionKey: string, expanded: boolean) => void;
}>;

const WorkSectionSetupDisclosureContext = React.createContext<WorkSectionSetupDisclosure | null>(null);

export function WorkSectionSetupDisclosureProvider(props: Readonly<{ value: WorkSectionSetupDisclosure; children?: React.ReactNode }>) {
    return <WorkSectionSetupDisclosureContext.Provider value={props.value}>{props.children}</WorkSectionSetupDisclosureContext.Provider>;
}

/** A section's key in the Setup memory: its anchor, else its test id without the Work prefix. */
function readSetupSectionKey(props: WorkSectionProps): string {
    return props.nativeID ?? props.testID.replace(/^session-work-/, '');
}

/**
 * A configuration section as one Setup row (lab csinfo I2): glyph, name and its current value; it
 * opens in place to the section itself, laid on the row's text edge. A never-opened body is not
 * mounted; the section's quiet operations join the row while it is open.
 */
function WorkSectionAsSetupRow(props: WorkSectionProps) {
    const disclosure = React.useContext(WorkSectionSetupDisclosureContext);
    const sectionKey = readSetupSectionKey(props);
    const [localExpanded, setLocalExpanded] = React.useState(false);
    const expanded = disclosure ? disclosure.isExpanded(sectionKey, props.setupDefaultExpanded) : localExpanded;
    const onExpandedChange = React.useCallback((next: boolean) => {
        if (disclosure) disclosure.setExpanded(sectionKey, next);
        else setLocalExpanded(next);
    }, [disclosure, sectionKey]);
    // The row publishes its own disclosure to Agents, with the state it actually shows.
    useSessionInfoDisclosureCommands([{
        key: sectionKey, title: props.title, expanded, onExpandedChange, available: disclosure !== null,
    }]);
    const value = props.loading ? undefined : (props.summary ?? readCountText(props) ?? undefined);
    // The closed row is a one-line sheet row like Role beside it, so it parts by spacing (the one list-row rule);
    // an open section's body is parted from the next row, and the sheet's last row draws none.
    const rowPosition = useItemGroupRowPosition();
    return (
        <View nativeID={props.nativeID} collapsable={false}>
            <ExpandableItem
                testID={props.testID}
                showDivider={expanded && rowPosition?.isLast !== true}
                expanded={expanded}
                onExpandedChange={onExpandedChange}
                header={({ expanded: open, headerProps }) => (
                    <Item
                        {...headerProps}
                        testID={`${props.testID}:row`}
                        title={props.title}
                        icon={props.icon ? <Icon name={props.icon} /> : undefined}
                        // The value stays while open (lab csinfo I2 "Release reviewer ⌄"), beside the quiet operations.
                        detail={value}
                        showChevron={false}
                        // While open, the section's own operations ("+", search) are controls of their own:
                        // they sit beside the row's press target, never inside it (no button in a button).
                        // The caret stays a pointer target for closing; the row itself is the one toggle that
                        // assistive tech and the keyboard reach.
                        rightElementOutsidePressable={open && Boolean(props.action)}
                        rightElement={(
                            <View style={stylesheet.setupTrailing}>
                                {open && props.action ? props.action : null}
                                {open && props.action ? (
                                    <Pressable accessible={false} focusable={false} onPress={() => onExpandedChange(false)}>
                                        <DisclosureCaret expanded={open} />
                                    </Pressable>
                                ) : <DisclosureCaret expanded={open} />}
                            </View>
                        )}
                    />
                )}
            >
                <View style={stylesheet.setupBody}>
                    {/* The body is its own section: its rows reserve no glyph column of the row above. */}
                    <SectionLeadingColumnProvider>
                        {props.loading ? <SkeletonRows testID={`${props.testID}-loading`} rows={2} accessibilityLabel={props.title} /> : props.children}
                    </SectionLeadingColumnProvider>
                </View>
            </ExpandableItem>
        </View>
    );
}

/** A configuration section on a page: the page's own section (`ItemGroup`), its ⓘ text read as the description. */
function WorkSectionOnPage(props: WorkSectionProps) {
    const count = readCountText(props);
    return (
        // The anchor a route scrolls to stays on the section (`/session/[id]/info` → Triggers).
        <View nativeID={props.nativeID} collapsable={false}>
            <ItemGroup
                testID={props.testID}
                title={props.title}
                description={props.info}
                titleAccessory={count && !props.loading ? (
                    <Text testID={`session-agents-section-count:${props.testID}`} style={stylesheet.pageCount}>{count}</Text>
                ) : undefined}
                action={props.action ?? undefined}
                // A Work section's action is a quiet icon cluster (+, ✎, search): it keeps the title
                // line's end on a phone instead of dropping onto a line of its own.
                actionLayout="trailing"
            >
                {props.loading ? <SkeletonRows testID={`${props.testID}-loading`} rows={2} accessibilityLabel={props.title} /> : props.children}
            </ItemGroup>
        </View>
    );
}

const WorkSectionOnPane = React.memo((props: WorkSectionProps) => {
    const theme = useWorkTheme();
    const reducedMotion = useReducedMotionPreference();
    const { title, info } = props;
    const showInfo = React.useCallback(() => {
        if (info) Modal.alert(title, info);
    }, [info, title]);
    const anatomy = props.anatomy ?? 'list';

    const section = (
        <HappierWorkSection
            testID={props.testID}
            title={title}
            count={readCountText(props)}
            countTone={props.countMode === 'attention' ? 'attention' : 'quiet'}
            countTestID={`session-agents-section-count:${props.testID}`}
            anatomy={anatomy}
            info={anatomy === 'page' && info ? (
                <IconButton
                    testID={`${props.testID}-info`}
                    iconName="info"
                    variant="plain"
                    accessibilityLabel={info}
                    tooltip={info}
                    onPress={showInfo}
                />
            ) : undefined}
            loading={props.loading}
            nativeID={props.nativeID}
            action={props.action}
            reducedMotion={reducedMotion}
            theme={theme}
            host={WORK_HOST}
        >
            {props.children}
        </HappierWorkSection>
    );
    // A configuration section's rows are configuration-page rows (core `Item` reads the page anatomy from
    // the list presentation). The scope opens outside the section's sheet, which supplies the inset.
    return anatomy === 'page' ? <ListPresentationProvider value="page">{section}</ListPresentationProvider> : section;
});

/**
 * The Work pane's flat sheet: rows laid on the pane (no sheet, edge or radius), on the Work list's own
 * inset and with no hairlines between them (lab `convo-W8/W9`). A page section's body, and the top
 * value rows (Role, Goal) that open the tab. Its rows are configuration-page rows, like a page
 * section's.
 */
export function WorkFlatSheet(props: Readonly<{ testID?: string; children?: React.ReactNode }>) {
    const theme = useWorkTheme();
    return (
        <ListPresentationProvider value="page">
            <HappierWorkFlatSheet testID={props.testID} theme={theme}>{props.children}</HappierWorkFlatSheet>
        </ListPresentationProvider>
    );
}

/**
 * A Work section with nothing in it yet says so in one quiet line (DESIGN.md "Emptiness is designed";
 * lab `convo-ST`, the empty Notes row): the section description's text, on the rows' text edge, never
 * a full-height row set in the row title's type. With `onPress` the line is the section's way to start
 * ("Add notes for how this session should orchestrate"); without it, it only states what belongs here.
 * Every Work section draws its empty state through this one line.
 */
export function WorkSectionEmptyLine(props: Readonly<{
    testID: string;
    text: string;
    onPress?: () => void;
}>) {
    const theme = useWorkTheme();
    return <HappierWorkSectionEmptyLine {...props} theme={theme} host={WORK_HOST} />;
}

/**
 * What a configuration section is for or applies to, right under its heading and on the rows' text
 * edge (Context, Voice): one quiet line of text, not a row, so every section's first line sits at the
 * same distance from its heading.
 */
export function WorkSectionDescription(props: Readonly<{ testID?: string; children: React.ReactNode }>) {
    const block = useWorkSectionBlockInset();
    // Rows follow the line, so it keeps its own short gap below.
    return <Text testID={props.testID} style={[stylesheet.description, { paddingHorizontal: block.paddingHorizontal, paddingTop: block.paddingTop }]}>{props.children}</Text>;
}

/**
 * A quiet block a section draws in place of rows (an invitation, a line with its buttons): on the
 * rows' own text edge, which the pane's flat sheet or a page section's sheet supplies; in a drawn
 * sheet it also takes a row's vertical room so it doesn't touch the edge.
 */
export function WorkSectionBlock(props: Readonly<{ testID?: string; style?: StyleProp<ViewStyle>; children?: React.ReactNode }>) {
    const inset = useWorkSectionBlockInset();
    return <View testID={props.testID} style={[props.style, inset]}>{props.children}</View>;
}

function useWorkSectionBlockInset(): Readonly<{ paddingHorizontal: number; paddingTop?: number; paddingBottom?: number }> {
    const section = useHappierPageSection();
    return React.useMemo(() => ({
        paddingHorizontal: section?.rowInsetPx ?? HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        ...(section?.framed ? { paddingTop: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx, paddingBottom: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx } : null),
    }), [section?.framed, section?.rowInsetPx]);
}

const stylesheet = StyleSheet.create((theme) => ({
    // A Setup row's body starts on the row's text edge, past the glyph column.
    setupBody: {
        paddingLeft: HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx,
        paddingBottom: theme.space.s8,
    },
    setupTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        paddingBottom: theme.space.s6,
    },
    pageCount: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));

function readCountText(props: WorkSectionProps): string | null {
    if (props.countMode === 'none') return null;
    if (typeof props.count === 'string') return props.count;
    return props.count === 0 ? null : t('session.subagents.panel.sectionCount', { count: props.count });
}
