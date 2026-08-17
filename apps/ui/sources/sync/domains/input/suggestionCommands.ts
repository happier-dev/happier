/**
 * Suggestion commands functionality for slash commands
 * Reads commands directly from session metadata storage
 */

import Fuse from 'fuse.js';
import { listActionSpecs } from '@happier-dev/protocol';
import { storage } from '../state/storage';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { t } from '@/text';
import { BUILT_IN_PROMPTS } from './slashCommands/builtInPrompts';
import type { PromptInvocationSuggestionMetadata } from './slashCommands/promptInvocationSuggestion';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';

export interface CommandItem {
    /** Stable source-local row identity; command text alone is not unique for qualified Action aliases. */
    key?: string;
    command: string;        // The command without slash (e.g., "compact")
    description?: string;   // Optional description of what the command does
    /** Search-only aliases that must not change a collision row's displayed spelling. */
    searchTerms?: readonly string[];
    promptInvocation?: PromptInvocationSuggestionMetadata;
    /** Controller-admitted Action carried through the incumbent slash picker. */
    pluginContributedAction?: PluginContributedActionDescriptor;
}

export interface SearchOptions {
    limit?: number;
    threshold?: number;
    /** Current session composer Action descriptors, owned and filtered by its controller. */
    contributedActions?: readonly PluginContributedActionDescriptor[];
}

// Commands to ignore/filter out
export const IGNORED_COMMANDS = [
    "add-dir",
    "agents",
    "config",
    "statusline",
    "bashes",
    "settings",
    "cost",
    "doctor",
    "exit",
    "help",
    "ide",
    "init",
    "install-github-app",
    "mcp",
    "memory",
    "migrate-installer",
    "model",
    "pr-comments",
    "release-notes",
    "resume",
    "status",
    "bug",
    "review",
    "security-review",
    "terminal-setup",
    "upgrade",
    "vim",
    "permissions",
    "hooks",
    "export",
    "logout",
    "login"
];

// Default commands always available
const DEFAULT_COMMANDS: CommandItem[] = [
    { command: 'compact', description: 'Compact the conversation history' },
    { command: 'clear', description: 'Clear the conversation' },
    { command: 'goal', description: t('session.workState.commandDescription') },
];

function describeActionSlashToken(token: string, fallbackTitle: string): string {
    if (token === '/h.review') return 'Start a code review run';
    if (token === '/h.plan') return 'Start a planning run';
    if (token === '/h.delegate') return 'Start a delegation run';
    if (token === '/h.voice') return 'Start a voice agent run';
    if (token === '/h.runs') return 'List execution runs';
    if (token === '/h.voice.reset') return 'Reset the global voice agent';
    if (token === '/pet' || token === '/h.pet') return t('commandPalette.pets.chooseSubtitle');
    return fallbackTitle;
}

function buildActionSlashCommands(state: any): CommandItem[] {
    const out: CommandItem[] = [];
    for (const spec of listActionSpecs()) {
        if (spec.surfaces.ui !== true) continue;
        if (!isActionEnabledInState(state as any, spec.id, { surface: 'ui', placement: 'slash_command' } as any)) continue;
        const tokens = spec.slash?.tokens ?? [];
        for (const token of tokens) {
            if (typeof token !== 'string') continue;
            if (!token.startsWith('/')) continue;
            const command = token.slice(1);
            if (command.trim().length === 0) continue;
            if (out.find((c) => c.command === command)) continue;
            out.push({
                command,
                description: describeActionSlashToken(token, spec.title),
            });
        }
    }
    return out;
}

