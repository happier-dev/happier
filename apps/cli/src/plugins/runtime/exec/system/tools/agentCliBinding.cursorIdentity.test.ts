import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { expect, it } from 'vitest';

import { createAgentCliSystemToolService } from './agentCliBinding';
import { createPluginExecSystemToolResolver } from './resolveGrant';

it.skipIf(process.platform === 'win32')('reports Cursor missing for another agent, then grants the vendor alias without a TTY probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-tool-identity-'));
    const runtimeSpec = getAgentCliRuntimeSpec('cursor');
    if (!runtimeSpec) throw new Error('Cursor runtime declaration missing');
    const bin = join(root, 'bin');
    const alias = join(bin, 'agent');
    const definition = { toolId: 'cursor-agent', displayName: runtimeSpec.title,
        lookupNames: [runtimeSpec.binaryName, ...(runtimeSpec.alternativeBinaryNames ?? [])] };
    const processEnv = { HOME: root, PATH: bin };
    const tools = createAgentCliSystemToolService({ agentId: 'cursor', runtimeSpec,
        binding: { toolId: definition.toolId }, definition, processEnv,
        delegate: createPluginExecSystemToolResolver({ definitions: [definition], baseEnv: processEnv, registerGrant() {} }),
    });
    const request = { toolId: definition.toolId, purpose: 'Open Cursor Session', cwd: root };
    try {
        await mkdir(bin);
        await writeFile(alias, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
        await expect(tools.resolve(request)).rejects.toMatchObject({
            code: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
            message: expect.any(String),
        });
        await rm(alias);
        const vendor = join(root, 'cursor-agent');
        await writeFile(vendor, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
        await symlink(vendor, alias);
        await expect(tools.resolve(request)).resolves.toMatchObject({
            executablePath: alias, launch: { executablePath: alias, args: [] },
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
