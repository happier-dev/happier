import { describe, expect, it } from 'vitest';

import {
    ACP_AGENT_CLI_TRANSPORT_TIMEOUTS,
    ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES,
    ACP_WRITE_LIKE_PERMISSION_KINDS,
    createAcpToolNameInferencePreset,
    normalizeAcpPermissionIntent,
    resolveAcpToolPermissionPolicy,
    type AcpToolPermissionPolicyV1,
    type AcpToolPermissionValueV1,
} from '../index.js';
import * as acpExports from '../index.js';

describe('ACP provider-neutral presets', () => {
    it('provides the shared agent-cli timeout and tool-name inference preset', () => {
        expect(ACP_AGENT_CLI_TRANSPORT_TIMEOUTS).toMatchObject({
            initMs: 90_000,
            toolCallMs: 120_000,
            investigationToolCallMs: 300_000,
            toolKindTimeouts: { think: 30_000 },
            idleMs: 500,
        });

        const inference = createAcpToolNameInferencePreset({ shellBridgeHint: true });

        expect(inference).toMatchObject({
            preferLongestPattern: true,
            unknownToolNames: ['other', 'Unknown tool', 'unknown'],
            hintInputFields: ['tool_name', 'toolName', 'name'],
            shellBridgeHint: true,
            investigationToolIdPatterns: ['task'],
            investigationToolKinds: ['task'],
        });
        expect(inference.patterns).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'change_title', inputFields: ['title'] }),
            expect.objectContaining({ name: 'write', inputFields: ['path', 'filePath', 'content', 'text'] }),
            expect.objectContaining({ name: 'task', inputFields: ['prompt'] }),
        ]));
    });

    it('normalizes permission aliases and emits the shared ACP tool permission policy', () => {
        expect(normalizeAcpPermissionIntent('workspace_write')).toBe('safe-yolo');
        expect(normalizeAcpPermissionIntent('danger-full-access')).toBe('yolo');
        expect(ACP_WRITE_LIKE_PERMISSION_KINDS).toEqual(['external_directory', 'doom_loop']);

        const readOnlyPolicy = resolveAcpToolPermissionPolicy('read_only');

        expect(readOnlyPolicy).toMatchObject({
            '*': 'deny',
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
            ls: 'allow',
            edit: 'deny',
            write: 'deny',
            task: 'deny',
            external_directory: 'deny',
            doom_loop: 'deny',
            change_title: 'allow',
            session_title_set: 'allow',
            happier_action_execute: 'allow',
        });
    });

    it('exports the narrow static approval list for first-party Happier MCP bridge configuration', () => {
        expect(ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES).toEqual([
            'action_options_resolve',
            'action_spec_get',
            'action_spec_search',
            'change_title',
            'session_title_set',
        ]);
        expect(ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES).not.toContain('action_execute');

        const planPolicy = resolveAcpToolPermissionPolicy('plan');
        for (const toolName of ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES) {
            expect(planPolicy[toolName]).toBe('allow');
        }
    });

    it('does not expose provider-branded permission policy aliases from the neutral ACP preset surface', () => {
        expect('resolveOpenCodeStylePermissionPolicy' in acpExports).toBe(false);
        expect('OpenCodeStylePermissionPolicyV1' in acpExports).toBe(false);
        expect('OpenCodeStylePermissionValueV1' in acpExports).toBe(false);

        const policy: AcpToolPermissionPolicyV1 = resolveAcpToolPermissionPolicy('read_only');
        const value: AcpToolPermissionValueV1 = policy.read;
        expect(value).toBe('allow');
    });
});