function buildPromptInvocationSlashCommands(state: any): CommandItem[] {
    const out: CommandItem[] = [];

    const entries = (state as any)?.settings?.promptInvocationsV1?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return out;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const invocationId = typeof (entry as any).id === 'string' ? String((entry as any).id) : '';
        if (invocationId.trim().length === 0) continue;

        const token = typeof (entry as any).token === 'string' ? String((entry as any).token) : '';
        if (!token.startsWith('/')) continue;

        const target = (entry as any).target;
        const targetArtifactId = target && typeof target === 'object' && typeof target.artifactId === 'string'
            ? String(target.artifactId)
            : '';
        if (targetArtifactId.trim().length === 0) continue;

        const availableIn = typeof (entry as any).availableIn === 'string' ? String((entry as any).availableIn) : 'global';
        if (availableIn !== 'global') continue;

        const command = token.slice(1);
        if (command.trim().length === 0) continue;

        const title = typeof (entry as any).title === 'string' ? String((entry as any).title) : '';
        const rawBehavior = typeof (entry as any).behavior === 'string' ? String((entry as any).behavior) : '';
        const behavior = rawBehavior === 'insert_and_send' || rawBehavior === 'insert_on_send'
            ? rawBehavior
            : 'insert';
        out.push({
            command,
            description: title.trim().length > 0 ? title : undefined,
            promptInvocation: {
                invocationId,
                token,
                targetArtifactId,
                behavior,
                allowArgs: (entry as any).allowArgs === true,
            },
        });
    }

    return out;
}

