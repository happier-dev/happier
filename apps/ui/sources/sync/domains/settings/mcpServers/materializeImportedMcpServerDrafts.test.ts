import { describe, expect, it } from 'vitest';

import type { McpServersSettingsV1 } from '@happier-dev/protocol';

import { materializeImportedMcpServerDrafts } from './materializeImportedMcpServerDrafts';

function createEmptySettings(): McpServersSettingsV1 {
    return {
        v: 1,
        strictMode: false,
        servers: [],
        bindings: [],
    };
}

describe('materializeImportedMcpServerDrafts', () => {
    it('creates saved secrets for mapped input values and binds stdio servers to the selected machine', () => {
        const result = materializeImportedMcpServerDrafts({
            settings: createEmptySettings(),
            secrets: [],
            drafts: [{
                name: 'github',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
                env: {
                    GITHUB_TOKEN: { t: 'input', inputId: 'github_token' },
                },
                enabled: true,
                warnings: [],
            }],
            inputMappings: {
                github_token: {
                    mode: 'savedSecret',
                    secretName: 'GitHub token',
                    secretValue: 'ghp_test_123',
                    secretKind: 'token',
                },
            },
            defaultMachineId: 'machine-1',
            nowMs: 123,
            generateId: (() => {
                let index = 1;
                return () => `id-${index++}`;
            })(),
        });

        expect(result.warnings).toEqual([]);
        expect(result.nextSettings.servers).toHaveLength(1);
        expect(result.nextSettings.servers[0]).toMatchObject({
            id: 'id-1',
            name: 'github',
            transport: 'stdio',
            env: {
                GITHUB_TOKEN: {
                    t: 'savedSecret',
                    secretId: 'id-2',
                },
            },
        });
        expect(result.nextSettings.bindings).toEqual([
            {
                id: 'id-3',
                serverId: 'id-1',
                enabled: true,
                target: { t: 'machine', machineId: 'machine-1' },
                createdAt: 123,
                updatedAt: 123,
            },
        ]);
        expect(result.nextSecrets).toEqual([{
            id: 'id-2',
            name: 'GitHub token',
            kind: 'token',
            encryptedValue: { _isSecretValue: true, value: 'ghp_test_123' },
            createdAt: 123,
            updatedAt: 123,
        }]);
    });

    it('falls back to suggested machine env placeholders when input mappings are missing', () => {
        const result = materializeImportedMcpServerDrafts({
            settings: createEmptySettings(),
            secrets: [],
            drafts: [{
                name: 'context7',
                transport: 'http',
                remote: {
                    url: 'https://mcp.example.com',
                    headers: {
                        Authorization: { t: 'input', inputId: 'api_token' },
                    },
                },
                env: {},
                enabled: true,
                warnings: [],
            }],
            inputMappings: {},
            defaultMachineId: 'machine-1',
            nowMs: 123,
            generateId: (() => {
                let index = 1;
                return () => `id-${index++}`;
            })(),
        });

        expect(result.warnings).toEqual([
            'context7: unresolved input "api_token" was mapped to ${API_TOKEN}',
        ]);
        expect(result.nextSettings.servers[0]).toMatchObject({
            name: 'context7',
            transport: 'http',
            remote: {
                url: 'https://mcp.example.com',
                headers: {
                    Authorization: {
                        t: 'literal',
                        v: '${API_TOKEN}',
                    },
                },
            },
        });
        expect(result.nextSettings.bindings[0]?.target).toEqual({ t: 'allMachines' });
    });

    it('preserves imported server titles when provided', () => {
        const result = materializeImportedMcpServerDrafts({
            settings: createEmptySettings(),
            secrets: [],
            drafts: [{
                name: 'context7',
                title: 'Context7 MCP',
                transport: 'http',
                remote: {
                    url: 'https://mcp.example.com',
                    headers: {},
                },
                env: {},
                enabled: true,
                warnings: [],
            }],
            inputMappings: {},
            defaultMachineId: 'machine-1',
            nowMs: 123,
            generateId: (() => {
                let index = 1;
                return () => `id-${index++}`;
            })(),
        });

        expect(result.nextSettings.servers[0]).toMatchObject({
            name: 'context7',
            title: 'Context7 MCP',
        });
    });

    it('falls back to a machine env placeholder when a saved-secret mapping is incomplete', () => {
        const result = materializeImportedMcpServerDrafts({
            settings: createEmptySettings(),
            secrets: [],
            drafts: [{
                name: 'github',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
                env: {
                    GITHUB_TOKEN: { t: 'input', inputId: 'github_token' },
                },
                enabled: true,
                warnings: [],
            }],
            inputMappings: {
                github_token: {
                    mode: 'savedSecret',
                    secretName: 'GitHub token',
                    secretValue: '   ',
                    secretKind: 'token',
                },
            },
            defaultMachineId: 'machine-1',
            nowMs: 123,
            generateId: (() => {
                let index = 1;
                return () => `id-${index++}`;
            })(),
        });

        expect(result.warnings).toEqual([
            'github: incomplete saved secret mapping for "github_token" was mapped to ${GITHUB_TOKEN}',
        ]);
        expect(result.nextSettings.servers[0]).toMatchObject({
            id: 'id-1',
            env: {
                GITHUB_TOKEN: {
                    t: 'literal',
                    v: '${GITHUB_TOKEN}',
                },
            },
        });
        expect(result.nextSecrets).toEqual([]);
    });
});
