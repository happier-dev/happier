import * as React from 'react';
import { HappierShareHelp } from '../presentation/sharing/ShareSheet.js';
import { ShareGrantRow, ShareLevelControl, ShareRowAction } from './ShareGrantRow.js';
import { ShareConnectedPeoplePrompt } from './ShareConnectedPeoplePrompt.js';
import { buildDirectorySelectionSection } from './buildDirectorySelectionSection.js';
import { useShareSheetHost } from './useShareSheetHost.js';
import type { ShareSheetHost } from './shareSheetHost.js';
import type { SelectionListOption, SelectionListSectionDescriptor, SelectionListStep } from './shareSelectionListTypes.js';
import { SHARE_ACCESS_LEVEL_ORDER, type ShareCandidateRowModel, type ShareDirectoryKind, type ShareDirectorySectionModel,
    type ShareGrantRowModel, type SharePrincipalPresentation, type ShareSheetActions, type ShareSheetModel,
    type ShareSheetSectionContext } from './shareGrantModels.js';
import type { ShareSheetAdapter, ShareSheetPresentation } from './shareSheetModels.js';
export const SHARE_DIRECTORY_KINDS: readonly ShareDirectoryKind[] = ['account', 'group', 'team'];

function principalKindLabel(principal: SharePrincipalPresentation, host: ShareSheetHost): string {
    // A Team that says who is in it needs no "Team" word: its section and glyph already say so.
    return principal.ref.kind === 'account' || (principal.ref.kind === 'team' && principal.secondaryLabel) ? ''
        : principal.ref.kind === 'group' ? host.text('shareSheet.group') : host.text('shareSheet.team');
}

/**
 * The row's leading identity mark: the canonical `Avatar` for an Account and the themed kind glyph
 * for a Team or Group. Decorative on purpose: the row's own `accessibilityLabel` is the single
 * accessible name, and the visible kind stays in the subtitle.
 */
export function SharePrincipalVisual(props: Readonly<{ principal: SharePrincipalPresentation; testID: string; size?: number; host?: ShareSheetHost }>): React.ReactElement {
    const host = useShareSheetHost(props.host);
    return <host.PrincipalVisual principal={props.principal} testID={props.testID} size={props.size} />;
}

/** One help block: the level legend, then the domain rules and members-only link explanation. */
export function ShareHelp<TRow extends ShareGrantRowModel>(props: Readonly<{
    adapter: ShareSheetAdapter<TRow>; testID: string; host: ShareSheetHost;
    /** Inside the Details disclosure the row already carries the info mark; the note does not repeat it. */
    markNote?: boolean;
}>): React.ReactElement {
    const presentationHost = props.host.useSharePresentation();
    const lines = SHARE_ACCESS_LEVEL_ORDER.flatMap(level => {
        const presentation = props.adapter.levels[level];
        return presentation?.help ? [{ label: presentation.label, text: presentation.help }] : [];
    });
    return <HappierShareHelp host={presentationHost} testID={props.testID} levels={lines}
        noteIcon={props.markNote === false ? undefined : <props.host.Icon name="info" />}
        note={[...(props.adapter.notes ?? []), ...(props.adapter.linkPath ? [props.host.text('shareSheet.membersOnlyLink')] : [])].join(' ')} />;
}

