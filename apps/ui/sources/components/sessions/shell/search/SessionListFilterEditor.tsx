import * as React from 'react';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    SelectionList,
    type SelectionListPagination,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { getTeamGroupsSnapshot } from '@/sync/store/teams/teamsSnapshots';
import { teamGroupsQueryKeyV1 } from '@happier-dev/protocol/teams';

import {
    buildSessionListFilterEditorModel,
    readSessionListAudienceTeamStepAddress,
    SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID,
    resolveSessionListFilterEditorSelectionChange,
    reduceSessionListFilterEditorSelection,
    resolveSessionListFilterScopeAvailability,
    type SessionListFilterAudienceOption,
    type SessionListFilterEditorLabels,
    type SessionListFilterHomeOption,
    type SessionListFilterTagOption,
} from './sessionListFilterEditorModel';
import {
    buildQualifiedAudienceSelectionKey,
    type SessionListFilterDeletedSelections,
    type SessionListViewContext,
    type SessionListViewFilters,
} from './sessionListViewFilters';
import type { CollectionConditionEdit, CollectionConditionValueCountRequest, CollectionConditionValueCounts, HappierCollectionConditionValuePicker } from '@happier-dev/plugin-ui/components';
import { CollectionConditionEditor } from '@/components/ui/lists/collection/CollectionConditionEditor';
import {
    SESSION_LIST_CONDITION_FIELD_ICONS,
    SESSION_LIST_CONDITION_GROUPS,
    SESSION_LIST_LOCKED_CONDITION_FIELDS,
    applySessionListConditionEdit,
    buildSessionListConditionBindings,
    buildSessionListConditionModel,
    resolveSessionListBaseConditionFields,
    type SessionListConditionCopy,
} from './sessionListConditionFields';
import { createSessionListViewFilterDefaults } from './sessionListViewFilters';
import { useProjectPickerOptions } from '@/components/projects/useProjectPickerOptions';
import { PROJECT_PICKER_THEME_SURFACE } from '@/components/projects/projectPickerThemeSurface';

import { useSessionListFilterLocalOptions } from './useSessionListFilterLocalOptions';
import { t } from '@/text';

const PROJECT_VALUE_SURFACES = { projects: PROJECT_PICKER_THEME_SURFACE };
/*
 * Audience identity belongs to the filter state owner. This component consumes its
 * qualified JSON key rather than maintaining a parallel Team-only syntax.
 */
function teamAudienceIdentity(serverId: string, teamId: string): string {
    return buildQualifiedAudienceSelectionKey({ serverId, kind: 'team', teamId });
}

export type SessionListFilterEditorCopy = SessionListFilterEditorLabels & Readonly<{
    title: string;
    clear: string;
    done: string;
    resultCount: (count: number) => string;
    runsNeedingYouAlwaysShow: string;
    needsMeOnly: string;
    needsMeOnlyDescription: string;
    moreTags: (count: number) => string;
    /** The condition list's own words (lab `clfilter`). */
    conditions: SessionListConditionCopy;
    /** The Archived destination's label; shown only when the host passes `onOpenArchived`. */
    archived?: string;
    catalogLoading?: string;
    catalogMore?: string;
    catalogRetry?: string;
    catalogError?: string;
    catalogPartial?: string;
    catalogEnd?: string;
}>;

