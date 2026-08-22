import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import {
    PluginContributionIdentityV1JsonSchema,
    PluginIdJsonSchema,
} from '@happier-dev/plugin-sdk/manifest';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/plugin-sdk/sessions';

const publicContributionLocalIdSchema: PluginJsonSchema | undefined =
    PluginContributionIdentityV1JsonSchema.properties?.localId;
const publicPluginIdSchemaType: PluginJsonSchema['type'] = PluginIdJsonSchema.type;

/**
 * Public declaration regression for Session creation. The canonical parser's
 * successful output must flow directly into the generated built-in Action
 * map, whose result retains its discriminant and success Session identity.
 */
export async function publicSessionSpawn(
    actions: ActionsService,
    signal?: AbortSignal,
): Promise<string | boolean> {
    const parsed = SessionSpawnNewInputV2Schema.safeParse({
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: '/workspace/project',
        agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
    });
    if (!parsed.success) throw parsed.error;

    const result = await actions.execute(
        'session.spawn_new',
        parsed.data,
        { signal },
    );
    if (result.type === 'success') {
        const sessionId: string = result.sessionId;
        return sessionId;
    }
    if (result.type === 'pending') return result.retryWithSameCreationKey;
    return result.retryable;
}

void publicContributionLocalIdSchema;
void publicPluginIdSchemaType;
