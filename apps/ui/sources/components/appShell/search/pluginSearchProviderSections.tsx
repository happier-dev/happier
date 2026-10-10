import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema, MAX_PLUGIN_SEARCH_ITEMS_V1 } from '@happier-dev/protocol/plugins/contributions/search-providers';
import {
    normalizePluginUiSemanticCommandV1,
    type CurrentUiContextSnapshotV1,
    type PluginUiResolvedSemanticCommandV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    dispatchPluginResolvedSemanticCommand,
} from '@/components/plugins/surfaces/dispatchPluginResolvedSemanticCommand';
import type {
    PluginSurfaceActionDispatchOutcome,
    PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { PluginSurfaceOpenHandler, PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { comparePluginContributionOrder } from '@/sync/domains/plugins/contributionOrder';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    readPluginUiContributionOrigin,
} from '@/sync/domains/plugins/ui/projectionUnion';
import type {
    SelectionListDynamicSection,
    SelectionListDynamicSectionResolveResult,
    SelectionListOption,
} from '@/components/ui/selectionList';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/**
 * The Universal Search host adapter for `contributes.searchProviders`.
 *
 * It is a SECTION BUILDER, not a search engine. `SelectionList` and
 * `useSelectionListDynamicSections` remain the one query, debounce,
 * `AbortController`, stale-response fencing, loading/error and virtualization
 * owner; the plugin Action dispatcher remains the one executor; the semantic
 * command router remains the one activation owner. This module only decides
 * which admitted providers become sections, turns bounded provider rows into
 * host-rendered options, and hands activation back to its owner.
 *
 * Nothing here is Triage-specific. Triage is the first producer of the family,
 * and it reaches this surface through the same public contract any other
 * trusted plugin would.
 *
 * A provider's rows are already ranked by the plugin that produced them, so the
 * section declares `resultFiltering: 'provider'`: re-running the host matcher
 * over displayed labels would silently drop a valid result whose title does not
 * literally contain the query. Cross-provider score comparison never happens —
 * no score crosses the wire at all.
 */

/** Section ids are host-owned and provider-qualified. */
export const PLUGIN_SEARCH_SECTION_ID_PREFIX = 'plugin-search:';
/** Separates the host's section identity from the provider-local row id. */
const PLUGIN_SEARCH_ROW_ID_SEPARATOR = '::';

export type PluginSearchActivationOutcome =
    | PluginSurfaceActionDispatchOutcome
    | PluginSurfaceOpenOutcome;

export type BuildPluginSearchProviderSectionsInput = Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    /**
     * The registered scope's current facts. They decide both whether a provider
     * is offered at all and, at activation time, whether the row may still run.
     */
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined;
    /** Rows the host will render for one provider section. */
    rowLimit?: number;
    locale?: string | null;
    /** Exact admitting Account lifetime; string scope equality cannot replace it. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** Exact plugin-occurrence fence, composed with the exact Account lifetime. */
    isOccurrenceCurrent?: ((pluginId: string, occurrenceId: string) => boolean) | null;
    /** Controller-local presentation revision derived from Account retirement. */
    accountLifetimeRevision?: number;
    execute?: PluginSurfaceContributedActionTransport;
    openSurface?: PluginSurfaceOpenHandler;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    /**
     * Universal Search commits this exact activation before its host dismisses,
     * then awaits it and presents the returned outcome through its one error owner.
     */
    onCommitActivation: (activate: () => Promise<PluginSearchActivationOutcome>) => void;
}>;

function readProviderRowLimit(rowLimit: number | undefined): number {
    if (rowLimit === undefined || !Number.isInteger(rowLimit) || rowLimit < 1) {
        return MAX_PLUGIN_SEARCH_ITEMS_V1;
    }
    return Math.min(rowLimit, MAX_PLUGIN_SEARCH_ITEMS_V1);
}

/**
 * Providers only exist while the projection that admitted them does.
 *
 * A disabled, uninstalled or updated plugin loses its descriptor with its
 * projection, and a retired generation fails this check — so the section is
 * gone before a stale row can be rendered, let alone activated.
 */
function hasContributionOriginField(entry: unknown): boolean {
    return entry !== null
        && typeof entry === 'object'
        && Object.prototype.hasOwnProperty.call(entry, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY);
}

