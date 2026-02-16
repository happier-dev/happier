/**
 * Suggestion commands functionality for slash commands
 * Reads commands directly from session metadata storage
 */

import Fuse from 'fuse.js';
import { listActionSpecs } from '@happier-dev/protocol';
import { storage } from '../state/storage';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

export interface CommandItem {
    command: string;        // The command without slash (e.g., "compact")
    description?: string;   // Optional description of what the command does
}

interface SearchOptions {
    limit?: number;
    threshold?: number;
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
    { command: 'clear', description: 'Clear the conversation' }
];

function describeActionSlashToken(token: string, fallbackTitle: string): string {
    if (token === '/h.review') return 'Start a code review run';
    if (token === '/h.plan') return 'Start a planning run';
    if (token === '/h.delegate') return 'Start a delegation run';
    if (token === '/h.voice') return 'Start a voice agent run';
    if (token === '/h.runs') return 'List execution runs';
    if (token === '/h.voice.reset') return 'Reset the global voice agent';
    return fallbackTitle;
}

function buildActionSlashCommands(state: any): CommandItem[] {
    const out: CommandItem[] = [];
    for (const spec of listActionSpecs()) {
        if (spec.surfaces.ui_slash_command !== true) continue;
        if (!isActionEnabledInState(state as any, spec.id, { surface: 'ui_slash_command', placement: 'slash_command' } as any)) continue;
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

// Get commands from session metadata
function getCommandsFromSession(sessionId: string): CommandItem[] {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    const commands: CommandItem[] = [...buildActionSlashCommands(state), ...DEFAULT_COMMANDS];
    if (!session || !session.metadata) {
        return commands;
    }

    // Prefer richer metadata when available
    const details = (session.metadata as any).slashCommandDetails as Array<{ command?: unknown; description?: unknown }> | undefined;
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
        return commands;
    }

    // Fallback: commands from metadata.slashCommands (filter with ignore list)
    if (session.metadata.slashCommands) {
        for (const cmd of session.metadata.slashCommands) {
            if (IGNORED_COMMANDS.includes(cmd)) continue;
            if (commands.find(c => c.command === cmd)) continue;
            commands.push({
                command: cmd,
                description: COMMAND_DESCRIPTIONS[cmd]
            });
        }
    }
    
    return commands;
}

// Main export: search commands with fuzzy matching
export async function searchCommands(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
): Promise<CommandItem[]> {
    const { limit = 10, threshold = 0.3 } = options;
    
    // Get commands from session metadata (no caching)
    const commands = getCommandsFromSession(sessionId);
    
    // If query is empty, return all commands
    if (!query || query.trim().length === 0) {
        return commands.slice(0, limit);
    }
    
    // Setup Fuse for fuzzy search
    const fuseOptions = {
        keys: [
            { name: 'command', weight: 0.7 },
            { name: 'description', weight: 0.3 }
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
export function getAllCommands(sessionId: string): CommandItem[] {
    return getCommandsFromSession(sessionId);
}