export type ShareSheetStepInput<TRow extends ShareGrantRowModel> = Readonly<{
    host: ShareSheetHost;
    model: ShareSheetModel<TRow>;
    actions: ShareSheetActions;
    adapter: ShareSheetAdapter<TRow>;
    presentation: ShareSheetPresentation;
    onExpand(key: string | null): void;
    /** The open row (a grant, the public link or Details), so a disclosure row can close again. */
    expandedKey?: string | null;
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
    const { model, actions, adapter, idPrefix, host } = input;
    const ns = adapter.namespace;
    // Collapsed, the Browse entries share one group instead of trailing three empty headings.
    const suggestionsShown = input.directoryKind !== undefined || input.revealSuggestions !== false;
    const context: ShareSheetSectionContext = { idPrefix, editable: model.editable, onExpand: input.onExpand, revealSuggestions: suggestionsShown,
        ...(input.directoryKind ? { directoryKind: input.directoryKind } : {}) };
    const adapterSections = input.directoryKind && !adapter.showLeadingOnDirectorySteps ? {} : adapter.sections?.(context) ?? {};
    const subtitle = (principal: SharePrincipalPresentation, row?: TRow, extra?: readonly (string | undefined)[]) =>
        [principalKindLabel(principal, host), principal.secondaryLabel, ...(adapter.principalTags?.(principal, row) ?? []), ...(extra ?? [])]
            .filter(Boolean).join(' · ');
    const accessiblePrincipal = (principal: SharePrincipalPresentation, row?: TRow) =>
        [principal.accessibilityLabel, ...(adapter.principalTags?.(principal, row) ?? []),
            row?.operation.kind === 'error' ? row.operation.error.message : undefined].filter(Boolean).join(', ');
    const visual = (principal: SharePrincipalPresentation) => () => <SharePrincipalVisual host={host} principal={principal}
        testID={`${idPrefix}${ns}-principal-visual:${principal.key}`} />;
    const excluded = new Set(model.grants.map((row) => row.principal.key));
    if (model.owner) excluded.add(model.owner.principal.key);

    // A sheet with one level for everyone (every level reads the same) says it once, in its description;
    // there a removable row's one control is Remove, visible at rest rather than behind opening the row.
    const singleLevel = new Set(Object.values(adapter.levels).flatMap(level => level ? [level.label] : [])).size <= 1;
    const current: SelectionListOption[] = [];
    if (model.owner) current.push({ id: model.owner.principal.key, label: model.owner.principal.displayName,
        subtitle: subtitle(model.owner.principal), accessibilityLabel: accessiblePrincipal(model.owner.principal),
        icon: visual(model.owner.principal), rightAccessory: () => <host.SecondaryText>{host.text('shareSheet.owner')}</host.SecondaryText> });
    for (const row of model.grants) {
    const removeOnRow = singleLevel && model.editable && row.removal.kind === 'allowed' && !adapter.renderGrantDetails;
    const removeLabel = adapter.removalLabels?.(row)?.request ?? host.text('shareSheet.remove');
    current.push({
        id: row.principal.key, testID: `${idPrefix}${ns}-grant-${row.principal.key}`,
        label: row.principal.displayName,
        subtitle: subtitle(row.principal, row, [row.operation.kind === 'error' ? row.operation.error.message : undefined]),
        // A domain tag or failure on a grant is the reason it behaves differently; it wraps rather than truncates on a phone.
        subtitleLines: 2,
        accessibilityLabel: accessiblePrincipal(row.principal, row),
        icon: visual(row.principal),
        loading: row.operation.kind === 'saving' || row.operation.kind === 'removing',
        onSelect: () => input.onExpand(row.principal.key),
        rightAccessoryOutsidePressable: true,
        rightAccessory: removeOnRow
            ? () => <ShareRowAction useHost={host.useGrantRowPresentation} label={removeLabel} tone="destructive" endsRow
                testID={`${idPrefix}${ns}-remove:${row.principal.key}`}
                accessibilityLabel={`${row.principal.accessibilityLabel}, ${removeLabel}`}
                disabled={row.operation.kind === 'saving' || row.operation.kind === 'removing'}
                // Open the row so a removal that asks for confirmation shows it in place.
                onPress={() => { input.onExpand(row.principal.key); actions.requestRemove(row.grant); }} />
            : () => <ShareLevelControl useHost={host.useGrantRowPresentation} row={row} adapter={adapter} actions={actions} editable={model.editable}
                onExpand={() => input.onExpand(row.principal.key)} testID={`${idPrefix}${ns}-level:${row.principal.key}`} />,
        expandedContentInset: 'text',
        ...(removeOnRow ? {} : { expandedContent: () => <ShareGrantRow useHost={host.useGrantRowPresentation} row={row} adapter={adapter} actions={actions} context={context} /> }),
    });
    }

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
                subtitle: subtitle(row.principal, undefined, [reason ? host.text('shareSheet.cantAdd') : undefined,
                    row.operation.kind === 'error' ? row.operation.error.message : undefined]),
                accessibilityLabel: reason ? `${row.principal.accessibilityLabel}, ${reason.message}` : row.principal.accessibilityLabel,
                icon: visual(row.principal),
                loading: row.operation.kind === 'saving',
                disabled: row.operation.kind === 'saving',
                onSelect: () => reason ? actions.explain(reason) : actions.addPrincipal(row.principal.ref),
                ...(reason ? {} : { rightAccessoryOutsidePressable: true,
                    rightAccessory: () => <ShareRowAction useHost={host.useGrantRowPresentation} label={host.text('common.add')}
                        testID={`${idPrefix}${ns}-add:${row.principal.key}`}
                        disabled={row.operation.kind === 'saving'}
                        onPress={() => actions.addPrincipal(row.principal.ref)}
                        trailing={<host.Icon name="plus" />} /> }),
            }];
        });
    };
    const sourceSection = (source: ShareDirectorySectionModel): SelectionListSectionDescriptor => buildDirectorySelectionSection({
        loadingLabel: host.text('common.loading'), source, id: `directory:${source.kind}`, title: input.directoryKind
            ? source.title : host.suggestions(source.title),
        resolverKey: JSON.stringify([source.resolverKey ?? source.kind, [...excluded], source.resolveCandidates ? undefined : model.revision]),
        // A directory step is the section, so its first load shows a skeleton row. On the root, suggestions
        // whose existence is unknown stay out until they resolve: a heading that appears and then empties
        // moved everything below it twice on every open (RUX-11.2).
        showSkeletonsOnFirstLoad: input.directoryKind !== undefined,
        options: (rows, query) => {
            const options = candidateOptions(rows);
            // Only friends and teammates can be found, so a people search that finds no one says so and leads to
            // connecting first (the people directory's own empty prompt), instead of a bare "No matches". Someone
            // found who already has access is shown under Who has access, not as a reason to connect.
            const typed = query.trim();
            const noOne = source.kind === 'account' && source.resolveCandidates !== undefined && typed !== '' && rows.length === 0;
            return noOne ? [{ id: 'search-empty', label: host.noMatchingPeople(typed), disabled: true,
                content: <ShareConnectedPeoplePrompt host={host} query={typed} testID={`${idPrefix}${ns}-search-empty`} /> }] : options;
        },
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
            title: model.stale ? host.text('shareSheet.whoHasAccessStale') : host.text('shareSheet.whoHasAccess'), options: current });
        roster.push(...adapterSections.afterAccess ?? []);
        const publicLink = adapter.publicLink;
        if (publicLink) roster.push({ kind: 'static', id: 'public-link', options: [{
            id: 'public-link', testID: `${idPrefix}${ns}-public-link`, label: publicLink.label ?? host.text('session.sharing.publicLink'),
            icon: () => <host.Icon name="link" />,
            accessibilityLabel: `${publicLink.label ?? host.text('session.sharing.publicLink')}, ${publicLink.stateLabel}`,
            rightAccessory: () => <host.PublicLinkState stateLabel={publicLink.stateLabel} />,
            onSelect: publicLink.onOpen ?? (() => input.onExpand('public-link')),
            ...(publicLink.renderContent ? { expandedContentInset: 'text', expandedContent: () => publicLink.renderContent!(context) } : {}),
        }] });
    }
    if (!searching) sections.push(...roster);
    const collapsedControls: SelectionListOption[] = [];
    const suggestionSections: SelectionListSectionDescriptor[] = [];
    if (model.editable) for (const kind of SHARE_DIRECTORY_KINDS) {
        if (input.directoryKind && input.directoryKind !== kind) continue;
        const source = model.directory.sections.find((section) => section.kind === kind);
        if (!source) continue;
        // Idle describes activity, not whether a lazy directory has answered. Keep its intent entry
        // reachable until the owner resolves it; a resolver alone does not prove an empty directory.
        if (!input.directoryKind && kind !== 'account' && (source.resolved ?? !source.resolveCandidates)
            && source.status === 'idle' && source.candidates.length === 0 && !source.hasMore) continue;
        if (suggestionsShown) suggestionSections.push(sourceSection(source));
        const controls: SelectionListOption[] = [];
        if (source.status === 'error' && source.error) controls.push({ id: `retry:${kind}`, label: source.error.message,
            rightAccessoryOutsidePressable: true, rightAccessory: () => <ShareRowAction useHost={host.useGrantRowPresentation} label={host.text('common.retry')}
                testID={`${idPrefix}${ns}-directory-retry:${kind}`} onPress={() => actions.retryDirectory(kind)} /> });
        // A searchable directory (a resolver) is always one Browse away: a query's page says nothing about everyone
        // else. A fixed people list already shown as suggestions needs Browse only for its next page.
        const browsable = source.resolveCandidates !== undefined || source.hasMore
            || (source.candidates.length > 0 && !(kind === 'account' && suggestionsShown));
        if (!input.directoryKind && browsable) controls.push({ id: `browse:${kind}`,
            label: host.text(kind === 'account' ? 'shareSheet.browsePeople' : kind === 'team' ? 'shareSheet.browseTeams' : 'shareSheet.browseGroups'),
            icon: () => <host.Icon name="users" />,
            ...(source.status === 'loading' || source.status === 'refreshing' ? { subtitle: host.text('common.loading') } : {}),
            testID: `${idPrefix}${ns}-browse:${kind}`,
            openStep: buildShareSheetSelectionStep({ ...input, directoryKind: kind }) });
        if (!suggestionsShown) { if (!adapter.browseOnlyWhileAdding) collapsedControls.push(...controls); }
        else if (controls.length) sections.push({ kind: 'static', id: `directory-controls:${kind}`, options: controls });
    }
    if (collapsedControls.length) sections.push({ kind: 'static', id: 'directory-controls', options: collapsedControls });
    // Browse stays above results that arrive asynchronously, so its rows never move on arrival.
    sections.push(...suggestionSections);
    if (input.directoryKind) {
        // A settled people directory with no one to add says who appears there and where to connect with someone.
        const directory = model.directory.sections.find(section => section.kind === input.directoryKind);
        if (directory && input.directoryKind === 'account' && model.directory.query.trim() === '' && directory.status === 'idle'
            && !directory.hasMore && candidateOptions(directory.candidates).length === 0) sections.push({ kind: 'static',
            id: 'directory-empty', options: [{ id: 'directory-empty', label: host.text('shareSheet.noConnectedPeople'), disabled: true,
                content: <ShareConnectedPeoplePrompt host={host} testID={`${idPrefix}${ns}-directory-empty`} /> }] });
        return { id: shareSheetStepId(ns, input.directoryKind), inputPlaceholder: host.text('shareSheet.addPlaceholder'),
            disableInputFilter: true, emptyStateLabel: host.text('common.noMatches'), sections };
    }
    sections.push(...adapterSections.trailing ?? []);
    if (searching) sections.push(...roster);

    // Popovers and full sheets disclose the level meanings and sharing rules behind one row, so they never
    // trail the list as an orphan legend; an inline sheet inside a host's form shows them in its footer.
    if (input.presentation !== 'inline' && (Object.values(adapter.levels).some(level => level.help) || adapter.notes?.length)) {
        // A disclosure row, not a heading: it carries its mark so it reads as something to open.
        sections.push({ kind: 'static', id: 'help', options: [{ id: 'access-help', testID: `${idPrefix}${ns}-help`, label: host.text('common.details'),
            icon: () => <host.Icon name="info" />, disclosure: true,
            onSelect: () => input.onExpand(input.expandedKey === 'access-help' ? null : 'access-help'), expandedContentInset: 'none',
            expandedContent: () => <ShareHelp host={host} adapter={adapter} markNote={false} testID={`${idPrefix}${ns}-help-content`} /> }] });
    }

    const handoffs: SelectionListOption[] = [];
    if (input.presentation !== 'full' && input.copyLink) {
        const copyLink = input.copyLink;
        handoffs.push({ id: 'copy-link', testID: `${idPrefix}${ns}-copy-link`, label: host.text('shareSheet.copyLink'),
            ...(copyLink.copied ? { subtitle: host.text('shareSheet.linkCopied') } : {}),
            icon: () => <host.Icon name="link" />, onSelect: copyLink.onCopy });
    }
    if (input.presentation !== 'full' && adapter.sendCopy) handoffs.push({ id: 'send-copy', testID: `${idPrefix}${ns}-send-copy`, label: host.text('shareSheet.sendCopy'),
        icon: () => <host.Icon name="copy" />, onSelect: adapter.sendCopy });
    if (handoffs.length) sections.push({ kind: 'static', id: 'handoffs', options: handoffs });

    return { id: shareSheetStepId(ns), ...(model.editable ? { inputPlaceholder: adapter.searchPlaceholder ?? host.text('shareSheet.addPlaceholder') } : {}),
        autoFocusFirstOption: false, disableInputFilter: true, emptyStateLabel: host.text('common.noMatches'), sections };
}
