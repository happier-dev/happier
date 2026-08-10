import * as React from 'react';

import { FileMentionSuggestion } from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import { Icon } from '@/components/ui/icons/Icon';
import type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';
import { searchFiles, type FileItem } from '@/sync/domains/input/suggestionFile';
import {
    buildComposerSessionTokenSlug,
    readComposerSessionSuggestionItems,
} from '@/sync/domains/input/suggestionSession';
import { resolvePromptInvocationAutocompleteSelection } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import type { TranslationKeyNoParams } from '@/text';

import type { AutocompleteSuggestion } from './autocompleteTypes';
import { getCommandSuggestions } from './commandSuggestions';
import {
    matchesComposerSuggestionQuery,
    type ComposerSuggestionCatalogs,
} from './composerSuggestionCatalogs';
import {
    COMPOSER_SUGGESTION_KIND_IDS,
    formatComposerSuggestionToken,
    resolveComposerSuggestionKindIdsForTrigger,
    resolveComposerSuggestionTrigger,
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
 * same mechanism). Measured on an iOS dev client, the chunk behind
 * `suggestionFile` is 68 MB and the request never completed: the `file` kind never
 * settled, so typing `@` showed nothing, and `applySelection`'s load never settled
 * either, so tapping a prompt-template row did nothing. `/` kept working only
 * because its resolver was already a static import. Deferring a module load here
 * buys a deferred initialization inside one bundle and costs the whole feature on
 * the platform users run; pinned by `composerSuggestionKinds.moduleLoad.native.test.ts`.
 */

export type { ComposerSuggestionKindId } from './composerSuggestionGrammar';

/** Which session catalog snapshot a kind reads, if any. */
export type ComposerSuggestionCatalogKey = 'vendorPlugins' | 'skills';

export type ComposerSuggestionResolveContext = Readonly<{
    /**
     * The session whose *published* state this composer reads: its command list, its plugin
     * and skill catalogs, and which session the `@session` picker must exclude.
     *
     * `null` before the session exists. That is not a degraded case — it is the honest answer,
     * and the kinds that need a session simply contribute nothing. It replaces a
     * `'__new_session__'` sentinel that was threaded through session-addressed APIs to fake one.
     */
    sessionId: string | null;
    /**
     * The machine and folder this composer's file search is addressed to.
     *
     * Files are not session state, they are workspace state, so this is what scopes them —
     * for an existing session (which resolves its own machine and folder) and for the
     * new-session composer (which has the user's chosen machine and directory) alike. There is
     * no host-specific branch: a host with no folder yet passes `null`.
     */
    workspace: FileSuggestionScope | null;
    /**
     * The server this composer targets, when the host has no session to derive it from.
     *
     * Only the new-session composer sets it: it declares the server its session will spawn on.
     * Every other host leaves it `null` and the current session's server is used. It is not a
     * duplicate of `workspace.serverId`: this one answers "whose sessions are referenceable",
     * that one is part of a machine address.
     */
    serverId: string | null;
    /** Token query with the trigger stripped and any quoted span unquoted. */
    query: string;
    /** `query` with a matched scope alias removed (`@plugin:foo` -> `foo`). */
    scopedQuery: string;
    /** The scope alias matched in the token, or null. */
    scope: string | null;
    catalogs: ComposerSuggestionCatalogs;
    limit: number;
}>;

export type ComposerSuggestionSelectionResult =
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; text: string; cursorPosition: number }>;

export type ComposerSuggestionApplySelectionArgs = Readonly<{
    suggestion: AutocompleteSuggestion;
    inputText: string;
    selection: Readonly<{ start: number; end: number }>;
    activeWord: Readonly<{ offset: number; endOffset: number }> | null;
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
    // No folder chosen yet, so there is nothing to search. This is the ONLY thing that
    // decides whether files are offered — not which host is asking. A session composer and
    // the new-session composer reach this line through exactly the same path.
    if (!context.workspace) return [];
    // Failures propagate. A `catch { return [] }` here used to make a failed import,
    // a rejected file-search RPC and a genuinely empty result the SAME observable
    // outcome — an empty picker with no diagnostic anywhere. The dispatcher already
    // turns a rejected kind into "no rows plus one diagnostic" (D-25), which is the
    // single place that decision belongs.
    const files = await searchFiles(context.workspace, context.scopedQuery, { limit: context.limit });
    return files.map(buildFileSuggestion);
}

