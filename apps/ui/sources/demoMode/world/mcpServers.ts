import { McpServerCatalogV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import { DEMO_NOW_MS, DEMO_PROJECT_PATH } from './constants';

/** Representative declarations only; demo mode never acquires or starts these servers. */
export function buildDemoMcpServerCatalog(): McpServerCatalogV1 {
    return McpServerCatalogV1Schema.parse({
        v: 1,
        servers: [
            {
                id: 'demo-mcp-filesystem', name: 'filesystem', title: 'Project files',
                description: 'Read and edit files in the project workspace',
                transport: 'stdio', stdio: { command: 'mcp-server-filesystem', args: [DEMO_PROJECT_PATH] },
                env: {}, tools: { default: 'ask', overrides: {} }, createdAt: DEMO_NOW_MS, updatedAt: DEMO_NOW_MS,
            },
            {
                id: 'demo-mcp-git', name: 'git', title: 'Git',
                description: 'Repository history, branches, and changes',
                transport: 'stdio', stdio: { command: 'mcp-server-git', args: ['--repository', DEMO_PROJECT_PATH] },
                env: {}, tools: { default: 'ask', overrides: {} }, createdAt: DEMO_NOW_MS, updatedAt: DEMO_NOW_MS,
            },
        ],
        bindings: [
            { id: 'demo-mcp-filesystem-all', serverId: 'demo-mcp-filesystem', target: { t: 'allMachines' }, enabled: true,
                createdAt: DEMO_NOW_MS, updatedAt: DEMO_NOW_MS },
            { id: 'demo-mcp-git-all', serverId: 'demo-mcp-git', target: { t: 'allMachines' }, enabled: true,
                createdAt: DEMO_NOW_MS, updatedAt: DEMO_NOW_MS },
        ],
    });
}
