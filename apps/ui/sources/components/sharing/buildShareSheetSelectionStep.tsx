import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SelectionListOption, SelectionListSectionDescriptor, SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { t } from '@/text';
import { ShareGrantRow, ShareLevelControl, ShareRowAction } from './ShareGrantRow';
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
    help: { paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, paddingVertical: PAGE_LIST_METRICS.groupSeparatorGapPx, gap: PAGE_LIST_METRICS.groupHeadingGapPx },
    helpLine: { color: theme.colors.text.secondary },
    helpLabel: { color: theme.colors.text.primary, fontWeight: '600' },
    note: { flexDirection: 'row', alignItems: 'flex-start', gap: PAGE_LIST_METRICS.groupHeadingGapPx,
        padding: PAGE_LIST_METRICS.groupSeparatorGapPx, borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
        backgroundColor: theme.colors.surface.elevated },
    noteText: { color: theme.colors.text.secondary, flex: 1, minWidth: 0 },
}));

export const SHARE_DIRECTORY_KINDS: readonly ShareDirectoryKind[] = ['account', 'group', 'team'];

function principalKindLabel(principal: SharePrincipalPresentation): string {
    return principal.ref.kind === 'account' ? t('shareSheet.person')
        : principal.ref.kind === 'group' ? t('shareSheet.group') : t('shareSheet.team');
}

/**
 * The row's leading identity mark: the canonical `Avatar` for an Account and the themed kind glyph
 * for a Team or Group. Decorative on purpose: the row's own `accessibilityLabel` is the single
 * accessible name, and the visible kind stays in the subtitle.
 */
function SharePrincipalVisual(props: Readonly<{ principal: SharePrincipalPresentation; testID: string; size?: number }>): React.ReactElement {
    const { principal } = props;
    const { theme } = useUnistyles();
    const size = props.size ?? ICON_SIZE.lg;
    return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {principal.ref.kind === 'account'
            ? <Avatar id={principal.avatar?.id ?? principal.key} size={size} imageUrl={principal.avatar?.imageUrl ?? null} />
            : <Icon name="users" size={size} color={theme.colors.text.secondary} />}
    </View>;
}

