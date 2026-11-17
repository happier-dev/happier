import { formatMcpToolWireNameV1, parseMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SDKMessage } from '../../../sdk/types.js';
import { readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { isGenericSubagentToolName } from '@happier-dev/plugin-sdk/sessions/subagents';

/** Native init and the successful foreground stream witness this window only. */
export function createClaudeMcpUsageWitness(serverNames: readonly string[], startMs: number) {
    let inventory: Set<string> | null = null;
    let toolInventory: Set<string> | null = null;
    let deferredServers = new Set<string>();
    let nativeServerNames = new Set(serverNames);
    let incomplete = false;
    let queuedTurnCount: number | null = null;
    const calls = new Map<string, string>();
    const counts = new Map(serverNames.map(name => [name, 0]));
    const serverForTool = (tool: string): string | null => {
        const matches = [...nativeServerNames].filter(name => tool.startsWith(formatMcpToolWireNameV1(name, '')));
        if (matches.length > 1 && matches.some(name => counts.has(name))) incomplete = true;
        // Native connectors outside the selected bindings are not part of this window.
        const identity = parseMcpToolWireNameV1(tool, nativeServerNames);
        return matches.length === 1 && identity && counts.has(identity.server) ? identity.server : null;
    };
    return {
        observe(message: SDKMessage): void {
            if (message.type === 'result') {
                const count = message.queued_turn_count;
                queuedTurnCount = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
            }
            if (readClaudeTaskLifecycleEnvelope(message)) incomplete = true;
            if (message.type === 'system' && message.subtype === 'init') {
                if (!Array.isArray(message.tools) || !message.tools.every(tool => typeof tool === 'string')) { incomplete = true; return; }
                const next = new Set<string>();
                const nextTools = new Set<string>();
                const nextDeferred = new Set<string>();
                const nativeServers = new Map<string, string>();
                if (message.mcp_servers !== undefined) {
                    if (!Array.isArray(message.mcp_servers)) { incomplete = true; return; }
                    const nativeInventory: readonly unknown[] = message.mcp_servers;
                    for (const server of nativeInventory) {
                        if (typeof server !== 'object' || server === null
                            || !('name' in server) || typeof server.name !== 'string'
                            || !('status' in server) || typeof server.status !== 'string'
                            || nativeServers.has(server.name)) { incomplete = true; return; }
                        nativeServers.set(server.name, server.status);
                    }
                    nativeServerNames = new Set([...serverNames, ...nativeServers.keys()]);
                    for (const name of serverNames) {
                        if (nativeServers.get(name) !== 'connected') { incomplete = true; continue; }
                        // Tool search defers definitions; native connection evidence still
                        // witnesses this server. It does not measure schema bytes or savings.
                        if (message.tools.includes('ToolSearch')) { next.add(name); nextDeferred.add(name); }
                    }
                }
                for (const tool of message.tools) if (tool.startsWith('mcp__')) {
                    if (tool.startsWith('mcp__happier__')) continue;
                    const server = serverForTool(tool);
                    if (server) { next.add(server); nextTools.add(tool); }
                }
                if (inventory !== null && JSON.stringify([...inventory].sort()) !== JSON.stringify([...next].sort())) incomplete = true;
                if (toolInventory !== null && JSON.stringify([...toolInventory].sort()) !== JSON.stringify([...nextTools].sort())) incomplete = true;
                inventory = next;
                toolInventory = nextTools;
                deferredServers = nextDeferred;
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
                const server = serverForTool(block.name);
                if (!server) continue;
                if (!toolInventory?.has(block.name) && !deferredServers.has(server)) incomplete = true;
                const before = calls.get(block.id);
                if (before && before !== server) incomplete = true;
                if (before) continue;
                calls.set(block.id, server);
                counts.set(server, (counts.get(server) ?? 0) + 1);
            }
        },
        finish(endMs: number, settled: boolean) {
            const witnessedInventory = inventory;
            return { window: { startMs, endMs }, queuedTurnCount,
                coverage: !incomplete && settled && witnessedInventory !== null && serverNames.every(name => witnessedInventory.has(name))
                    ? 'complete' as const : 'partial' as const,
                servers: serverNames.map(serverName => ({ serverName, toolCallCount: counts.get(serverName) ?? 0, schemaBytes: null })),
            };
        },
    };
}
