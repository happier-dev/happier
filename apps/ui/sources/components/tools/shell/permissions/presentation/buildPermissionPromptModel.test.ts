import { describe, expect, it } from 'vitest';
import { buildPermissionPromptModel } from './buildPermissionPromptModel';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { resolveSessionPermissionChoices } from '@/sync/ops/sessionPermissionChoices';

describe('buildPermissionPromptModel', () => {
    it('keeps malformed retained native offers from becoming generic grants in the prompt', async () => {
        const request: PendingPermissionRequest = { id: 'malformed', kind: 'permission', tool: 'Bash', arguments: {}, createdAt: 1 };
        // Retained external content can violate the current schema; presentation owns decoding it.
        Object.assign(request, { nativeChoices: null });
        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 1 });
        expect(resolveSessionPermissionChoices({ toolName: request.tool,
            nativeChoices: model.tool.permission.nativeChoices,
            permissionBehavior: resolveSessionPermissionBehavior({ agentId: 'claude', metadata: null, accountScope: null }),
        })).toEqual([]);
    });
    it('retains catalog identity and facts without guessing a server from its wire name', async () => {
        const request = {
            id: 'mcp-delete', tool: 'mcp__github__delete_file', kind: 'permission' as const,
            createdAt: 1, arguments: { file_path: 'src/index.ts', recursive: true },
            mcpTool: { server: 'github', tool: 'delete_file', item: { serverId: 'catalog-github' },
                serverTitle: 'GitHub', toolTitle: 'Delete file', annotations: { destructiveHint: true },
                decision: { exposed: true, approval: 'ask' as const, effectClass: 'unknown' as const, source: 'server_default' as const } },
        };
        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 1, serverDefault: 'allow_read_only' });
        expect(model.mcp).toMatchObject({ serverId: 'catalog-github', toolName: 'delete_file', title: 'Delete file',
            serverTitle: 'GitHub', badges: ['destructive'], serverDefault: 'allow_read_only',
            argumentFacts: [{ key: 'file_path', label: 'File path', value: 'src/index.ts' },
                { key: 'recursive', label: 'Recursive', value: 'true' }] });
        expect(model.tool.permission).toMatchObject({ mcpTool: request.mcpTool });
        expect(model.headerText.title).toBe('Delete file · GitHub');
        expect(buildPermissionPromptModel({ request: { ...request, mcpTool: undefined }, metadata: null, nowMs: 1 }).mcp).toBeUndefined();
        expect(buildPermissionPromptModel({ request: { ...request, mcpTool: { ...request.mcpTool, server: 'happier' } }, metadata: null, nowMs: 1 }).mcp).toBeUndefined();
    });
    it('creates a pending ToolCall stub from the request', async () => {

        const request: PendingPermissionRequest = {
            id: 'perm-1',
            tool: 'edit',
            kind: 'permission',
            arguments: { path: 'file.ts', replacement: 'hi' },
            createdAt: 1_234,
            turnId: 'turn-1',
            source: 'claude_local_permission_bridge',
            permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        };

        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 9_999 });

        expect(model.tool.name).toBe('edit');
        expect(model.tool.input).toEqual({ path: 'file.ts', replacement: 'hi' });
        expect(model.tool.permission).toEqual({ id: 'perm-1', status: 'pending', turnId: 'turn-1',
            source: 'claude_local_permission_bridge', suggestions: request.permissionSuggestions });
        expect(model.tool.createdAt).toBe(1_234);
        expect(model.tool.startedAt).toBe(1_234);
        expect(model.tool.completedAt).toBeNull();
        expect(model.tool.state).toBe('running');
    });

    it('falls back to nowMs when request.createdAt is missing', async () => {

        const request: PendingPermissionRequest = {
            id: 'perm-2',
            tool: 'edit',
            kind: 'permission',
            arguments: { path: 'file.ts' },
            createdAt: null,
        };

        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 4_567 });
        expect(model.tool.createdAt).toBe(4_567);
    });
});
