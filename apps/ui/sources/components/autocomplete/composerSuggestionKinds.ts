import * as React from 'react';

import {
    DaemonPluginComposerReferenceSearchResponseSchema,
    MENTION_KIND_V1,
    buildComposerReferenceMentionPayloadV1,
    buildMentionRefForKindV1,
    type PluginContributionIdentityV1,
    type PluginContributionIntrospectionPresentationV1,
    type PluginLocalizedStringV2,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    FileMentionSuggestion,
    SessionMentionAgentLogo,
} from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import { Icon } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { searchFiles, type FileItem, type FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import {
    buildComposerSessionTokenSlug,
    readComposerSessionSuggestionItems,
} from '@/sync/domains/input/suggestionSession';
import { resolvePromptInvocationAutocompleteSelection } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { TranslationKeyNoParams } from '@/text';
import type {
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';

import type { AutocompleteSuggestion } from './autocompleteTypes';
import { getCommandSuggestions } from './commandSuggestions';
import {
    matchesComposerSuggestionQuery,
    resolveComposerSuggestionSkillIdentity,
    type ComposerSuggestionCatalogs,
} from './composerSuggestionCatalogs';
import {
    COMPOSER_SUGGESTION_KIND_IDS,
    formatComposerSuggestionToken,
    resolveComposerSuggestionKindIdsForTrigger,
    resolveComposerSuggestionTriggersForKind,
    type ComposerSuggestionKindId,
    type ComposerSuggestionTrigger,
} from './composerSuggestionGrammar';

/**
 * Composer suggestion registry — one owner for each kind's candidate resolution,
 * row content, token formatting and selection application (R-3).
 *
 * It spans `@` references, `$` skills and `/` commands, which is why it is a
 * *suggestion* registry and not a mention registry (D-1): a slash command is not
 * a mention. Reference-producing kinds will later gain `toMentionRef`; command
 * kinds implement `applySelection`, because a prompt invocation rewrites the
 * whole composer input and cannot be expressed as a token string (D-20).
 *
 * The trigger a kind uses is declared in `composerSuggestionGrammar.ts` and is
 * never restated here.
 *
 * **Every dependency here is imported statically, deliberately.** A first-party
 * `await import(...)` is not a local registry lookup on native: Expo's dev server
 * enables lazy bundling, so it becomes an HTTP fetch of that module's remaining
 * subgraph at call time (`utils/platform/loadExpoNotifications.ts` documents the
 * same mechanism). Measured on an iOS dev client, the chunk behind `suggestionFile`
 * is 68 MB and the request never completed: the `file` kind never settled, so
 * typing `@` showed nothing, and `applySelection`'s load never settled either, so
 * tapping a prompt-template row did nothing. `/` kept working only because its
 * resolver was already a static import. Deferring a module load here buys a
 * deferred initialization inside one bundle and costs the whole feature on the
 * platform users run; pinned by `composerSuggestionKinds.moduleLoad.native.test.ts`.
 */

export type { ComposerSuggestionKindId } from './composerSuggestionGrammar';

/**
 * The mounted Session composer is the only host that offers all first-party
 * suggestion kinds. Keep its eligibility list beside the registry so the host
 * and its real picker wiring test cannot drift into separate decisions.
 */
export const SESSION_COMPOSER_SUGGESTION_KINDS = [
    'file',
    'vendorPlugin',
    'session',
    'composerReference',
    'skill',
    'slashCommand',
] as const satisfies readonly ComposerSuggestionKindId[];

/**
 * The NEW-session composer's eligibility list (R-9): exactly the kinds whose candidate source
 * exists before a session does. Files are workspace state — the user has already picked the
 * machine and the folder — referenceable sessions are the target server's, not this session's,
 * and composer references come from the target daemon's current projection. Plugins and skills
 * stay out: those catalogs are session metadata published only after spawn.
 *
 * It lives beside the session list for the same reason that one does: kept private to the
 * screen model, the host's decision and the wiring test's could drift, and dropping a kind
 * here silently removes a user-visible capability with no failing test anywhere.
 */
export const NEW_SESSION_COMPOSER_SUGGESTION_KINDS = [
    'file',
    'session',
    'composerReference',
    'slashCommand',
] as const satisfies readonly ComposerSuggestionKindId[];

/** Which session catalog snapshot a kind reads, if any. */
export type ComposerSuggestionCatalogKey = 'vendorPlugins' | 'skills';

/**
 * Placement-owned daemon facts for the public reference search. The picker gets
 * no resolver callback or retained catalog: it reads the raw projection only to
 * discover the generation-bound identities that the daemon already admitted.
 */
export type ComposerReferenceSearchHost = Readonly<{
    machineId: string;
    serverId?: string | null;
    projection: PluginProjectionV2;
    /** False as soon as this composer loses focus, scope, or projection currency. */
    isCurrent(): boolean;
}>;

export type ComposerSuggestionResolveContext = Readonly<{
    /**
     * The session whose *published* state this composer reads: its command list, its plugin
     * and skill catalogs, and which session the `@session` picker must exclude.
     *
     * `null` before the session exists. That is not a degraded case — it is the honest
     * answer, and the kinds that need a session simply contribute nothing. It replaces a
     * `'__new_session__'` sentinel that was threaded through session-addressed APIs to fake
     * one, and which made every session-addressed lookup silently answer for no session.
     */
    sessionId: string | null;
    /**
     * The machine and folder this composer's file search is addressed to.
     *
     * Files are not session state, they are workspace state, so this is what scopes them —
     * for an existing session (which resolves its own workspace target) and for the
     * new-session composer (which has the machine and directory the user just picked) alike.
     * There is no host-specific branch: a host with no folder yet passes `null`.
     */
    workspace: FileSuggestionScope | null;
    /**
     * The server this composer targets, when the host has no session to derive it from.
     *
     * Only the new-session composer sets it: it declares the server its session will spawn
     * on. Every other host leaves it `null` and the current session's server is used. It is
     * not a duplicate of `workspace.serverId`: this one answers "whose sessions are
     * referenceable" (D-8), that one is part of a machine address.
     */
    serverId: string | null;
    /** Token query with the trigger stripped and any quoted span unquoted. */
    trigger: ComposerSuggestionTrigger;
    query: string;
    /** `query` with a matched scope alias removed (`@plugin:foo` -> `foo`). */
    scopedQuery: string;
    /** The scope alias matched in the token, or null. */
    scope: string | null;
    catalogs: ComposerSuggestionCatalogs;
    limit: number;
    /** The active query's cancellation, owned by `useActiveSuggestions`. */
    signal?: AbortSignal;
    /** Absent outside the mounted, current session composer. */
    composerReferenceHost?: ComposerReferenceSearchHost | null;
    /** Current controller-admitted session Actions for the slash kind only. */
    contributedActions?: readonly PluginContributedActionDescriptor[];
    /** Incremental rows from a provider family, still fenced by its host currentness. */
    publish?: (suggestions: readonly AutocompleteSuggestion[]) => void;
}>;

export type ComposerSuggestionSelectionResult =
    | Readonly<{ handled: false; preserveInput?: boolean }>
    | Readonly<{ handled: true; text: string; cursorPosition: number }>;

export type ComposerSuggestionApplySelectionArgs = Readonly<{
    suggestion: AutocompleteSuggestion;
    inputText: string;
    selection: Readonly<{ start: number; end: number }>;
    activeWord: Readonly<{ offset: number; endOffset: number }> | null;
    /** Mounted host callback that opens the controller-owned Action/form path. */
    onContributedActionSuggestionSelect?: (
        action: PluginContributedActionDescriptor,
    ) => Promise<PluginContributedActionOpenOutcome> | PluginContributedActionOpenOutcome;
}>;

export type ComposerSuggestionKindDefinition = Readonly<{
    id: ComposerSuggestionKindId;
    /**
     * Token scope aliases that select this kind exclusively. `plugin` and
     * `plugins` are an alias pair, not two kinds.
     */
    scopes?: readonly string[];
    catalog?: ComposerSuggestionCatalogKey;
    /** Maximum rows this kind contributes. Per-trigger sums are bounded (D-22). */
    limit: number;
    /**
     * Picker section header for this kind's rows (R-1). Resolved at render time
     * so a language change is picked up, exactly like `markdown.slash.groups.*`.
     */
    sectionTitleKey: TranslationKeyNoParams;
    /**
     * Leading glyph for the default `CommandMenuRow`. Kinds that render their own
     * row through `component` do not set it.
     */
    icon?: () => React.ReactNode;
    resolve: (context: ComposerSuggestionResolveContext) => Promise<readonly AutocompleteSuggestion[]>;
    /**
     * Rewrites the composer input when a candidate is chosen, for kinds whose
     * selection is not "replace the token with a string".
     */
    applySelection?: (args: ComposerSuggestionApplySelectionArgs) => Promise<ComposerSuggestionSelectionResult>;
}>;

function buildFileSuggestion(file: FileItem): AutocompleteSuggestion {
    return {
        kind: 'file',
        key: `file-${file.fullPath}`,
        text: formatComposerSuggestionToken('@', file.fullPath),
        structuredInput: {
            kind: MENTION_KIND_V1.file,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, file.fullPath),
            label: file.fileName,
        },
        component: () => React.createElement(FileMentionSuggestion, {
            fileName: file.fileName,
            filePath: file.filePath,
            fileType: file.fileType,
        }),
    };
}

async function resolveFileSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    if (context.catalogs.files) return context.catalogs.files.map(buildFileSuggestion);
    // Failures propagate. A `catch { return [] }` here used to make a failed import,
    // a rejected file-search RPC and a genuinely empty result the SAME observable
    // outcome — an empty picker with no diagnostic anywhere. The dispatcher already
    // turns a rejected kind into "no rows plus one diagnostic" (D-25), which is the
    // single place that decision belongs.
    // Addressed by the composer's machine + folder, never by its session: `workspace` is
    // `null` only when this host genuinely has no folder yet, and then there is nothing to
    // search rather than a session-shaped lookup that silently answers for the wrong scope.
    const files = await searchFiles(context.workspace, context.scopedQuery, {
        limit: context.limit,
        ...(context.signal ? { signal: context.signal } : {}),
    });
    return files.map(buildFileSuggestion);
}

