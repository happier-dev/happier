import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import type { PluginApi } from '../../api/types';

/**
 * Auto-registration of a plugin's ACP backend (`agent/acp.js`) as an agent
 * runtime, when present. Isolated because it does its own dynamic import and
 * file-existence probe, distinct from the generic activation-export flow.
 */

type AcpModuleNamespace = Readonly<{
    ACP_BACKEND_DEFINITION?: AcpBackendSpecV1;
}>;

export async function autoRegisterAcpBackend(pluginPath: string, api: Pick<PluginApi, 'registerAgentRuntime'>): Promise<boolean> {
    const modulePath = `${pluginPath.replace(/\/+$/, '')}/agent/acp.js`;
    if (!existsSync(modulePath)) {
        return false;
    }
    const namespace = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as AcpModuleNamespace;
    const spec = namespace.ACP_BACKEND_DEFINITION;
    if (!spec) {
        return false;
    }
    api.registerAgentRuntime({
        agentId: spec.backendId,
        create: (ctx) => ctx.agentRuntime.acp.defineAcpBackend(spec),
    });
    return true;
}
