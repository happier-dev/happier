import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierPageHeader,
    happierPageTextMetrics,
    type HappierPageHeaderTextRender,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { Text } from '@/components/ui/text/Text';
import { InlineTextField, type InlineTextEditor } from '@/components/ui/text/InlineTextField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { NavigationHeaderActions, type NavigationHeaderAction } from '@/components/ui/layout/NavigationHeaderActions';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';

export { NavigationTitleChromeProvider, useNavigationTitleChromeShowsTitle } from './navigationTitleChrome';

/** One fact on a page header's meta line: "@handle", "Personal Home", "🔒 End-to-end encrypted". */
export type PageHeaderMetaFact = Readonly<{
    key: string;
    text: string;
    /** A small glyph before the text (a lock for encryption). */
    icon?: IconName;
    testID?: string;
}>;

/**
 * An entity page whose identity is edited in place (a workflow's name and description): the title and
 * description render as the page's own text, editable with the caret as the only focus cue.
 */
export type PageHeaderTextEditor = InlineTextEditor;

/** The page's one primary action (Create, Save): in the page on wide layouts, in the native header on phones. */
export type PageHeaderPrimaryAction = NavigationHeaderAction;

export type PageHeaderProps = Readonly<{
    title: string;
    /** The surface's one display greeting, above the regular page-title step. */
    titleProminence?: 'page' | 'hero';
    /** An inline mark after the title, such as a release-channel badge. */
    titleAccessory?: React.ReactNode;
    /** One sentence saying what the page is for. */
    description?: string;
    /** Identity details under the description (an identifier to copy, a version and machine). */
    details?: React.ReactNode;
    /** Defaults to identity; column places the summary below title and actions at full content width. */
    detailsPlacement?: 'identity' | 'column';
    /** Center an entity's identity above its controls in a compact measured pane. */
    compactPresentation?: 'centered';
    /**
     * The distinguishing facts of the thing the page is about, on one quiet line (wrapping when
     * narrow), after `details`. An empty list keeps the line's place while the facts load.
     */
    meta?: readonly PageHeaderMetaFact[];
    /** A leading identity mark (entity logo, avatar). */
    leading?: React.ReactNode;
    /**
     * Context controls and quiet actions (a machine chip, a `⋯` menu, Cancel). They stay in the page;
     * the primary action goes in `primaryAction`.
     */
    actions?: React.ReactNode;
    /**
     * The page's one primary action. Where navigation chrome shows the title (phones), it moves into
     * the native header instead of stacking under the purpose line; elsewhere it closes `actions`.
     */
    primaryAction?: PageHeaderPrimaryAction;
    /**
     * Leaving without saving (a new item's Cancel). On wide layouts it sits before the primary; on
     * phones it replaces the native header's back.
     */
    cancelAction?: PageHeaderPrimaryAction;
    /** Always show the title even when navigation chrome shows it (entity pages whose title is the entity). */
    alwaysShowTitle?: boolean;
    /**
     * `column` (default): aligned with the page's content column. `pane`: spans the whole pane, for a
     * page whose body is full-bleed (a board's canvas), so the header lines up with it.
     */
    columnWidth?: 'column' | 'pane';
    /**
     * Edit the title in place. Enter commits, Escape restores the value held when editing began, and
     * a long title wraps. The page heading stays the title; `title` remains its plain-text form.
     */
    titleEditor?: PageHeaderTextEditor;
    /** Edit the description in place as a multiline field under the title. */
    descriptionEditor?: PageHeaderTextEditor;
    testID?: string;
}>;

/**
 * The header of a full configuration or detail page: title, one-line purpose, optional leading mark
 * and actions. It aligns with the section headings of page-presented groups below it.
 *
 * Its layout — the title row, the gutter-or-title-row back placement, the meta line and the phone
 * recomposition — is the shared presentation owner `HappierPageHeader`, which the public plugin
 * `PageHeader` renders too; this adapter supplies Happier's navigation chrome (title suppression and
 * the back control), the content column width and its own text owner.
 */