async function resolveVendorPluginSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const plugin of context.catalogs.vendorPlugins ?? []) {
        if (out.length >= context.limit) break;
        // The daemon's own `mentionable` decision wins when present; the
        // installed+enabled pair is the fallback for older snapshots.
        const mentionable = plugin.mentionable ?? (plugin.installed === true && plugin.enabled === true);
        if (!mentionable) continue;
        if (seen.has(plugin.vendorPluginRef)) continue;
        const label = plugin.displayName ?? plugin.name;
        if (
            !matchesComposerSuggestionQuery(plugin.name, context.scopedQuery)
            && !matchesComposerSuggestionQuery(label, context.scopedQuery)
        ) continue;
        seen.add(plugin.vendorPluginRef);
        out.push({
            kind: 'vendorPlugin',
            key: `vendor-plugin-${plugin.vendorPluginRef}`,
            text: formatComposerSuggestionToken('@', plugin.name),
            label,
            // Same precedence the deleted bespoke row used, so consolidation is
            // not a silent copy change.
            description: plugin.marketplace ?? plugin.source ?? plugin.name,
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: plugin.vendorPluginRef,
                label,
                ...(plugin.backendId ? { backendId: plugin.backendId } : {}),
                ...(plugin.agentId ? { agentId: plugin.agentId } : {}),
            },
        });
    }
    return out;
}