async function resolveVendorPluginSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const plugin of context.catalogs.vendorPlugins ?? []) {
        if (out.length >= context.limit) break;
        if (plugin.installed === false || plugin.enabled === false) continue;
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

async function resolveSkillSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const seen = new Set<string>();
    const out: AutocompleteSuggestion[] = [];
    for (const skill of context.catalogs.skills ?? []) {
        if (out.length >= context.limit) break;
        if (skill.enabled === false) continue;
        const key = skill.name.trim().toLowerCase();
        if (seen.has(key)) continue;
        const label = skill.displayName ?? skill.name;
        // Same precedence the deleted bespoke row used, so consolidation is not a
        // silent copy change.
        const subtitle = skill.description ?? skill.origin ?? skill.source ?? skill.projectionKind ?? skill.name;
        if (
            !matchesComposerSuggestionQuery(skill.name, context.scopedQuery)
            && !matchesComposerSuggestionQuery(label, context.scopedQuery)
        ) continue;
        seen.add(key);
        out.push({
            kind: 'skill',
            key: `skill-${skill.name}`,
            text: formatComposerSuggestionToken('$', skill.name),
            label,
            description: subtitle,
            structuredInput: {
                kind: 'skill',
                // The identity tuple (`id`, `origin`, `backendId`, `projectionRef`) travels with
                // the mention so the envelope writer can derive the canonical `happier.skill`
                // reference — and so a restored draft derives the SAME one.
                ...(skill.id ? { id: skill.id } : {}),
                name: skill.name,
                ...(skill.path ? { path: skill.path } : {}),
                ...(skill.displayName ? { displayName: skill.displayName } : {}),
                ...(skill.description ? { description: skill.description } : {}),
                ...(skill.origin ?? skill.source ? { origin: skill.origin ?? skill.source } : {}),
                ...(skill.projectionKind ? { projectionKind: skill.projectionKind } : {}),
                ...(skill.projectionRef ? { projectionRef: skill.projectionRef } : {}),
                ...(skill.backendId ? { backendId: skill.backendId } : {}),
                ...(skill.agentId ? { agentId: skill.agentId } : {}),
            },
        });
    }
    return out;
}

/**
 * The scope alias that narrows `@` to sessions, and the head of the token the picker inserts.
 * Declared once so the inserted token always re-parses to the kind that produced it (INV-3).
 */
const SESSION_SUGGESTION_SCOPE = 'session';

async function resolveSessionSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    const out: AutocompleteSuggestion[] = [];
    // Unlike files, plugins and skills, the session list is NOT session state — it is an
    // account/server-level projection. So this kind is the one reference kind a host with no
    // session can still offer: it needs a server, not a session. `currentSessionId` is only the
    // exclusion, and with no session there is simply nothing to exclude.
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
        ) continue;
        out.push({
            kind: 'session',
            key: `session-${item.id}`,
            text: formatComposerSuggestionToken('@', `${SESSION_SUGGESTION_SCOPE}:${slug}`),
            label: item.title,
            description: item.workspaceLabel ?? item.agentLabel ?? item.id,
            structuredInput: {
                kind: 'session',
                sessionId: item.id,
                label: item.title,
            },
        });
    }
    return out;
}

async function resolveSlashCommandSuggestions(
    context: ComposerSuggestionResolveContext,
): Promise<readonly AutocompleteSuggestion[]> {
    return await getCommandSuggestions(context.sessionId, context.scopedQuery, { limit: context.limit });
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
    if (!args.suggestion.promptInvocation) return { handled: false };
    return await resolvePromptInvocationAutocompleteSelection({
        promptInvocation: args.suggestion.promptInvocation,
        inputText: args.inputText,
        selection: args.selection,
        activeWord: args.activeWord,
    });
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
        icon: () => React.createElement(Icon, { name: 'chat-circle', size: 16 }),
        resolve: resolveSessionSuggestions,
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
        if (resolveComposerSuggestionTrigger(id) !== trigger) continue;
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
