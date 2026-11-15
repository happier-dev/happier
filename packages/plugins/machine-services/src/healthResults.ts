import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';
import { healthResultProjectionPageSchema, readHealthResultProjections } from './healthResultProjection.js';
import { HEALTH_RESULTS_ACTION_ID } from './actionIds.js';

const inputSchema = defineProtocolObject({ cursor: defineProtocolString().optional() }, { policy: 'closed' });

export const retainedHealthActions = {
    [HEALTH_RESULTS_ACTION_ID]: {
        title: 'Read retained health results',
        description: 'Read the saved health observations, sample uptime and recent history shown in health details. Does not run a check. Continue with nextCursor; members identify the saved automation, trigger revision and source selector.',
        scopes: ['global'] as const, surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const,
        dangerLevel: 'safe' as const, readOnly: true,
        execution: { target: 'account' as const, account: { artifactId: 'health-account-runtime', exportName: 'activate' } },
        inputSchema, resultSchema: healthResultProjectionPageSchema,
        async run(input: unknown, context: PluginAccountActionContext) {
            const request = inputSchema.parse(input);
            const { kv } = requireAccountStorage(context, { code: 'health_check_storage_unavailable',
                message: 'Account storage is unavailable for retained health results.' });
            return readHealthResultProjections(kv, { ...request, signal: context.signal });
        },
    },
};