/** The scope alias that narrows `@` to same-server Sessions. */
const SESSION_SUGGESTION_SCOPE = 'session';

/**
 * A Session row carries a relative `session:<id>` reference. The display slug is
 * intentionally advisory: title renames change the next token a user sees but
 * never the durable identity or server scope.
 */
async function resolveSessionSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const out: AutocompleteSuggestion[] = [];
    const sessions = context.catalogs.sessions ?? readComposerSessionSuggestionItems({
        serverId: context.serverId,
        currentSessionId: context.sessionId,
    });
    for (const item of sessions) {
        if (out.length >= context.limit) break;
        const slug = buildComposerSessionTokenSlug(item);
        if (
            !matchesComposerSuggestionQuery(item.title, context.scopedQuery)
            && !matchesComposerSuggestionQuery(slug, context.scopedQuery)
            && !matchesComposerSuggestionQuery(item.workspaceLabel ?? '', context.scopedQuery)
        ) {
            continue;
        }
        out.push({
            kind: 'session',
            key: `session-${item.id}`,
            text: formatComposerSuggestionToken('@', `${SESSION_SUGGESTION_SCOPE}:${slug}`),
            label: item.title,
            description: item.workspaceLabel ?? item.agentLabel ?? item.id,
            // Which agent is running in a session is what a user scans this list for, so the
            // row carries that session's provider logo rather than the kind's shared glyph.
            // An unresolvable flavor keeps the glyph: a wrong logo is worse than a generic one.
            ...(item.agentId
                ? {
                    icon: React.createElement(SessionMentionAgentLogo, {
                        agentId: item.agentId,
                        testID: `composer-session-agent-logo-${item.id}`,
                    }),
                }
                : {}),
            structuredInput: {
                kind: MENTION_KIND_V1.session,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, item.id),
                label: item.title,
            },
        });
    }
    return out;
}

