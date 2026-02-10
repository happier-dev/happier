import { CommandSuggestion, FileMentionSuggestion } from '@/components/sessions/agentInput/components/AgentInputSuggestionView';
import * as React from 'react';
import { searchFiles, FileItem } from '@/sync/domains/input/suggestionFile';
import { searchCommands, CommandItem } from '@/sync/domains/input/suggestionCommands';

export async function getCommandSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
}[]> {
    // Remove the "/" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the command search cache with fuzzy matching
        const commands = await searchCommands(sessionId, searchTerm, { limit: 5 });
        
        // Convert CommandItem to suggestion format
        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            component: () => React.createElement(CommandSuggestion, {
                command: cmd.command,
                description: cmd.description
            })
        }));
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.error('Error fetching command suggestions:', error);
        }
        // Return empty array on error
        return [];
    }
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
}[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);
    
    try {
        // Use the file search cache with fuzzy matching
        const files = await searchFiles(sessionId, searchTerm, { limit: 5 });
        
        // Convert FileItem to suggestion format
        return files.map((file: FileItem) => ({
            key: `file-${file.fullPath}`,
            text: `@${file.fullPath}`,  // Full path in the mention
            component: () => React.createElement(FileMentionSuggestion, {
                fileName: file.fileName,
                filePath: file.filePath,
                fileType: file.fileType
            })
        }));
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.error('Error fetching file suggestions:', error);
        }
        // Return empty array on error
        return [];
    }
}

export async function getSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
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
