import type { SDKMessage } from '../../../sdk/types.js';
import { readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { isGenericSubagentToolName } from '@happier-dev/plugin-sdk/sessions/subagents';

/** Native init and the successful foreground stream witness this window only. */
export function createClaudeMcpUsageWitness(serverNames: readonly string[], startMs: number) {
    let inventory: Set<string> | null = null;
    let toolInventory: Set<string> | null = null;
    let incomplete = false;
    const calls = new Map<string, string>();
    const counts = new Map(serverNames.map(name => [name, 0]));
    const serverForTool = (tool: string): string | null => {
        const matches = serverNames.filter(name => tool.startsWith(`mcp__${name}__`));
        if (matches.length !== 1) { incomplete = true; return null; }
        return matches[0]!;
    };
    return {
        observe(message: SDKMessage): void {
            if (readClaudeTaskLifecycleEnvelope(message)) incomplete = true;
            if (message.type === 'system' && message.subtype === 'init') {
                if (!Array.isArray(message.tools) || !message.tools.every(tool => typeof tool === 'string')) { incomplete = true; return; }
                const next = new Set<string>();
                const nextTools = new Set<string>();
                for (const tool of message.tools) if (tool.startsWith('mcp__')) {
                    if (tool.startsWith('mcp__happier__')) continue;
                    nextTools.add(tool);
                    const server = serverForTool(tool);
                    if (server) next.add(server);
                }
                if (inventory !== null && JSON.stringify([...inventory].sort()) !== JSON.stringify([...next].sort())) incomplete = true;
                if (toolInventory !== null && JSON.stringify([...toolInventory].sort()) !== JSON.stringify([...nextTools].sort())) incomplete = true;
                inventory = next;
                toolInventory = nextTools;
            }
            if (message.type !== 'assistant') return;
            if (message.parent_tool_use_id != null) incomplete = true;
            const payload = message.message;
            if (typeof payload !== 'object' || payload === null || !('content' in payload) || !Array.isArray(payload.content)) { incomplete = true; return; }
            for (const block of payload.content) {
                if (typeof block !== 'object' || block === null || block.type !== 'tool_use') continue;
                if (typeof block.name !== 'string' || typeof block.id !== 'string' || !block.id) { incomplete = true; continue; }
                // Delegated native work may invoke tools hidden from the foreground stream.
                if (isGenericSubagentToolName(block.name) || block.name === 'Workflow') incomplete = true;
                if (!block.name.startsWith('mcp__') || block.name.startsWith('mcp__happier__')) continue;
                if (!toolInventory?.has(block.name)) incomplete = true;
                const server = serverForTool(block.name);
                if (!server) continue;
                const before = calls.get(block.id);
                if (before && before !== server) incomplete = true;
                if (before) continue;
                calls.set(block.id, server);
                counts.set(server, (counts.get(server) ?? 0) + 1);
            }
        },
        finish(endMs: number, settled: boolean) {
            const witnessedInventory = inventory;
            return { window: { startMs, endMs },
                coverage: !incomplete && settled && witnessedInventory !== null && serverNames.every(name => witnessedInventory.has(name))
                    ? 'complete' as const : 'partial' as const,
                servers: serverNames.map(serverName => ({ serverName, toolCallCount: counts.get(serverName) ?? 0, schemaBytes: null })),
            };
        },
    };
}