function buildBuiltInPromptSlashCommands(): CommandItem[] {
    return BUILT_IN_PROMPTS.map((prompt) => ({
        command: prompt.token.startsWith('/') ? prompt.token.slice(1) : prompt.token,
        description: prompt.title,
    })).filter((command) => command.command.trim().length > 0);
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Adds controller-admitted external Actions to the incumbent multi-source slash
 * catalog. Native and prompt commands retain their raw token and behavior; an
 * Action never wins a registration-order collision, so its row uses the stable
 * qualified Action spelling instead.
 */
function buildContributedActionSlashCommands(
    existingCommands: readonly CommandItem[],
    contributedActions: readonly PluginContributedActionDescriptor[],
): CommandItem[] {
    const nativeCommands = new Set(existingCommands.map((command) => command.command));
    const candidates: Array<Readonly<{
        action: PluginContributedActionDescriptor;
        token: string;
        rawCommand: string;
    }>> = [];
    for (const action of contributedActions) {
        for (const token of action.slash?.tokens ?? []) {
            if (!token.startsWith('/') || token.length <= 1) continue;
            candidates.push({ action, token, rawCommand: token.slice(1) });
        }
    }
    candidates.sort((left, right) => (
        compareStrings(left.action.qualifiedActionId, right.action.qualifiedActionId)
        || compareStrings(left.token, right.token)
    ));
    const candidateCounts = new Map<string, number>();
    for (const candidate of candidates) {
        candidateCounts.set(
            candidate.rawCommand,
            (candidateCounts.get(candidate.rawCommand) ?? 0) + 1,
        );
    }
    const collidingActionIdentities = new Set<string>();
    for (const candidate of candidates) {
        const actionIdentity = `${candidate.action.identity.pluginId}\u0000${candidate.action.identity.localId}`;
        if (
            nativeCommands.has(candidate.rawCommand)
            || (candidateCounts.get(candidate.rawCommand) ?? 0) > 1
        ) {
            collidingActionIdentities.add(actionIdentity);
        }
    }

    const rowsByActionIdentity = new Map<string, {
        action: PluginContributedActionDescriptor;
        command: string;
        rawCommands: string[];
    }>();
    for (const candidate of candidates) {
        const actionIdentity = `${candidate.action.identity.pluginId}\u0000${candidate.action.identity.localId}`;
        const command = collidingActionIdentities.has(actionIdentity)
            ? candidate.action.qualifiedActionId
            : candidate.rawCommand;
        const existing = rowsByActionIdentity.get(actionIdentity);
        if (existing) {
            if (!existing.rawCommands.includes(candidate.rawCommand)) {
                existing.rawCommands.push(candidate.rawCommand);
            }
            continue;
        }
        rowsByActionIdentity.set(actionIdentity, {
            action: candidate.action,
            command,
            rawCommands: [candidate.rawCommand],
        });
    }

    return [...rowsByActionIdentity.values()].map((row) => {
        const baseDescription = row.action.description ?? row.action.title;
        return {
            key: `plugin-action:${row.action.qualifiedActionId}`,
            command: row.command,
            ...(baseDescription ? { description: baseDescription } : {}),
            searchTerms: [...row.rawCommands, row.action.qualifiedActionId],
            pluginContributedAction: row.action,
        };
    });
}

// Command descriptions for known tools/commands
const COMMAND_DESCRIPTIONS: Record<string, string> = {
    // Default commands
    compact: 'Compact the conversation history',
    
    // Common tool commands
    help: 'Show available commands',
    clear: 'Clear the conversation',
    reset: 'Reset the session',
    export: 'Export conversation',
    debug: 'Show debug information',
    status: 'Show connection status',
    stop: 'Stop current operation',
    abort: 'Abort current operation',
    cancel: 'Cancel current operation',
    
    // Add more descriptions as needed
};

// Get commands from session metadata.
// `sessionId` is null before a session exists (the new-session composer): action, built-in and
// default commands plus prompt templates are all still available, and only the session-published
// commands are absent — which is the truth, not a degraded case.
function getCommandsFromSession(
    sessionId: string | null,
    contributedActions: readonly PluginContributedActionDescriptor[] = [],
): CommandItem[] {
    const state = storage.getState();
    const session = sessionId ? state.sessions?.[sessionId] : undefined;
    const commands: CommandItem[] = [
        ...buildActionSlashCommands(state),
        ...buildBuiltInPromptSlashCommands(),
        ...DEFAULT_COMMANDS,
    ];

    // Add prompt template tokens (never overriding action/default commands).
    for (const invocation of buildPromptInvocationSlashCommands(state)) {
        if (commands.find((c) => c.command === invocation.command)) continue;
        commands.push(invocation);
    }
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    if (metadata) {
        // Prefer richer metadata when available.
        const details = (metadata as any).slashCommandDetails as Array<{ command?: unknown; description?: unknown }> | undefined;
        if (Array.isArray(details) && details.length > 0) {
            for (const d of details) {
                const cmd = typeof d.command === 'string' ? d.command : null;
                if (!cmd) continue;
                if (IGNORED_COMMANDS.includes(cmd)) continue;
                if (commands.find(c => c.command === cmd)) continue;
                commands.push({
                    command: cmd,
                    description: typeof d.description === 'string' && d.description.trim().length > 0
                        ? d.description
                        : COMMAND_DESCRIPTIONS[cmd]
                });
            }
        } else if (metadata.slashCommands) {
            // Fallback: commands from metadata.slashCommands (filter with ignore list).
            for (const cmd of metadata.slashCommands) {
                if (IGNORED_COMMANDS.includes(cmd)) continue;
                if (commands.find(c => c.command === cmd)) continue;
                commands.push({
                    command: cmd,
                    description: COMMAND_DESCRIPTIONS[cmd]
                });
            }
        }
    }

    return [...commands, ...buildContributedActionSlashCommands(commands, contributedActions)];
}

// Main export: search commands with fuzzy matching
export async function searchCommands(
    sessionId: string | null,
    query: string,
    options: SearchOptions = {}
): Promise<CommandItem[]> {
    const { limit = 10, threshold = 0.3, contributedActions = [] } = options;
    
    // Get commands from session metadata (no caching)
    const commands = getCommandsFromSession(sessionId, contributedActions);
    
    // If query is empty, return all commands
    if (!query || query.trim().length === 0) {
        return commands.slice(0, limit);
    }
    
    // Setup Fuse for fuzzy search
    const fuseOptions = {
        keys: [
            { name: 'command', weight: 0.6 },
            { name: 'description', weight: 0.2 },
            { name: 'searchTerms', weight: 0.2 },
        ],
        threshold,
        includeScore: true,
        shouldSort: true,
        minMatchCharLength: 1,
        ignoreLocation: true,
        useExtendedSearch: true
    };
    
    const fuse = new Fuse(commands, fuseOptions);
    const results = fuse.search(query, { limit });
    
    return results.map(result => result.item);
}

// Get all available commands for a session
export function getAllCommands(sessionId: string | null, options: Pick<SearchOptions, 'contributedActions'> = {}): CommandItem[] {
    return getCommandsFromSession(sessionId, options.contributedActions);
}
