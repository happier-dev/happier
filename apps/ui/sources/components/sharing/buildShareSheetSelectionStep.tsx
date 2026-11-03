import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierShareHelp } from '@happier-dev/plugin-ui/presentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SelectionListOption, SelectionListSectionDescriptor, SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { t } from '@/text';
import { ShareGrantRow, ShareLevelControl, ShareRowAction } from './ShareGrantRow';
import { ShareConnectedPeoplePrompt } from './ShareConnectedPeoplePrompt';
import { useSharePresentationHost } from './sharePresentationHost';
import {
    SHARE_ACCESS_LEVEL_ORDER,
    type ShareCandidateRowModel,
    type ShareDirectoryKind,
    type ShareDirectorySectionModel,
    type ShareGrantRowModel,
    type SharePrincipalPresentation,
    type ShareSheetActions,
    type ShareSheetAdapter,
    type ShareSheetModel,
    type ShareSheetPresentation,
    type ShareSheetSectionContext,
} from './shareSheetTypes';

const styles = StyleSheet.create((theme) => ({
    helpLine: { color: theme.colors.text.secondary },
}));

export const SHARE_DIRECTORY_KINDS: readonly ShareDirectoryKind[] = ['account', 'group', 'team'];

function principalKindLabel(principal: SharePrincipalPresentation): string {
    return principal.ref.kind === 'account' ? ''
        : principal.ref.kind === 'group' ? t('shareSheet.group') : t('shareSheet.team');
}

/**
 * The row's leading identity mark: the canonical `Avatar` for an Account and the themed kind glyph
 * for a Team or Group. Decorative on purpose: the row's own `accessibilityLabel` is the single
 * accessible name, and the visible kind stays in the subtitle.
 */
export function SharePrincipalVisual(props: Readonly<{ principal: SharePrincipalPresentation; testID: string; size?: number }>): React.ReactElement {
    const { principal } = props;
    const { theme } = useUnistyles();
    const size = props.size ?? ICON_SIZE.lg;
    return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {principal.ref.kind === 'account'
            ? <Avatar id={principal.avatar?.id ?? principal.key} size={size} imageUrl={principal.avatar?.imageUrl ?? null} />
            : <Icon name="users" size={size} color={theme.colors.text.secondary} />}
    </View>;
}

