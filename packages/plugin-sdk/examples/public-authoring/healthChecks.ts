import { definePlugin, HealthCheckSubjectV1ProtocolSchema, HealthCheckResultV1ProtocolSchema,
    type HealthCheckSubjectV1, type HealthCheckResultV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';

/** Finite metadata read through the public HTTP owner; no second TLS connection. */
export async function readEndpointMetadata(http: HttpService, url: string, signal: AbortSignal) {
    const response = await http.request({ url, method: 'GET', redirect: 'error',
        responseBody: 'discard', observeTlsPeer: true }, { signal });
    return { status: response.status, tlsPeer: response.tlsPeer };
}

const config = defineProtocolObject({ expected: defineProtocolString() }, { policy: 'closed' });
const input: ProtocolComposableSchema<{ subject: HealthCheckSubjectV1; config: { expected: string } }> =
    defineProtocolObject({ subject: HealthCheckSubjectV1ProtocolSchema, config }, { policy: 'closed' });

/** Unreleased source example. The adapter supplies a finite observation after
 * host subject/network admission; it owns no scheduling, cursor or registry. */
export function createExternalHealthKind(observe: (
    subject: HealthCheckSubjectV1,
    expected: string,
    signal: AbortSignal,
) => Promise<HealthCheckResultV1>) {
    const observeHealth: PluginActionDefinition<Extract<PluginActionDeclaration, { execution?: { target: 'daemon' } }>> = {
        title: 'Observe external health', scopes: ['machine', 'global'], surfaces: ['plugin'],
        dangerLevel: 'safe', readOnly: true, execution: { target: 'daemon' },
        inputSchema: input, resultSchema: HealthCheckResultV1ProtocolSchema,
        run: async (value, context) => {
            const request = input.parse(value);
            return HealthCheckResultV1ProtocolSchema.parse(await observe(request.subject, request.config.expected, context.signal));
        },
    };
    return definePlugin({
        id: 'com.example.external-health', version: '0.1.0', displayName: 'External health kind',
        healthCheckKinds: {
            endpoint: { title: 'External endpoint', configSchema: config.jsonSchema, action: 'observe-health' },
        },
        actions: {
            'observe-health': observeHealth,
        },
    });
}