export const PageHeader = React.memo(function PageHeader(props: PageHeaderProps) {
    const { theme } = useUnistyles();
    const maxWidth = useLayoutMaxWidth();
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const showTitle = props.alwaysShowTitle === true || !chromeShowsTitle;
    const BackControl = useNavigationBackControl();
    const renderBack = React.useMemo(
        () => (BackControl ? (style: StyleProp<ViewStyle>) => <BackControl style={style} /> : null),
        [BackControl],
    );
    // Phones: the primary (and Cancel) go to the native header, which already shows the title.

    const pageButtons = !chromeShowsTitle && (props.primaryAction || props.cancelAction) ? (
        <>
            {props.cancelAction ? <PageHeaderActionButton action={props.cancelAction} quiet /> : null}
            {props.primaryAction ? <PageHeaderActionButton action={props.primaryAction} /> : null}
        </>
    ) : null;
    // Inside the desktop app shell the stack header is not drawn; the actions its route put there
    // (an "Add friend") come here instead (`stackHeaderActions`). Elsewhere there are none.
    const routeActions = useClaimedStackHeaderActions();
    const actions = pageButtons || routeActions
        ? <View style={stylesheet.actions}>{props.actions}{routeActions}{pageButtons}</View>
        : props.actions;
    const meta = React.useMemo(() => props.meta?.map((fact) => ({
        key: fact.key,
        text: fact.text,
        ...(fact.testID === undefined ? {} : { testID: fact.testID }),
        ...(fact.icon
            ? { icon: <Icon name={fact.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> }
            : {}),
    })), [props.meta, theme.colors.text.secondary]);

    const titleNode = props.titleEditor
        ? <InlineTextField editor={props.titleEditor} style={stylesheet.titleInput} />
        : props.title;
    const descriptionNode = props.descriptionEditor
        ? <InlineTextField editor={props.descriptionEditor} multiline style={stylesheet.descriptionInput} />
        : props.description;

    return (
        <>
        {props.primaryAction || props.cancelAction ? (
            <NavigationHeaderActions primary={props.primaryAction ?? null} cancel={props.cancelAction ?? null} />
        ) : null}
        <HappierPageHeader
            title={titleNode}
            titleProminence={props.titleProminence}
            showTitle={showTitle}
            titleAccessory={props.titleAccessory}
            description={descriptionNode}
            details={props.details}
            detailsPlacement={props.detailsPlacement}
            compactPresentation={props.compactPresentation}
            meta={meta}
            leading={props.leading}
            actions={actions}
            renderBack={renderBack}
            columnMaxWidthPx={props.columnWidth === 'pane' ? undefined : maxWidth}
            renderText={renderPageHeaderText}
            testID={props.testID}
        />
        </>
    );
});


function PageHeaderActionButton(props: Readonly<{ action: PageHeaderPrimaryAction; quiet?: boolean }>) {
    const { action } = props;
    return (
        <RoundButton
            testID={action.testID}
            size="small"
            display={props.quiet ? 'inverted' : undefined}
            title={action.title}
            accessibilityLabel={action.title}
            disabled={action.disabled}
            loading={action.loading}
            action={() => Promise.resolve(action.onPress())}
        />
    );
}

const renderPageHeaderText: HappierPageHeaderTextRender = (input) => (
    <Text
        accessibilityRole={input.header ? 'header' : undefined}
        style={input.role === 'heroTitle' ? stylesheet.heroTitle : input.role === 'pageTitle' ? stylesheet.title : input.role === 'meta' ? stylesheet.metaText : stylesheet.description}
    >
        {input.text}
    </Text>
);

const stylesheet = StyleSheet.create((theme) => ({
    title: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
    },
    heroTitle: {
        ...Typography.default('bold'),
        ...happierPageTextMetrics('heroTitle'),
        color: theme.colors.text.primary,
    },
    // The editable forms keep the text steps exactly, so editing never moves the page.
    titleInput: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
        padding: 0,
        margin: 0,
        minWidth: 0,
    },
    descriptionInput: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        padding: 0,
        margin: 0,
        minWidth: 0,
    },
    description: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    metaText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
}));