/** One help block: the level legend, then the domain rules and members-only link explanation. */
export function ShareHelp<TRow extends ShareGrantRowModel>(props: Readonly<{
    adapter: ShareSheetAdapter<TRow>; testID: string;
    /** Inside the Details disclosure the row already carries the info mark; the note does not repeat it. */
    markNote?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const host = useSharePresentationHost();
    const lines = SHARE_ACCESS_LEVEL_ORDER.flatMap(level => {
        const presentation = props.adapter.levels[level];
        return presentation?.help ? [{ label: presentation.label, text: presentation.help }] : [];
    });
    return <HappierShareHelp host={host} testID={props.testID} levels={lines}
        noteIcon={props.markNote === false ? undefined : <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        note={[...(props.adapter.notes ?? []), ...(props.adapter.linkPath ? [t('shareSheet.membersOnlyLink')] : [])].join(' ')} />;
}

export type ShareSheetStepInput<TRow extends ShareGrantRowModel> = Readonly<{
    model: ShareSheetModel<TRow>;
    actions: ShareSheetActions;
    adapter: ShareSheetAdapter<TRow>;
    presentation: ShareSheetPresentation;
    onExpand(key: string): void;
    /** Set when a directory kind is browsed on its own pushed step. */
    directoryKind?: ShareDirectoryKind;
    /** Prefix for every rendered testID; empty for the default host. */
    idPrefix: string;
    /**
     * Whether the root lists directory suggestions. They appear once someone starts adding (the search
     * field focused or a query typed); until then the root is the roster and the Browse entries.
     */
    revealSuggestions?: boolean;
    copyLink?: Readonly<{ copied: boolean; onCopy(): void }>;
}>;

export function shareSheetStepId(namespace: string, directoryKind?: ShareDirectoryKind): string {
    return directoryKind ? `${namespace}-directory:${directoryKind}` : namespace;
}

/**
 * The one share sheet's list: "Who has access" with each grant's level, the people still to add
 * by kind, the adapter's own sections, the level meanings and sharing rules, then Copy link and
 * Send a copy instead.
 */
export function buildShareSheetSelectionStep<TRow extends ShareGrantRowModel>(input: ShareSheetStepInput<TRow>): SelectionListStep {
    const { model, actions, adapter, idPrefix } = input;
    const ns = adapter.namespace;
    // Collapsed, the Browse entries share one group instead of trailing three empty headings.
    const suggestionsShown = input.directoryKind !== undefined || input.revealSuggestions !== false;
    const context: ShareSheetSectionContext = { idPrefix, editable: model.editable, onExpand: input.onExpand, revealSuggestions: suggestionsShown,
        ...(input.directoryKind ? { directoryKind: input.directoryKind } : {}) };
    const adapterSections = input.directoryKind && !adapter.showLeadingOnDirectorySteps ? {} : adapter.sections?.(context) ?? {};
    const subtitle = (principal: SharePrincipalPresentation, row?: TRow, extra?: readonly (string | undefined)[]) =>
        [principalKindLabel(principal), principal.secondaryLabel, ...(adapter.principalTags?.(principal, row) ?? []), ...(extra ?? [])]
            .filter(Boolean).join(' · ');
    const accessiblePrincipal = (principal: SharePrincipalPresentation, row?: TRow) =>
        [principal.accessibilityLabel, ...(adapter.principalTags?.(principal, row) ?? []),
            row?.operation.kind === 'error' ? row.operation.error.message : undefined].filter(Boolean).join(', ');
    const visual = (principal: SharePrincipalPresentation) => () => <SharePrincipalVisual principal={principal}
        testID={`${idPrefix}${ns}-principal-visual:${principal.key}`} />;
    const excluded = new Set(model.grants.map((row) => row.principal.key));
    if (model.owner) excluded.add(model.owner.principal.key);

    const current: SelectionListOption[] = [];
    if (model.owner) current.push({ id: model.owner.principal.key, label: model.owner.principal.displayName,
        subtitle: subtitle(model.owner.principal), accessibilityLabel: accessiblePrincipal(model.owner.principal),
        icon: visual(model.owner.principal), rightAccessory: () => <Text style={styles.helpLine}>{t('shareSheet.owner')}</Text> });
    for (const row of model.grants) current.push({
        id: row.principal.key, testID: `${idPrefix}${ns}-grant-${row.principal.key}`,
        label: row.principal.displayName,
        subtitle: subtitle(row.principal, row, [row.operation.kind === 'error' ? row.operation.error.message : undefined]),
        accessibilityLabel: accessiblePrincipal(row.principal, row),
        icon: visual(row.principal),
        loading: row.operation.kind === 'saving' || row.operation.kind === 'removing',
        onSelect: () => input.onExpand(row.principal.key),
        rightAccessoryOutsidePressable: true,
        rightAccessory: () => <ShareLevelControl row={row} adapter={adapter} actions={actions} editable={model.editable}
            onExpand={() => input.onExpand(row.principal.key)} testID={`${idPrefix}${ns}-level:${row.principal.key}`} />,
        expandedContentInset: 'row',
        expandedContent: () => <ShareGrantRow row={row} adapter={adapter} actions={actions} context={context} />,
    });

    const candidateOptions = (rows: readonly ShareCandidateRowModel[]): SelectionListOption[] => {
        const seen = new Set(excluded);
        return rows.flatMap((row) => {
            if (seen.has(row.principal.key)) return [];
            seen.add(row.principal.key);
            const reason = row.addition.kind === 'blocked' ? row.addition.reason : undefined;
            // A candidate the Home refuses reads as unavailable: a short state instead of Add, and pressing the row
            // explains it in full. The reason itself is not repeated on every row; a refusal shared by the whole
            // sheet (an archived context Team) is said once by the adapter, and a row's own reason is one press away.
            return [{ id: row.principal.key, testID: `${idPrefix}${ns}-candidate-${row.principal.key}`,
                label: row.principal.displayName,
                subtitle: subtitle(row.principal, undefined, [reason ? t('shareSheet.cantAdd') : undefined,
                    row.operation.kind === 'error' ? row.operation.error.message : undefined]),
                accessibilityLabel: reason ? `${row.principal.accessibilityLabel}, ${reason.message}` : row.principal.accessibilityLabel,
                icon: visual(row.principal),
                loading: row.operation.kind === 'saving',
                disabled: row.operation.kind === 'saving',
                onSelect: () => reason ? actions.explain(reason) : actions.addPrincipal(row.principal.ref),
                ...(reason ? {} : { rightAccessoryOutsidePressable: true,
                    rightAccessory: () => <ShareRowAction label={t('common.add')}
                        testID={`${idPrefix}${ns}-add:${row.principal.key}`}
                        disabled={row.operation.kind === 'saving'}
                        onPress={() => actions.addPrincipal(row.principal.ref)}
                        trailing={<ShareAddIcon />} /> }),
            }];
        });
    };
    const sourceSection = (source: ShareDirectorySectionModel): SelectionListSectionDescriptor => ({
        kind: 'dynamic', id: `directory:${source.kind}`, title: input.directoryKind
            ? source.title : t('shareSheet.suggestions', { kind: source.title }),
        resolverKey: JSON.stringify([source.resolverKey ?? source.kind, [...excluded], source.resolveCandidates ? undefined : model.revision]),
        resultFiltering: 'provider', resultTransition: 'none',
        // A directory step is the section, so its first load shows a skeleton row. On the root, suggestions
        // whose existence is unknown stay out until they resolve: a heading that appears and then empties
        // moved everything below it twice on every open (RUX-11.2).
        showSkeletonsOnFirstLoad: input.directoryKind !== undefined, loadingSkeletonRows: 1,
        // The list owns debounce, cancellation and stale result rejection. No network or store access lives here.
        resolve: async (query, signal) => ({
            options: candidateOptions(source.resolveCandidates ? await source.resolveCandidates(query, signal) : source.candidates),
            resultHint: !source.resolveCandidates && (source.status === 'loading' || source.status === 'refreshing') ? t('common.loading') : undefined,
        }),
    });

    const sections: SelectionListSectionDescriptor[] = [];
    sections.push(...adapterSections.leading ?? []);
    // While a query is typed the results are what the person is looking at: they lead, and who already has
    // access follows them instead of pushing them below the fold.
    const searching = !input.directoryKind && model.directory.query.trim().length > 0;
    const roster: SelectionListSectionDescriptor[] = [];
    if (!input.directoryKind) {
        // Last-good rows stay while the owner cannot be reached, but must not read as the current answer.
        roster.push({ kind: 'static', id: 'current',
            title: model.stale ? t('shareSheet.whoHasAccessStale') : t('shareSheet.whoHasAccess'), options: current });
        roster.push(...adapterSections.afterAccess ?? []);
        const publicLink = adapter.publicLink;
        if (publicLink) roster.push({ kind: 'static', id: 'public-link', options: [{
            id: 'public-link', testID: `${idPrefix}${ns}-public-link`, label: publicLink.label ?? t('session.sharing.publicLink'),
            icon: () => <ShareHandoffIcon name="link" />,
            accessibilityLabel: `${publicLink.label ?? t('session.sharing.publicLink')}, ${publicLink.stateLabel}`,
            rightAccessory: () => <SharePublicLinkState stateLabel={publicLink.stateLabel} />,
            onSelect: publicLink.onOpen ?? (() => input.onExpand('public-link')),
            ...(publicLink.renderContent ? { expandedContentInset: 'row', expandedContent: () => publicLink.renderContent!(context) } : {}),
        }] });
    }
    if (!searching) sections.push(...roster);
    const collapsedControls: SelectionListOption[] = [];
    if (model.editable) for (const kind of SHARE_DIRECTORY_KINDS) {
        if (input.directoryKind && input.directoryKind !== kind) continue;
        const source = model.directory.sections.find((section) => section.kind === kind);
        if (!source) continue;
        if (!input.directoryKind && kind !== 'account' && source.status === 'idle' && source.candidates.length === 0 && !source.hasMore) continue;
        if (suggestionsShown) sections.push(sourceSection(source));
        const controls: SelectionListOption[] = [];
        if (source.status === 'error' && source.error) controls.push({ id: `retry:${kind}`, label: source.error.message,
            rightAccessoryOutsidePressable: true, rightAccessory: () => <ShareRowAction label={t('common.retry')}
                testID={`${idPrefix}${ns}-directory-retry:${kind}`} onPress={() => actions.retryDirectory(kind)} /> });
        // With suggestions listed, people beyond them are one Browse away; collapsed, every kind that has anyone is.
        const browsable = kind === 'account' && suggestionsShown ? source.hasMore
            : source.candidates.length > 0 || source.hasMore || (!suggestionsShown && source.resolveCandidates !== undefined);
        if (!input.directoryKind && browsable) controls.push({ id: `browse:${kind}`,
            label: t(kind === 'account' ? 'shareSheet.browsePeople' : kind === 'team' ? 'shareSheet.browseTeams' : 'shareSheet.browseGroups'),
            icon: () => <ShareDirectoryIcon />,
            ...(source.status === 'loading' || source.status === 'refreshing' ? { subtitle: t('common.loading') } : {}),
            testID: `${idPrefix}${ns}-browse:${kind}`,
            openStep: buildShareSheetSelectionStep({ ...input, directoryKind: kind }) });
        if (!suggestionsShown) { if (!adapter.browseOnlyWhileAdding) collapsedControls.push(...controls); }
        else if (controls.length) sections.push({ kind: 'static', id: `directory-controls:${kind}`, options: controls });
    }
    if (collapsedControls.length) sections.push({ kind: 'static', id: 'directory-controls', options: collapsedControls });
    if (input.directoryKind) {
        // A settled people directory with no one to add says who appears there and where to connect with someone.
        const directory = model.directory.sections.find(section => section.kind === input.directoryKind);
        if (directory && input.directoryKind === 'account' && model.directory.query.trim() === '' && directory.status === 'idle'
            && !directory.hasMore && candidateOptions(directory.candidates).length === 0) sections.push({ kind: 'static',
            id: 'directory-empty', options: [{ id: 'directory-empty', label: t('shareSheet.noConnectedPeople'), disabled: true,
                content: <ShareConnectedPeoplePrompt testID={`${idPrefix}${ns}-directory-empty`} /> }] });
        return { id: shareSheetStepId(ns, input.directoryKind), inputPlaceholder: t('shareSheet.addPlaceholder'),
            disableInputFilter: true, emptyStateLabel: t('common.noMatches'), sections };
    }
    sections.push(...adapterSections.trailing ?? []);
    if (searching) sections.push(...roster);

    // Compact popovers disclose help; full and inline sheets show it directly in the body footer.
    if (input.presentation === 'compact' && (Object.values(adapter.levels).some(level => level.help) || adapter.notes?.length)) {
        // A disclosure row, not a heading: it carries its mark so it reads as something to open.
        sections.push({ kind: 'static', id: 'help', options: [{ id: 'access-help', testID: `${idPrefix}${ns}-help`, label: t('common.details'),
            icon: () => <ShareHelpIcon />,
            onSelect: () => input.onExpand('access-help'), expandedContentInset: 'none',
            expandedContent: () => <ShareHelp adapter={adapter} markNote={false} testID={`${idPrefix}${ns}-help-content`} /> }] });
    }

    const handoffs: SelectionListOption[] = [];
    if (input.presentation !== 'full' && input.copyLink) {
        const copyLink = input.copyLink;
        handoffs.push({ id: 'copy-link', testID: `${idPrefix}${ns}-copy-link`, label: t('shareSheet.copyLink'),
            ...(copyLink.copied ? { subtitle: t('shareSheet.linkCopied') } : {}),
            icon: () => <ShareHandoffIcon name="link" />, onSelect: copyLink.onCopy });
    }
    if (input.presentation !== 'full' && adapter.sendCopy) handoffs.push({ id: 'send-copy', testID: `${idPrefix}${ns}-send-copy`, label: t('shareSheet.sendCopy'),
        icon: () => <ShareHandoffIcon name="copy" />, onSelect: adapter.sendCopy });
    if (handoffs.length) sections.push({ kind: 'static', id: 'handoffs', options: handoffs });

    return { id: shareSheetStepId(ns), ...(model.editable ? { inputPlaceholder: adapter.searchPlaceholder ?? t('shareSheet.addPlaceholder') } : {}),
        autoFocusFirstOption: false, disableInputFilter: true, emptyStateLabel: t('common.noMatches'), sections };
}

export function ShareHandoffIcon(props: Readonly<{ name: 'link' | 'copy' }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function ShareHelpIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function ShareDirectoryIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="users" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />;
}

function ShareAddIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}

function SharePublicLinkState(props: Readonly<{ stateLabel: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: PAGE_LIST_METRICS.groupHeadingGapPx }}>
        <Text style={styles.helpLine}>{props.stateLabel}</Text>
        <Icon name="caret-right" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
    </View>;
}