function isComposerReferenceHostCurrent(host: ComposerReferenceSearchHost): boolean {
    try {
        return host.isCurrent();
    } catch {
        return false;
    }
}

/**
 * The raw projection is the sole reference-discovery input. It has lifecycle
 * evidence for every contribution, unlike the normalized Action catalog; using
 * that catalog here would create a second reference registry with different
 * currentness rules.
 */
type CurrentComposerReference = Readonly<{
    reference: PluginContributionIdentityV1;
    presentation: PluginContributionIntrospectionPresentationV1;
}>;

function listCurrentComposerReferences(
    projection: PluginProjectionV2,
): readonly CurrentComposerReference[] {
    const expectedGeneration = String(projection.generation);
    const seen = new Set<string>();
    const references: CurrentComposerReference[] = [];
    for (const record of projection.contributionIntrospection?.contributions ?? []) {
        const presentation = record.presentation;
        if (
            record.contribution.kind !== 'localId'
            || record.contribution.family !== 'composerReferences'
            || record.registration.state !== 'bound'
            || record.activation.state !== 'active'
            || record.registration.generation !== expectedGeneration
            || record.activation.generation !== expectedGeneration
            || !presentation
            || presentation.kind !== 'composerReference'
        ) {
            continue;
        }
        const reference = {
            pluginId: record.contribution.pluginId,
            localId: record.contribution.localId,
        };
        const identity = `${reference.pluginId}\u0000${reference.localId}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        references.push({ reference, presentation });
    }
    return references;
}

function sameComposerReference(
    left: PluginContributionIdentityV1,
    right: PluginContributionIdentityV1,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function composerReferenceDescription(params: Readonly<{
    reference: PluginContributionIdentityV1;
    providerDescription: string | undefined;
    candidateDescription: string | undefined;
}>): string {
    const qualifiedReference = `${params.reference.pluginId}/${params.reference.localId}`;
    return [
        params.providerDescription,
        params.candidateDescription,
        qualifiedReference,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
}

function readPluginLocalizedText(value: PluginLocalizedStringV2): string {
    return typeof value === 'string' ? value : value.fallback;
}

function collectComposerReferenceRows(
    rowsByReference: readonly (readonly AutocompleteSuggestion[] | null)[],
    limit: number,
): AutocompleteSuggestion[] {
    const rows: AutocompleteSuggestion[] = [];
    for (const contributionRows of rowsByReference) {
        if (!contributionRows) continue;
        for (const row of contributionRows) {
            if (rows.length >= limit) return rows;
            rows.push(row);
        }
    }
    return rows;
}

function buildComposerReferenceRows(params: Readonly<{
    contribution: CurrentComposerReference;
    page: readonly Readonly<{ id: string; label: string; description?: string }>[];
    trigger: ComposerSuggestionTrigger;
    limit: number;
}>): readonly AutocompleteSuggestion[] {
    const { contribution } = params;
    const providerDescription = contribution.presentation.description === undefined
        ? undefined
        : readPluginLocalizedText(contribution.presentation.description);
    const rows: AutocompleteSuggestion[] = [];
    for (const candidate of params.page) {
        if (rows.length >= params.limit) break;
        rows.push({
            kind: 'composerReference',
            key: `composer-reference-${JSON.stringify([
                contribution.reference.pluginId,
                contribution.reference.localId,
                candidate.id,
            ])}`,
            text: formatComposerSuggestionToken(params.trigger, candidate.label),
            label: candidate.label,
            group: readPluginLocalizedText(contribution.presentation.title),
            icon: React.createElement(Icon, {
                name: resolvePluginUiIconName(contribution.presentation.icon),
                size: 16,
            }),
            description: composerReferenceDescription({
                reference: contribution.reference,
                providerDescription,
                candidateDescription: candidate.description,
            }),
            structuredInput: buildComposerReferenceMentionPayloadV1({
                reference: contribution.reference,
                candidate,
            }),
        });
    }
    return rows;
}

/**
 * Resolves candidates through the single daemon reference search RPC. Selection
 * stores only Protocol's qualified reference/candidate identity; it deliberately
 * does not resolve context in the UI, where a picker result could outlive the
 * daemon generation that produced it.
 */
async function resolveComposerReferenceSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const host = context.composerReferenceHost;
    const machineId = host?.machineId.trim();
    if (
        !host
        || !machineId
        || context.signal?.aborted
        || !isComposerReferenceHostCurrent(host)
    ) {
        return [];
    }

    const references = listCurrentComposerReferences(host.projection).filter((contribution) => (
        contribution.presentation.triggers.includes(context.trigger)
    ));
    if (references.length === 0) return [];

    const expectedGeneration = String(host.projection.generation);
    const rowsByReference: Array<readonly AutocompleteSuggestion[] | null> = references.map(() => null);
    const publishCurrentRows = () => {
        if (context.signal?.aborted || !isComposerReferenceHostCurrent(host)) return;
        context.publish?.(collectComposerReferenceRows(rowsByReference, context.limit));
    };
    const results = await Promise.allSettled(references.map(async (contribution, index) => {
        const { reference } = contribution;
        if (context.signal?.aborted || !isComposerReferenceHostCurrent(host)) return null;
        const raw = await machineRpcWithServerScope<unknown, Readonly<{
            machineId: string;
            expectedGeneration: string;
            reference: PluginContributionIdentityV1;
            trigger: ComposerSuggestionTrigger;
            query: string;
        }>>({
            machineId,
            ...(host.serverId ? { serverId: host.serverId } : {}),
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: {
                machineId,
                expectedGeneration,
                reference,
                trigger: context.trigger,
                query: context.scopedQuery,
            },
            signal: context.signal,
        });
        if (context.signal?.aborted || !isComposerReferenceHostCurrent(host)) return null;

        const response = DaemonPluginComposerReferenceSearchResponseSchema.safeParse(raw);
        if (
            !response.success
            || !response.data.ok
            || !sameComposerReference(response.data.reference, reference)
        ) {
            return null;
        }
        const rows = buildComposerReferenceRows({
            contribution,
            page: response.data.page,
            trigger: context.trigger,
            limit: context.limit,
        });
        if (context.signal?.aborted || !isComposerReferenceHostCurrent(host)) return null;
        rowsByReference[index] = rows;
        publishCurrentRows();
        return rows;
    }));
    if (context.signal?.aborted || !isComposerReferenceHostCurrent(host)) return [];

    let firstFailure: unknown;
    for (const result of results) {
        if (result.status === 'rejected') {
            firstFailure ??= result.reason;
        }
    }
    const out = collectComposerReferenceRows(rowsByReference, context.limit);
    // A successful reference contribution still renders when another failed. If every
    // contribution rejected, retain the dispatcher's existing diagnostic contract
    // rather than making transport and "no candidates" indistinguishable.
    if (out.length === 0 && firstFailure !== undefined) throw firstFailure;
    return out;
}

async function resolveSkillSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const skill of context.catalogs.skills ?? []) {
        if (out.length >= context.limit) break;
        if (skill.enabled === false) continue;
        const { identity, suggestionKey } = resolveComposerSuggestionSkillIdentity(skill);
        if (seen.has(identity)) continue;
        const label = skill.displayName ?? skill.name;
        const subtitle = skill.description
            ?? skill.origin
            ?? skill.source
            ?? skill.projectionRef
            ?? skill.projectionKind
            ?? skill.name;
        if (
            !matchesComposerSuggestionQuery(skill.name, context.scopedQuery)
            && !matchesComposerSuggestionQuery(label, context.scopedQuery)
        ) continue;
        seen.add(identity);
        out.push({
            kind: 'skill',
            key: `skill-${suggestionKey}`,
            text: formatComposerSuggestionToken('$', skill.name),
            label,
            description: subtitle,
            structuredInput: {
                kind: 'skill',
                ...(skill.id ? { id: skill.id } : {}),
                name: skill.name,
                ...(skill.path ? { path: skill.path } : {}),
                ...(skill.displayName ? { displayName: skill.displayName } : {}),
                ...(skill.description ? { description: skill.description } : {}),
                ...(skill.origin ?? skill.source ? { origin: skill.origin ?? skill.source } : {}),
                ...(skill.projectionKind ? { projectionKind: skill.projectionKind } : {}),
                ...(skill.projectionRef ?? skill.projectionKind
                    ? { projectionRef: skill.projectionRef ?? skill.projectionKind }
                    : {}),
                ...(skill.backendId ? { backendId: skill.backendId } : {}),
                ...(skill.agentId ? { agentId: skill.agentId } : {}),
            },
        });
    }
    return out;
}

async function resolveSlashCommandSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    return await getCommandSuggestions(context.sessionId, context.scopedQuery, {
        limit: context.limit,
        contributedActions: context.contributedActions,
    });
}

/**
 * A prompt-template slash command replaces the ENTIRE composer input with the
 * expanded template, so it cannot be expressed as a token string (D-20). This
 * used to be duplicated byte-for-byte in `SessionView` and
 * `useNewSessionScreenModel`; the kind owns it now.
 */
async function applySlashCommandSelection(
    args: ComposerSuggestionApplySelectionArgs,
): Promise<ComposerSuggestionSelectionResult> {
    const action = args.suggestion.pluginContributedAction;
    if (action) {
        if (!args.onContributedActionSuggestionSelect) return { handled: false };
        const outcome = await args.onContributedActionSuggestionSelect(action);
        if (outcome.kind === 'stale' || outcome.kind === 'unavailable') {
            // The host has already presented generic feedback for these typed
            // outcomes. Keep the user's original slash token so it can be
            // retried after the current catalog is restored.
            return { handled: false, preserveInput: true };
        }
        const start = args.activeWord?.offset ?? args.selection.start;
        const end = args.activeWord?.endOffset ?? args.selection.end;
        return {
            handled: true,
            text: args.inputText.slice(0, start) + args.inputText.slice(end),
            cursorPosition: start,
        };
    }
    if (!args.suggestion.promptInvocation) return { handled: false };
    const result = await resolvePromptInvocationAutocompleteSelection({
        input: args.inputText,
        selection: args.selection,
        activeWord: args.activeWord ?? undefined,
        suggestion: args.suggestion,
    });
    return result.handled && typeof result.text === 'string' && typeof result.cursorPosition === 'number'
        ? { handled: true, text: result.text, cursorPosition: result.cursorPosition }
        : { handled: false };
}

/**
 * Per-trigger row budget (D-22).
 *
 * `CommandMenu` renders its sections with `virtualization: 'never'`, so the sum
 * of the limits a single trigger can produce is the real ceiling on mounted rows.
 * A global `slice(0, 40)` is forbidden: it would let an earlier section starve a
 * later one, which is INV-2 again by another route. `suggestions.sectioned.test.ts`
 * enforces the bound per trigger.
 */
export const COMPOSER_SUGGESTION_TRIGGER_ROW_BUDGET = 40;

const COMPOSER_SUGGESTION_KIND_DEFINITIONS = {
    file: {
        id: 'file',
        limit: 12,
        sectionTitleKey: 'agentInput.suggestionGroups.files',
        resolve: resolveFileSuggestions,
    },
    vendorPlugin: {
        id: 'vendorPlugin',
        scopes: ['plugin', 'plugins'],
        catalog: 'vendorPlugins',
        limit: 12,
        sectionTitleKey: 'agentInput.suggestionGroups.plugins',
        icon: () => React.createElement(Icon, { name: 'puzzle-piece', size: 16 }),
        resolve: resolveVendorPluginSuggestions,
    },
    session: {
        id: 'session',
        scopes: [SESSION_SUGGESTION_SCOPE],
        limit: 8,
        sectionTitleKey: 'agentInput.suggestionGroups.sessions',
        // The fallback only. Rows normally carry their session's provider logo; this is
        // what a session whose flavor names no known provider falls back to.
        icon: () => React.createElement(Icon, { name: 'chat-circle', size: 16 }),
        resolve: resolveSessionSuggestions,
    },
    composerReference: {
        id: 'composerReference',
        // Built-in @ kinds consume 32 rows; keep the external reference bounded to
        // the remaining eight so the mounted picker ceiling stays 40 (D-22).
        limit: 8,
        sectionTitleKey: 'agentInput.suggestionGroups.references',
        icon: () => React.createElement(Icon, { name: 'link', size: 16 }),
        resolve: resolveComposerReferenceSuggestions,
    },
    skill: {
        id: 'skill',
        catalog: 'skills',
        limit: 12,
        sectionTitleKey: 'agentInput.suggestionGroups.skills',
        icon: () => React.createElement(Icon, { name: 'sparkle', size: 16 }),
        resolve: resolveSkillSuggestions,
    },
    slashCommand: {
        id: 'slashCommand',
        limit: 8,
        sectionTitleKey: 'agentInput.suggestionGroups.commands',
        resolve: resolveSlashCommandSuggestions,
        applySelection: applySlashCommandSelection,
    },
} as const satisfies Record<ComposerSuggestionKindId, ComposerSuggestionKindDefinition>;

export function resolveComposerSuggestionKind(
    id: ComposerSuggestionKindId,
): ComposerSuggestionKindDefinition {
    return COMPOSER_SUGGESTION_KIND_DEFINITIONS[id];
}

/** The eligible kind definitions a host offers for one trigger, in declaration order. */
export function resolveComposerSuggestionKindsForTrigger(
    kinds: readonly ComposerSuggestionKindId[],
    trigger: ComposerSuggestionTrigger,
): readonly ComposerSuggestionKindDefinition[] {
    return resolveComposerSuggestionKindIdsForTrigger(kinds, trigger).map(resolveComposerSuggestionKind);
}

/**
 * Matches a scope alias at the head of a query (`plugin:foo` -> plugin, `foo`).
 * A scope alias narrows the trigger to exactly one kind by explicit user intent;
 * it is not the implicit heuristic suppression INV-2 forbids.
 */
export function resolveComposerSuggestionScope(
    trigger: ComposerSuggestionTrigger,
    query: string,
): Readonly<{ scope: string | null; scopedQuery: string; kind: ComposerSuggestionKindId | null }> {
    for (const id of COMPOSER_SUGGESTION_KIND_IDS) {
        if (!resolveComposerSuggestionTriggersForKind(id).includes(trigger)) continue;
        const scopes = resolveComposerSuggestionKind(id).scopes;
        if (!scopes) continue;
        for (const scope of scopes) {
            const prefix = `${scope}:`;
            if (query.startsWith(prefix)) {
                return { scope, scopedQuery: query.slice(prefix.length), kind: id };
            }
        }
    }
    return { scope: null, scopedQuery: query, kind: null };
}
