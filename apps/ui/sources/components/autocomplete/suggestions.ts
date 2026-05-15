import {
    COMMAND_SUGGESTION_ROW_HEIGHT,
    FileMentionSuggestion,
} from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import * as React from 'react';
import { searchFiles, FileItem } from '@/sync/domains/input/suggestionFile';
import { searchCommands, CommandItem } from '@/sync/domains/input/suggestionCommands';
import type { PromptInvocationSuggestionMetadata } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';

export async function getCommandSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    label: string;
    description?: string;
    rowHeight?: number;
    promptInvocation?: PromptInvocationSuggestionMetadata;
}[]> {
    // Remove the "/" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the command search cache with fuzzy matching
        const commands = await searchCommands(sessionId, searchTerm, { limit: 8 });

        // Convert CommandItem to suggestion format
        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            label: `/${cmd.command}`,
            description: cmd.description,
            rowHeight: COMMAND_SUGGESTION_ROW_HEIGHT,
            promptInvocation: cmd.promptInvocation,
        }));
    } catch {
        return [];
    }
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
    rowHeight?: number;
}[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the file search cache with fuzzy matching
        const files = await searchFiles(sessionId, searchTerm, { limit: 12 });

        // Convert FileItem to suggestion format
        return files.map((file: FileItem) => ({
            key: `file-${file.fullPath}`,
            text: `@${file.fullPath}`,  // Full path in the mention
            component: () => React.createElement(FileMentionSuggestion, {
                fileName: file.fileName,
                filePath: file.filePath,
                fileType: file.fileType,
            }),
        }));
    } catch {
        return [];
    }
}

export async function getSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    label?: string;
    description?: string;
    component?: React.ComponentType;
    rowHeight?: number;
    promptInvocation?: PromptInvocationSuggestionMetadata;
}[]> {
    if (!query || query.length === 0) {
        return [];
    }
    
    // Check if it's a command (starts with /)
    if (query.startsWith('/')) {
        return await getCommandSuggestions(sessionId, query);
    }
    
    // Check if it's a file mention (starts with @)
    if (query.startsWith('@')) {
        return await getFileMentionSuggestions(sessionId, query);
    }
    
    // No suggestions for other queries
    return [];
}