export type SessionListFilterEditorProps = Readonly<{
    conditionValueCounts?: CollectionConditionValueCounts;
    onConditionValueCountRequest?: (request: CollectionConditionValueCountRequest | null) => void;
    result?: EntityListFilterResultV1;
    filters: SessionListViewFilters;
    includeInactive: boolean;
    inactiveVisibilityAvailable?: boolean;
    queryEnabled: boolean;
    followingAvailable: boolean;
    sourceAvailable: boolean;
    homes: readonly SessionListFilterHomeOption[];
    audiences: readonly SessionListFilterAudienceOption[];
    tags: readonly SessionListFilterTagOption[];
    /** Enables the canonical Teams directory and lazy per-Team Group producer. */
    teamAudienceContext?: SessionListViewContext;
    labels: SessionListFilterEditorCopy;
    fixedHomeServerIds?: ReadonlySet<string>;
    fixedAudienceKeys?: ReadonlySet<string>;
    /** Fixed destination semantics, for the Workflows Runs sidebar. */
    fixedShow?: SessionListViewFilters['show'];
    updateFilters(filters: SessionListViewFilters): void;
    removeAuthoritativelyDeletedSelections(deleted: SessionListFilterDeletedSelections): void;
    setIncludeInactive(includeInactive: boolean): void;
    /** Source is a persisted device preference, so it is written through its own owner. */
    setSource(source: SessionListViewFilters['source']): void;
    resetFilters(): void;
    /** Opens the archived list from the scope menu. Omitted on the archived corpus itself. */
    onOpenArchived?: () => void;
    /** Sessions the list currently shows for these choices, from the list's own derivation. */
    resultCount?: number;
    /**
     * What the list starts from (its saved space, or the context default): a condition shows while its
     * part of the filter differs from this, and removing it restores this. Defaults to a fresh filter.
     */
    baseFilters?: SessionListViewFilters;
    baseIncludeInactive?: boolean;
    /** Opens the save form with the current conditions (the Sessions column only). */
    onSaveAsSpace?: () => void;
    /** Where the filter is evaluated: a daemon rule (Follow, matching) offers only the fields the daemon can answer. */
    evaluator?: 'list' | 'daemonRule';
    doneLabel?: string;
    /** Worded result for a host whose result is a live preview rather than the list's count. */
    resultSummary?: string;
    onDone?: () => void;
    doneDisabled?: boolean;
    maxHeight?: number;
    disableTransitions?: boolean;
}>;

/** The shared editor's way back above a field's own value list. */
const PICKER_HEADER_HEIGHT = 44;

/** Session fields whose values keep the editor model's own list (see renderValuePicker). */
const SESSION_LIST_PICKER_SECTIONS: Readonly<Record<string, string>> = { scope: 'show', audiences: 'audiences' };

const stylesheet = StyleSheet.create({
    root: {
        minWidth: 280,
        flexShrink: 1,
    },
});