function resolveCurrentProviderScope(
    projection: PluginUiProjectionModel,
    provider: unknown,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (scopedLaunchFacts?.interactionEnabled !== true) return null;

    if (hasContributionOriginField(provider)) {
        const origin = readPluginUiContributionOrigin(provider);
        if (
            !origin
            || origin.phase !== 'current'
            || origin.interactionEnabled !== true
        ) return null;
        // Explicit Search scope is authoritative; never reuse a provider
        // projected for another Home or machine.
        // `null` denotes a coarse/union scope with no single server
        // constraint. Only non-null identifiers are exact constraints;
        // undefined means no scope facts were supplied at all.
        if (scopedLaunchFacts?.serverId !== null
            && scopedLaunchFacts?.serverId !== undefined
            && resolveServerProfileScopeIdForIdentifier(origin.serverId) !== resolveServerProfileScopeIdForIdentifier(scopedLaunchFacts.serverId)) return null;
        if (scopedLaunchFacts?.machineId !== null
            && scopedLaunchFacts?.machineId !== undefined
            && origin.machineId !== scopedLaunchFacts.machineId) return null;
        return Object.freeze({
            serverId: origin.serverId,
            machineId: origin.machineId,
            interactionEnabled: true,
        });
    }

    return scopedLaunchFacts?.machineId ? scopedLaunchFacts : null;
}

function toSectionId(pluginId: string, descriptorId: string): string {
    return `${PLUGIN_SEARCH_SECTION_ID_PREFIX}${pluginId}:${descriptorId}`;
}

function activationError(outcome: PluginSearchActivationOutcome): Error | null {
    return outcome.ok ? null : new Error(`${outcome.code}: ${outcome.reason}`);
}

function originsMatch(
    left: ReturnType<typeof readPluginUiContributionOrigin>,
    right: ReturnType<typeof readPluginUiContributionOrigin>,
): boolean {
    return left !== null
        && right !== null
        && left.serverId === right.serverId
        && left.machineId === right.machineId
        && left.executionOrigin !== null
        && right.executionOrigin !== null
        && arePluginMachineExecutionOriginsEqual(left.executionOrigin, right.executionOrigin);
}