/** The level meanings, then the adapter's sharing rules, as one quiet block. */
export function ShareHelp<TRow extends ShareGrantRowModel>(props: Readonly<{
    adapter: ShareSheetAdapter<TRow>; testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const lines = SHARE_ACCESS_LEVEL_ORDER.flatMap(level => {
        const presentation = props.adapter.levels[level];
        return presentation.help ? [{ label: presentation.label, text: presentation.help }] : [];
    });
    return <View testID={props.testID} style={styles.help}>
        {lines.length ? <Text style={styles.helpLine}>{lines.map((line, index) => <React.Fragment key={line.label}>
            {index ? ' · ' : null}<Text style={styles.helpLabel}>{line.label}</Text>{` ${line.text}`}
        </React.Fragment>)}</Text> : null}
        {(props.adapter.notes ?? []).map((note, index) => <View key={note} testID={`${props.testID}:note:${index}`} style={styles.note}>
            <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            <Text style={styles.noteText}>{note}</Text>
        </View>)}
    </View>;
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
    const context: ShareSheetSectionContext = { idPrefix, editable: model.editable, onExpand: input.onExpand };
    const adapterSections = input.directoryKind ? {} : adapter.sections?.(context) ?? {};
    const subtitle = (principal: SharePrincipalPresentation, row?: TRow, extra?: readonly (string | undefined)[]) =>
        [principalKindLabel(principal), principal.secondaryLabel, ...(adapter.principalTags?.(principal, row) ?? []), ...(extra ?? [])]
            .filter(Boolean).join(' · ');
    const visual = (principal: SharePrincipalPresentation) => () => <SharePrincipalVisual principal={principal}
        testID={`${idPrefix}${ns}-principal-visual:${principal.key}`} />;
    const excluded = new Set(model.grants.map((row) => row.principal.key));
    if (model.owner) excluded.add(model.owner.principal.key);

    const current: SelectionListOption[] = [];
    if (model.owner) current.push({ id: model.owner.principal.key, label: model.owner.principal.displayName,
        subtitle: subtitle(model.owner.principal), accessibilityLabel: model.owner.principal.accessibilityLabel,
        icon: visual(model.owner.principal), rightAccessory: () => <Text style={styles.helpLine}>{t('shareSheet.owner')}</Text> });
    for (const row of model.grants) current.push({
        id: row.principal.key, testID: `${idPrefix}${ns}-grant-${row.principal.key}`,
        label: row.principal.displayName,
        subtitle: subtitle(row.principal, row, [row.operation.kind === 'error' ? row.operation.error.message : undefined]),
        accessibilityLabel: row.principal.accessibilityLabel,
        icon: visual(row.principal),
        loading: row.operation.kind === 'saving' || row.operation.kind === 'removing',
        onSelect: () => input.onExpand(row.principal.key),
        rightAccessoryOutsidePressable: true,
        rightAccessory: () => <ShareLevelControl row={row} adapter={adapter} actions={actions} editable={model.editable}
            onExpand={() => input.onExpand(row.principal.key)} testID={`${idPrefix}${ns}-level:${row.principal.key}`} />,
        expandedContent: () => <ShareGrantRow row={row} adapter={adapter} actions={actions} context={context} />,
    });

    const candidateOptions = (rows: readonly ShareCandidateRowModel[]): SelectionListOption[] => {
        const seen = new Set(excluded);
        return rows.flatMap((row) => {
            if (seen.has(row.principal.key)) return [];
            seen.add(row.principal.key);
            const reason = row.addition.kind === 'blocked' ? row.addition.reason : undefined;
            return [{ id: row.principal.key, testID: `${idPrefix}${ns}-candidate-${row.principal.key}`,
                label: row.principal.displayName,
                subtitle: subtitle(row.principal, undefined, [reason?.message, row.operation.kind === 'error' ? row.operation.error.message : undefined]),
                accessibilityLabel: row.principal.accessibilityLabel,
                icon: visual(row.principal),
                loading: row.operation.kind === 'saving',
                disabled: row.operation.kind === 'saving',
                onSelect: () => reason ? actions.explain(reason) : actions.addPrincipal(row.principal.ref),
            }];
        });
    };
    const sourceSection = (source: ShareDirectorySectionModel): SelectionListSectionDescriptor => ({
        kind: 'dynamic', id: `directory:${source.kind}`, title: source.title,
        resolverKey: JSON.stringify([source.resolverKey ?? source.kind, [...excluded], source.resolveCandidates ? undefined : model.revision]),
        resultFiltering: 'provider', resultTransition: 'none',
        showSkeletonsOnFirstLoad: true, loadingSkeletonRows: 1,
        // The list owns debounce, cancellation and stale result rejection. No network or store access lives here.
        resolve: async (query, signal) => ({
            options: candidateOptions(source.resolveCandidates ? await source.resolveCandidates(query, signal) : source.candidates),
            resultHint: !source.resolveCandidates && (source.status === 'loading' || source.status === 'refreshing') ? t('common.loading') : undefined,
        }),
    });

    const sections: SelectionListSectionDescriptor[] = [];
    if (!input.directoryKind) {
        sections.push(...adapterSections.leading ?? []);
        // Last-good rows stay while the owner cannot be reached, but must not read as the current answer.
        sections.push({ kind: 'static', id: 'current',
            title: model.stale ? t('shareSheet.whoHasAccessStale') : t('shareSheet.whoHasAccess'), options: current });
        sections.push(...adapterSections.afterAccess ?? []);
    }
    if (model.editable) for (const kind of SHARE_DIRECTORY_KINDS) {
        if (input.directoryKind && input.directoryKind !== kind) continue;
        const source = model.directory.sections.find((section) => section.kind === kind);
        if (!source) continue;
        sections.push(sourceSection(source));
        const controls: SelectionListOption[] = [];
        if (source.status === 'error' && source.error) controls.push({ id: `retry:${kind}`, label: source.error.message,
            rightAccessoryOutsidePressable: true, rightAccessory: () => <ShareRowAction label={t('common.retry')}
                testID={`${idPrefix}${ns}-directory-retry:${kind}`} onPress={() => actions.retryDirectory(kind)} /> });
        if (!input.directoryKind && (kind !== 'account' || source.hasMore)) controls.push({ id: `browse:${kind}`,
            label: kind === 'group' ? t('shareSheet.group') : source.title,
            subtitle: source.status === 'loading' || source.status === 'refreshing' ? t('common.loading') : t('shareSheet.browseAll'),
            testID: `${idPrefix}${ns}-browse:${kind}`,
            openStep: buildShareSheetSelectionStep({ ...input, directoryKind: kind }) });
        if (controls.length) sections.push({ kind: 'static', id: `directory-controls:${kind}`, options: controls });
    }
    if (input.directoryKind) {
        return { id: shareSheetStepId(ns, input.directoryKind), inputPlaceholder: t('shareSheet.addPlaceholder'),
            disableInputFilter: true, emptyStateLabel: t('common.noMatches'), sections };
    }
    sections.push(...adapterSections.trailing ?? []);

    // What each level means here, then the domain's sharing rules. A popover or an inline editor keeps
    // them behind one Details row; a full sheet shows them, as the share sheet reads before deciding.
    if (input.presentation !== 'full' && (Object.values(adapter.levels).some(level => level.help) || adapter.notes?.length)) {
        sections.push({ kind: 'static', id: 'help', options: [{ id: 'access-help', testID: `${idPrefix}${ns}-help`, label: t('common.details'),
            onSelect: () => input.onExpand('access-help'), expandedContent: () => <ShareHelp adapter={adapter} testID={`${idPrefix}${ns}-help-content`} /> }] });
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

    return { id: shareSheetStepId(ns), ...(model.editable ? { inputPlaceholder: t('shareSheet.addPlaceholder') } : {}),
        autoFocusFirstOption: false, disableInputFilter: true, emptyStateLabel: t('common.noMatches'), sections };
}

export function ShareHandoffIcon(props: Readonly<{ name: 'link' | 'copy' }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />;
}