export const SessionListFilterEditor = React.memo(function SessionListFilterEditor(
    props: SessionListFilterEditorProps,
) {
    const styles = stylesheet;
    const audienceServerIds = React.useMemo(
        () => props.homes.map((home) => home.serverId),
        [props.homes],
    );
    const teamAudienceEnabled = props.queryEnabled && props.teamAudienceContext !== undefined;
    const directory = useTeamsDirectory({
        enabled: teamAudienceEnabled,
        serverIds: audienceServerIds,
        scope: 'member',
        archived: 'active',
    });
    const audienceContextKey = props.teamAudienceContext?.kind === 'team'
        ? `team:${props.teamAudienceContext.team.serverId}:${props.teamAudienceContext.team.teamId}`
        : props.teamAudienceContext?.kind ?? 'none';
    const [drilledTeamState, setDrilledTeamState] = React.useState<Readonly<{
        contextKey: string;
        address: TeamAddress;
    }> | null>(null);
    const drilledTeam = drilledTeamState?.contextKey === audienceContextKey
        ? drilledTeamState.address
        : null;
    const selectedGroupTeam = React.useMemo<TeamAddress | null>(() => {
        const selected = [...props.filters.audiences.include, ...props.filters.audiences.exclude].find((audience) => (
            audience.kind === 'group' && audienceServerIds.includes(audience.serverId)
        ));
        return selected?.kind === 'group'
            ? { serverId: selected.serverId, teamId: selected.teamId }
            : null;
    }, [audienceServerIds, props.filters.audiences]);
    const activeTeam = React.useMemo<TeamAddress | null>(() => {
        const context = props.teamAudienceContext;
        if (!context) return null;
        if (context.kind === 'team') return context.team;
        if (drilledTeam && audienceServerIds.includes(drilledTeam.serverId)) return drilledTeam;
        // A retained Group filter still needs its canonical Group catalog checked
        // even before the editor drills into that Team. This reuses the editor's
        // one incumbent Group observer and does not create another filter-lifetime
        // subscription or catalog.
        return selectedGroupTeam;
    }, [audienceServerIds, drilledTeam, props.teamAudienceContext, selectedGroupTeam]);
    const activeTeamScope = activeTeam
        ? directory.scopes.find((scope) => scope.serverId === activeTeam.serverId) ?? null
        : null;
    const groups = useTeamGroups({
        scope: activeTeamScope,
        address: activeTeam,
        archived: 'active',
        enabled: teamAudienceEnabled && activeTeam !== null,
    });
    const openedGroupDisplayNames = useTeamGroupDisplayNames({
        scope: activeTeamScope,
        groups: groups.rows,
    });
    const directoryComplete = teamAudienceEnabled
        && directory.kind !== 'loading'
        && !directory.partial
        && !directory.hasMore;
    const activeGroupsComplete = teamAudienceEnabled
        && activeTeam !== null
        && groups.status === 'ready'
        && groups.isCurrent
        && !groups.hasMore;

    const audiences = React.useMemo<readonly SessionListFilterAudienceOption[]>(() => {
        const context = props.teamAudienceContext;
        if (!context) return props.audiences;

        const homeLabels = new Map(props.homes.map((home) => [home.serverId, home.label]));
        const qualifyTeamLabel = (name: string, serverId: string) => props.homes.length <= 1
            ? name
            : `${name} · ${homeLabels.get(serverId) ?? serverId}`;
        const options: SessionListFilterAudienceOption[] = [...props.audiences];
        const rows = context.kind === 'team'
            ? directory.rows.filter((row) => (
                row.address.serverId === context.team.serverId
                && row.address.teamId === context.team.teamId
            ))
            : directory.rows;
        for (const row of rows) {
            options.push({
                serverId: row.address.serverId,
                kind: 'team',
                teamId: row.address.teamId,
                label: qualifyTeamLabel(row.team.name, row.address.serverId),
            });
        }
        const representedTeams = new Set(options.flatMap((option) => option.kind === 'team'
            ? [teamAudienceIdentity(option.serverId, option.teamId)]
            : []));
        if (context.kind === 'global' && !directoryComplete) {
            // These rows reify retained filter IDs only. They never claim to be
            // directory results and disappear once the current directory can
            // authoritatively prove that the Team no longer exists.
            for (const selected of [...props.filters.audiences.include, ...props.filters.audiences.exclude]) {
                if (selected.kind === 'outside_teams' || !audienceServerIds.includes(selected.serverId)) continue;
                const key = teamAudienceIdentity(selected.serverId, selected.teamId);
                if (representedTeams.has(key)) continue;
                representedTeams.add(key);
                options.push({
                    serverId: selected.serverId,
                    kind: 'team',
                    teamId: selected.teamId,
                    label: qualifyTeamLabel(selected.teamId, selected.serverId),
                });
            }
        }
        if (context.kind === 'team' && rows.length === 0) {
            options.push({
                serverId: context.team.serverId,
                kind: 'team',
                teamId: context.team.teamId,
                label: context.team.teamId,
            });
        }
        if (activeTeam) {
            for (const group of groups.rows) {
                options.push({
                    serverId: activeTeam.serverId,
                    kind: 'group',
                    teamId: activeTeam.teamId,
                    groupId: group.id,
                    label: openedGroupDisplayNames.get(group.id) ?? t('common.unavailable'),
                });
            }
            if (!activeGroupsComplete) {
                const representedGroups = new Set(groups.rows.map((group) => group.id));
                for (const selected of [...props.filters.audiences.include, ...props.filters.audiences.exclude]) {
                    if (selected.kind !== 'group'
                        || selected.serverId !== activeTeam.serverId
                        || selected.teamId !== activeTeam.teamId
                        || representedGroups.has(selected.groupId)) continue;
                    representedGroups.add(selected.groupId);
                    options.push({
                        serverId: activeTeam.serverId,
                        kind: 'group',
                        teamId: activeTeam.teamId,
                        groupId: selected.groupId,
                        label: selected.groupId,
                    });
                }
            }
        }
        return options;
    }, [
        activeGroupsComplete,
        activeTeam,
        audienceServerIds,
        directory.rows,
        directoryComplete,
        groups.rows,
        openedGroupDisplayNames,
        props.audiences,
        props.filters.audiences,
        props.homes,
        props.teamAudienceContext,
    ]);

    // A complete current owner answer is the only evidence that can remove a
    // retained ID. Partial, stale, offline and still-paginating reads keep the
    // selection intact, matching the filter-state lifetime contract.
    React.useEffect(() => {
        const context = props.teamAudienceContext;
        if (!context) return;
        const currentTeams = directoryComplete
            ? new Set(directory.rows.map((row) => teamAudienceIdentity(row.address.serverId, row.address.teamId)))
            : null;
        const currentGroups = activeGroupsComplete && activeTeam
            ? new Set(groups.rows.map((group) => group.id))
            : null;
        const deletedAudiences = [...props.filters.audiences.include, ...props.filters.audiences.exclude].filter((audience) => {
            if (audience.kind === 'outside_teams') return false;
            if (currentTeams && context.kind === 'global'
                && !currentTeams.has(teamAudienceIdentity(audience.serverId, audience.teamId))) return true;
            if (audience.kind === 'group') {
                const address = { serverId: audience.serverId, teamId: audience.teamId };
                const scope = directory.scopes.find((candidate) => candidate.serverId === audience.serverId) ?? null;
                const snapshot = getTeamGroupsSnapshot(
                    scope,
                    address,
                    teamGroupsQueryKeyV1({ v: 1, teamId: audience.teamId, archived: 'active' }),
                );
                if (
                    snapshot?.status === 'ready'
                    && !snapshot.stale
                    && snapshot.nextCursor === null
                    && snapshot.data !== null
                    && !snapshot.data.some((group) => group.id === audience.groupId)
                ) return true;
            }
            return audience.kind === 'group' && currentGroups !== null && activeTeam !== null
                && audience.serverId === activeTeam.serverId
                && audience.teamId === activeTeam.teamId
                && !currentGroups.has(audience.groupId);
        });
        if (deletedAudiences.length > 0) {
            props.removeAuthoritativelyDeletedSelections({ deletedAudiences });
        }
    }, [
        activeGroupsComplete,
        activeTeam,
        directory.rows,
        directory.scopes,
        directoryComplete,
        groups.rows,
        props.filters,
        props.removeAuthoritativelyDeletedSelections,
        props.teamAudienceContext,
    ]);
    const projects = useProjectPickerOptions();
    const model = React.useMemo(() => buildSessionListFilterEditorModel({
        filters: props.filters,
        includeInactive: props.includeInactive,
        inactiveVisibilityAvailable: props.inactiveVisibilityAvailable,
        attentionAvailable: props.queryEnabled,
        labels: props.labels,
        scopesAvailable: resolveSessionListFilterScopeAvailability(props),
        homes: props.homes,
        audiences,
        audiencePresentation: props.teamAudienceContext?.kind === 'global' ? 'team_drilldown' : 'flat',
        tags: props.tags,
        projects,
        sourceAvailable: props.sourceAvailable,
        fixedHomeServerIds: props.fixedHomeServerIds,
        fixedAudienceKeys: props.fixedAudienceKeys,
        fixedShow: props.fixedShow,
        archivedLabel: props.onOpenArchived ? props.labels.archived : undefined,
    }), [
        audiences,
        props.filters,
        props.fixedAudienceKeys,
        props.fixedHomeServerIds,
        props.fixedShow,
        props.followingAvailable,
        props.homes,
        props.includeInactive,
        props.inactiveVisibilityAvailable,
        props.labels,
        props.queryEnabled,
        props.sourceAvailable,
        props.tags,
        props.teamAudienceContext,
        props.onOpenArchived,
        projects,
    ]);
    const handleActiveStepChange = React.useCallback((step: SelectionListStep) => {
        if (props.teamAudienceContext?.kind !== 'global') return;
        const address = readSessionListAudienceTeamStepAddress(step.id);
        setDrilledTeamState(address ? {
            contextKey: audienceContextKey,
            address: { serverId: address.serverId, teamId: address.teamId },
        } : null);
    }, [audienceContextKey, props.teamAudienceContext]);
    const syncedAudienceStep = React.useMemo(() => {
        if (props.teamAudienceContext?.kind !== 'global' || !drilledTeam) return null;
        for (const section of model.rootStep.sections) {
            if (section.kind !== 'static') continue;
            for (const option of section.options) {
                const address = option.openStep
                    ? readSessionListAudienceTeamStepAddress(option.openStep.id)
                    : null;
                if (address?.serverId === drilledTeam.serverId && address.teamId === drilledTeam.teamId) {
                    return option.openStep ?? null;
                }
            }
        }
        return null;
    }, [drilledTeam, model.rootStep.sections, props.teamAudienceContext]);
    const handleSelect = React.useCallback((optionId: string) => {
        if (optionId === SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID) {
            props.onOpenArchived?.();
            return;
        }
        if (props.inactiveVisibilityAvailable === false && optionId.startsWith('inactive:')) return;
        if (!props.queryEnabled && optionId.startsWith('attention:')) return;
        if (props.fixedShow && optionId.startsWith('show:')) return;
        const next = resolveSessionListFilterEditorSelectionChange(
            props.filters,
            props.includeInactive,
            optionId,
            { fixedAudienceKeys: props.fixedAudienceKeys },
        );
        // Source has a persisted owner; every other facet is this surface's retained
        // view state. One option id only ever moves one facet, so the write goes to
        // exactly one writer.
        if (next.filters.source !== props.filters.source) {
            props.setSource(next.filters.source);
        } else if (next.filters !== props.filters) {
            props.updateFilters(next.filters);
        }
        if (next.includeInactive !== props.includeInactive) {
            props.setIncludeInactive(next.includeInactive);
        }
    }, [props]);
    const pagination = React.useMemo<SelectionListPagination | undefined>(() => {
        if (!teamAudienceEnabled) return undefined;
        const loadingLabel = props.labels.catalogLoading ?? props.labels.noOptions;
        const moreLabel = props.labels.catalogMore ?? props.labels.noOptions;
        const retryLabel = props.labels.catalogRetry ?? props.labels.noOptions;
        const endReachedLabel = props.labels.catalogEnd ?? props.labels.noOptions;
        const showGroups = activeTeam !== null && activeTeamScope !== null && (
            props.teamAudienceContext?.kind === 'team' || drilledTeam !== null
        );
        if (showGroups) {
            const retryable = groups.error?.retryable === true;
            return {
                hasMore: groups.hasMore,
                loadingMore: groups.status === 'loading'
                    || groups.status === 'loading_more'
                    || (groups.status === 'ready' && !groups.isCurrent && groups.error === null),
                requestKey: JSON.stringify([
                    activeTeam.serverId,
                    activeTeam.teamId,
                    groups.rows.map((row) => row.id),
                    groups.hasMore,
                ]),
                error: groups.status === 'error'
                    ? (props.labels.catalogError ?? props.labels.noOptions)
                    : null,
                onEndReached: () => { void groups.loadMore(); },
                ...(retryable ? { onRetry: () => { void groups.reload(); } } : {}),
                loadingLabel,
                moreLabel,
                retryLabel,
                endReachedLabel: groups.rows.length === 0 ? props.labels.noOptions : endReachedLabel,
            };
        }
        const unavailable = directory.unavailableHomes.filter((home) => home.reason !== 'loading');
        const retryable = directory.stale || unavailable.some((home) => home.retryable);
        return {
            hasMore: directory.hasMore,
            loadingMore: directory.unavailableHomes.some((home) => home.reason === 'loading')
                || (directory.kind === 'loading' && unavailable.length === 0),
            requestKey: JSON.stringify([
                directory.rows.map((row) => [row.address.serverId, row.address.teamId]),
                directory.hasMore,
            ]),
            error: unavailable.length > 0 || directory.stale
                ? (directory.rows.length > 0
                    ? props.labels.catalogPartial ?? props.labels.catalogError ?? props.labels.noOptions
                    : props.labels.catalogError ?? props.labels.noOptions)
                : null,
            onEndReached: directory.loadMore,
            ...(retryable ? { onRetry: directory.refresh } : {}),
            loadingLabel,
            moreLabel,
            retryLabel,
            endReachedLabel: directory.rows.length === 0 ? props.labels.noOptions : endReachedLabel,
        };
    }, [
        activeTeam,
        activeTeamScope,
        directory,
        drilledTeam,
        groups,
        props.labels,
        props.teamAudienceContext,
        teamAudienceEnabled,
    ]);

    const baseFilters = React.useMemo(() => props.baseFilters
        ?? createSessionListViewFilterDefaults({ homeServerIds: props.homes.map((home) => home.serverId) }),
    [props.baseFilters, props.homes]);
    const baseIncludeInactive = props.baseIncludeInactive ?? true;
    const [openedLocalFieldId, setOpenedLocalFieldId] = React.useState<string | null>(null);
    const localOptions = useSessionListFilterLocalOptions(props.homes, openedLocalFieldId,
        Boolean(props.filters.sections && props.filters.sections.include.length + props.filters.sections.exclude.length));
    const handleValuePickerChange = React.useCallback((request: CollectionConditionValueCountRequest | null) => {
        setOpenedLocalFieldId(request?.fieldId ?? null);
        props.onConditionValueCountRequest?.(request);
    }, [props.onConditionValueCountRequest]);
    const conditionLabels = props.labels.conditions;
    const choices = React.useMemo(() => buildSessionListConditionBindings({
        editorLabels: props.labels,
        copy: conditionLabels,
        scopesAvailable: resolveSessionListFilterScopeAvailability(props),
        homes: props.homes,
        tags: props.tags,
        projects,
        ...localOptions,
        audiences,
        fixedShow: props.fixedShow,
        attentionAvailable: props.queryEnabled,
        inactiveVisibilityAvailable: props.inactiveVisibilityAvailable !== false,
        sourceAvailable: props.sourceAvailable,
        ...(props.evaluator ? { evaluator: props.evaluator } : {}),
    }), [audiences, conditionLabels, localOptions, projects, props]);
    const conditionModel = React.useMemo(
        () => buildSessionListConditionModel(props.filters, props.includeInactive, choices.bindings, props.conditionValueCounts),
        [choices.bindings, props.filters, props.includeInactive, props.conditionValueCounts],
    );
    const hiddenFieldIds = React.useMemo(() => {
        const hidden = new Set(resolveSessionListBaseConditionFields({
            filters: props.filters, base: baseFilters, includeInactive: props.includeInactive, baseIncludeInactive,
        }));
        // A surface without inactive visibility (archived, a stored selector) has no such condition to show.
        if (props.inactiveVisibilityAvailable === false) hidden.add('includeInactive');
        return hidden;
    }, [baseFilters, baseIncludeInactive, props.filters, props.includeInactive, props.inactiveVisibilityAvailable]);
    const handleEdit = React.useCallback((edit: CollectionConditionEdit) => {
        applySessionListConditionEdit(edit, {
            filters: props.filters,
            includeInactive: props.includeInactive,
            updateFilters: props.updateFilters,
            setSource: props.setSource,
            setIncludeInactive: props.setIncludeInactive,
            resetFilters: props.resetFilters,
        });
    }, [props.filters, props.includeInactive, props.resetFilters, props.setIncludeInactive, props.setSource, props.updateFilters]);
    // Two Session fields keep their own value lists: Whose carries the Archived way out, and Shared with walks
    // Teams into Groups page by page. Each lists one section of the SAME editor model (same option ids), so
    // search, pagination and the Team drill-down behave as before. Status is the shared editor's grouped field.
    const renderValuePicker = React.useCallback<HappierCollectionConditionValuePicker>(({ field, operator, onChange, close, maxHeight }) => {
        const sectionId = SESSION_LIST_PICKER_SECTIONS[field.id];
        if (!sectionId) return null;
        const section = model.rootStep.sections.find((candidate) => candidate.id === sectionId)
            // While the Teams directory is still answering there are no audience rows yet; the list
            // opens empty and its pagination footer says it is loading.
            ?? (sectionId === 'audiences' && teamAudienceEnabled
                ? { kind: 'static' as const, id: 'audiences', title: props.labels.sharedWith, options: [] }
                : null);
        if (!section) return null;
        const audiencesPicker = sectionId === 'audiences';
        return (
            <SelectionList
                key={field.id}
                rootStep={{ ...model.rootStep, inputPlaceholder: field.label, sections: [{ ...section, title: undefined }] }}
                selection={audiencesPicker ? { kind: 'multiple', selectedIds: new Set(
                    (operator === 'is_not' ? props.filters.audiences.exclude : props.filters.audiences.include)
                        .map(audience => `audience:${buildQualifiedAudienceSelectionKey(audience)}`),
                ) } : model.selection}
                syncActiveStep={audiencesPicker && props.teamAudienceContext?.kind === 'global' ? syncedAudienceStep : undefined}
                onActiveStepChange={handleActiveStepChange}
                listAccessibilityLabel={field.label}
                onSelect={(optionId) => {
                    if (audiencesPicker) {
                        const next = reduceSessionListFilterEditorSelection(props.filters, optionId, {
                            fixedAudienceKeys: props.fixedAudienceKeys,
                            operator: operator === 'is_not' ? 'is_not' : 'is',
                        });
                        onChange([...(operator === 'is_not' ? next.audiences.exclude : next.audiences.include)]);
                    } else handleSelect(optionId);
                    // One Whose is the whole answer; audiences stay open for more.
                    if (sectionId === 'show') close();
                }}
                pagination={audiencesPicker ? pagination : undefined}
                onRequestClose={close}
                autoFocusInputOnWeb
                autoFocusInputOnNative={false}
                maxHeight={maxHeight === undefined ? undefined : Math.max(0, maxHeight - PICKER_HEADER_HEIGHT)}
                heightBehavior="content"
                showsVerticalScrollIndicator
                disableTransitions={props.disableTransitions}
                testID="session-list-filter-editor"
            />
        );
    }, [handleActiveStepChange, handleSelect, model.rootStep, model.selection, pagination, props.disableTransitions,
        props.labels.sharedWith, props.teamAudienceContext, props.filters, props.fixedAudienceKeys, syncedAudienceStep, teamAudienceEnabled]);

    return (
        <View testID="session-list-filter-editor-surface" style={styles.root}>
            <CollectionConditionEditor
                valueSurfaceByField={PROJECT_VALUE_SURFACES}
                testID="session-list-filter-conditions"
                model={conditionModel}
                onValuePickerChange={handleValuePickerChange}
                onChange={handleEdit}
                labels={{ ...conditionLabels, count: conditionLabels.resultCount }}
                result={props.result ?? (props.resultCount === undefined ? undefined : { matchedCount: props.resultCount, coverage: 'complete' })}
                {...(props.resultSummary === undefined ? {} : { resultSummary: props.resultSummary })}
                {...(props.onSaveAsSpace ? { onSaveAsSpace: props.onSaveAsSpace } : {})}
                {...(props.onDone ? { onDone: props.onDone } : {})}
                doneLabel={props.doneLabel ?? props.labels.done}
                {...(props.doneDisabled === undefined ? {} : { doneDisabled: props.doneDisabled })}
                lockedFieldIds={SESSION_LIST_LOCKED_CONDITION_FIELDS}
                hiddenFieldIds={hiddenFieldIds}
                addableFieldIds={choices.addableFieldIds}
                fieldGroups={[
                    { id: 'work', title: conditionLabels.groups.work, fieldIds: SESSION_LIST_CONDITION_GROUPS.work },
                    { id: 'people', title: conditionLabels.groups.people, fieldIds: SESSION_LIST_CONDITION_GROUPS.people },
                    { id: 'kind', title: conditionLabels.groups.kind, fieldIds: SESSION_LIST_CONDITION_GROUPS.kind },
                ]}
                fieldIcons={SESSION_LIST_CONDITION_FIELD_ICONS}
                formatValue={choices.formatValue}
                renderValuePicker={renderValuePicker}
                {...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight })}
            />
        </View>
    );
});
