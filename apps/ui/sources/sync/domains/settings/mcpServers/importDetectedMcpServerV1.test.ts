import { describe, expect, it } from 'vitest';

import type { DetectedMcpServerV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { buildImportedMcpServerFromDetectedV1, resolveImportedMcpServerFromDetectedV1 } from './importDetectedMcpServerV1';

function createEmptySettings(): McpServersSettingsV1 {
    return { v: 1, strictMode: false, servers: [], bindings: [] };
}

describe('buildImportedMcpServerFromDetectedV1', () => {
    it('sanitizes the detected name into a valid server name', () => {
        const settings = createEmptySettings();
        const detected: DetectedMcpServerV1 = {
            provider: 'claude',
            name: 'My Server!',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            envKeys: [],
            enabled: true,
            source: { kind: 'user', path: '/tmp/config.json' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'm1',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.entry.name).toBe('my_server');
        expect(out.entry.id).toBe('id1');
    });

    it('avoids reserved and colliding server names by appending a suffix', () => {
        const settings: McpServersSettingsV1 = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'existing',
                    name: 'happier_2',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            bindings: [],
        };

        const detected: DetectedMcpServerV1 = {
            provider: 'codex',
            name: 'Happier',
            transport: 'stdio',
            stdio: { command: 'node', args: [] },
            envKeys: [],
            enabled: null,
            source: { kind: 'user', path: '/tmp/config.toml' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'm1',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.entry.name).toBe('happier_3');
    });

    it('maps detected env keys to machine-env templates by default', () => {
        const settings = createEmptySettings();
        const detected: DetectedMcpServerV1 = {
            provider: 'opencode',
            name: 'tooling',
            transport: 'stdio',
            stdio: { command: 'bash', args: ['-lc', 'echo ok'] },
            envKeys: ['API_KEY'],
            enabled: true,
            source: { kind: 'project', path: '/workspace/.opencode/opencode.json' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'm1',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.entry.env).toEqual({ API_KEY: { t: 'literal', v: '${API_KEY}' } });
    });

    it('maps detected remote headers to machine-env templates with stable env var naming', () => {
        const settings = createEmptySettings();
        const detected: DetectedMcpServerV1 = {
            provider: 'claude',
            name: 'Remote Tools',
            transport: 'http',
            remote: { url: 'https://example.test/mcp', headers: ['Authorization', 'X-API-Key'] },
            envKeys: [],
            enabled: true,
            source: { kind: 'user', path: '/tmp/claude.json' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'm1',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.entry.transport).toBe('http');
        expect(out.entry.remote?.headers).toEqual({
            Authorization: { t: 'literal', v: '${MCP_REMOTE_TOOLS_AUTHORIZATION}' },
            'X-API-Key': { t: 'literal', v: '${MCP_REMOTE_TOOLS_X_API_KEY}' },
        });
    });

    it('creates a machine binding and carries detected enabled state (defaulting to true)', () => {
        const settings = createEmptySettings();
        const detected: DetectedMcpServerV1 = {
            provider: 'claude',
            name: 'x',
            transport: 'stdio',
            stdio: { command: 'node', args: ['x'] },
            envKeys: [],
            enabled: false,
            source: { kind: 'user', path: '/tmp/claude.json' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'machine-123',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.binding.enabled).toBe(false);
        expect(out.binding.target).toEqual({ t: 'machine', machineId: 'machine-123' });
        expect(out.binding.serverId).toBe(out.entry.id);
    });

    it('creates a workspace binding when the detected config is project-scoped', () => {
        const settings = createEmptySettings();
        const detected: DetectedMcpServerV1 = {
            provider: 'opencode',
            name: 'project-tools',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            envKeys: [],
            enabled: true,
            source: { kind: 'project', path: '/repo/.opencode/opencode.json' },
        };

        const out = buildImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'machine-123',
            nowMs: 123,
            generateId: (() => 'id1') as any,
        });

        expect(out.binding.target).toEqual({ t: 'workspace', machineId: 'machine-123', workspaceRoot: '/repo' });
    });

    it('reuses an existing imported server instead of creating a suffixed duplicate', () => {
        const settings: McpServersSettingsV1 = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'existing-server',
                    name: 'sequential-thinking',
                    title: 'sequential-thinking',
                    transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            bindings: [
                {
                    id: 'existing-binding',
                    serverId: 'existing-server',
                    enabled: true,
                    target: { t: 'machine', machineId: 'machine-123' },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };

        const detected: DetectedMcpServerV1 = {
            provider: 'codex',
            name: 'sequential-thinking',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
            envKeys: [],
            enabled: true,
            source: { kind: 'user', path: '/tmp/config.toml' },
        };

        const out = resolveImportedMcpServerFromDetectedV1({
            existingSettings: settings,
            detected,
            machineId: 'machine-123',
            nowMs: 123,
            generateId: (() => 'new-id') as any,
        });

        expect(out.action).toBe('reused');
        expect(out.entry.id).toBe('existing-server');
        expect(out.nextSettings).toBe(settings);
    });
});