export function buildPluginSearchProviderSections(
    input: BuildPluginSearchProviderSectionsInput,
): readonly SelectionListDynamicSection[] {
    const projection = input.projection;
    if (!projection) return [];
    const resolveContributedAction = createPluginUiProjectedActionResolver(projection.actionsById);
    const rowLimit = readProviderRowLimit(input.rowLimit);
    return Object.freeze(Object.values(projection.searchProvidersById)
        .slice()
        .sort(comparePluginContributionOrder)
        .flatMap((provider): SelectionListDynamicSection[] => {
            const providerScope = resolveCurrentProviderScope(
                projection,
                provider,
                input.scopedLaunchFacts,
            );
            if (!providerScope) return [];
            const queryAction = resolveContributedAction(provider.action);
            if (!isPluginProjectedActionExecutable(queryAction)) return [];
            if (provider.occurrenceId !== queryAction.occurrenceId) return [];
            if (
                hasContributionOriginField(provider)
                && !originsMatch(
                    readPluginUiContributionOrigin(provider),
                    readPluginUiContributionOrigin(queryAction),
                )
            ) return [];
            const scopeIsCurrent = input.accountLifetime || input.isOccurrenceCurrent
                ? () => (input.accountLifetime?.isCurrent() ?? true)
                    && (input.isOccurrenceCurrent?.(provider.pluginId, provider.occurrenceId) ?? true)
                : undefined;
            const sectionId = toSectionId(provider.pluginId, provider.descriptorId);
            const title = resolvePluginUiText({
                projection,
                pluginId: provider.pluginId,
                key: typeof queryAction.title === 'string' ? null : queryAction.title.key,
                locale: input.locale,
                fallback: typeof queryAction.title === 'string'
                    ? queryAction.title
                    : queryAction.title.fallback,
            });

            const activate = async (
                command: PluginUiResolvedSemanticCommandV1,
            ): Promise<PluginSearchActivationOutcome> => {
                if (scopeIsCurrent && !scopeIsCurrent()) {
                    return { ok: false, code: 'stale_surface', reason: 'plugin_ui_generation_retired' };
                }
                // Awaited and caught at the surface seam: a rejected activation
                // must reach the host's error owner, never an unhandled promise.
                let outcome: PluginSearchActivationOutcome;
                try {
                    outcome = await dispatchPluginResolvedSemanticCommand({
                        projection,
                        callerPluginId: provider.pluginId,
                        command,
                        scopedLaunchFacts: providerScope,
                        accountLifetime: input.accountLifetime ?? null,
                        ...(scopeIsCurrent ? { scopeIsCurrent } : {}),
                        ...(input.execute ? { execute: input.execute } : {}),
                        ...(input.openSurface ? { openSurface: input.openSurface } : {}),
                        ...(input.readCurrentUiContext
                            ? { readCurrentUiContext: input.readCurrentUiContext }
                            : {}),
                    });
                } catch (error) {
                    outcome = {
                        ok: false,
                        code: 'unavailable',
                        reason: error instanceof Error ? error.message : 'plugin_search_activation_failed',
                    };
                }
                return outcome;
            };

            const resolve = async (
                seed: string,
                abortSignal: AbortSignal,
            ): Promise<SelectionListDynamicSectionResolveResult> => {
                const query = seed.trim();
                if (abortSignal.aborted) throw new Error('plugin_search_query_aborted');
                const parsedQuery = PluginSearchQueryV1Schema.safeParse({ query, limit: rowLimit });
                if (!parsedQuery.success) throw new Error('plugin_search_query_invalid');
                // The query is an ordinary invocation of the declared Action
                // through the one router, carrying the section's AbortSignal so
                // cancellation reaches machine RPC and the plugin's handler.
                const outcome = await dispatchPluginResolvedSemanticCommand({
                    projection,
                    callerPluginId: provider.pluginId,
                    command: {
                        kind: 'executeAction',
                        action: provider.action,
                        input: parsedQuery.data,
                    },
                    scopedLaunchFacts: providerScope,
                    accountLifetime: input.accountLifetime ?? null,
                    signal: abortSignal,
                    ...(scopeIsCurrent ? { scopeIsCurrent } : {}),
                    ...(input.execute ? { execute: input.execute } : {}),
                    ...(input.readCurrentUiContext
                        ? { readCurrentUiContext: input.readCurrentUiContext }
                        : {}),
                });
                if (abortSignal.aborted || (scopeIsCurrent && !scopeIsCurrent())) {
                    return Object.freeze({ options: Object.freeze([]) });
                }
                const failure = activationError(outcome);
                if (failure) throw failure;
                // The universal boundary is where the canonical result is
                // parsed. A provider that answers off-contract fails only its
                // own section; every healthy section keeps its rows.
                const parsed = PluginSearchResultV1Schema.safeParse(
                    (outcome as Extract<PluginSurfaceActionDispatchOutcome, { ok: true }>).result,
                );
                if (!parsed.success) throw new Error('plugin_search_result_invalid');
                const itemIds = new Set<string>();
                for (const item of parsed.data.items) {
                    if (itemIds.has(item.id)) {
                        throw new Error('plugin_search_result_duplicate_id');
                    }
                    itemIds.add(item.id);
                }
                const options: SelectionListOption[] = parsed.data.items
                    .slice(0, rowLimit)
                    .map((item): SelectionListOption => {
                        const command = normalizePluginUiSemanticCommandV1({
                            pluginId: provider.pluginId,
                            command: item.command,
                        });
                        if (!command) throw new Error('plugin_search_result_invalid');
                        return {
                            id: `${sectionId}${PLUGIN_SEARCH_ROW_ID_SEPARATOR}${item.id}`,
                            label: item.title,
                            ...(item.subtitle === undefined ? {} : { subtitle: item.subtitle }),
                            ...(item.icon === undefined
                                ? {}
                                // The row visual is host-owned: a provider names a
                                // closed icon token and the host's own primitive
                                // renders it. No provider component crosses here.
                                : { icon: () => <Icon name={resolvePluginUiIconName(item.icon)} size={16} /> }),
                            onSelect: () => { input.onCommitActivation(() => activate(command)); },
                        };
                    });
                return Object.freeze({
                    options: Object.freeze(options),
                    ...(parsed.data.truncated || parsed.data.items.length > rowLimit
                        ? { resultHint: t('universalSearch.moreResultsAvailable') }
                        : {}),
                });
            };

            return [Object.freeze({
                id: sectionId,
                title,
                resolverKey: `${sectionId}|${providerScope.serverId ?? ''}|${providerScope.machineId ?? ''}|${provider.occurrenceId}|${JSON.stringify(readPluginUiContributionOrigin(provider)?.executionOrigin ?? null)}|account:${input.accountLifetimeRevision ?? 0}`,
                // Empty query is a UI state, not a wire request.
                visibleWhen: (value: string) => value.trim().length > 0,
                resultFiltering: 'provider' as const,
                resolve,
            })];
        }));
}
