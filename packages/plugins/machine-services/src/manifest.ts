import { definePlugin, HEALTH_CHECK_KINDS_V1, HealthCheckTcpConfigV1ProtocolSchema,
    HealthCheckDnsConfigV1ProtocolSchema, HealthCheckHeartbeatConfigV1ProtocolSchema,
    type HealthCheckKindContributionV1, type HealthCheckKindV1 } from '@happier-dev/plugin-sdk';
import { systemdRuntime } from './systemd.js';
import { composeRuntime } from './compose.js';
import { HealthCheckSourceConfigV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { savedHealthActions, HEALTH_STATUS_EVENT, healthTransition, runHealthCheckObserver } from './healthObserver.js';

const httpConfig = { anyOf: [
    { type: 'object', properties: { keyword: { type: 'string', minLength: 1 } }, additionalProperties: false },
    { type: 'object', properties: { endpoint: { type: 'string' }, expectStatus: { type: 'integer', minimum: 100, maximum: 599 },
        keyword: { type: 'string', minLength: 1 } }, required: ['endpoint', 'expectStatus'], additionalProperties: false },
] } as const;
const healthKinds = {
    http: { title: 'HTTP', configSchema: httpConfig },
    certificate: { title: 'Certificate', configSchema: httpConfig },
    tcp: { title: 'TCP', configSchema: HealthCheckTcpConfigV1ProtocolSchema.jsonSchema },
    dns: { title: 'DNS', configSchema: HealthCheckDnsConfigV1ProtocolSchema.jsonSchema },
    heartbeat: { title: 'Heartbeat', configSchema: HealthCheckHeartbeatConfigV1ProtocolSchema.jsonSchema },
} satisfies Record<HealthCheckKindV1, Pick<HealthCheckKindContributionV1, 'title' | 'configSchema'>>;

export const plugin = definePlugin({
    id: 'happier.machine.services', version: '0.0.0', displayName: 'Machine services',
    description: 'Observe and control existing native services on the selected Machine.',
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    activation: { events: [], configuration: { automationEventSources: true } },
    actions: { ...savedHealthActions, 'health/setup': {
        title: 'Configure saved health checks', execution: { target: 'daemon' }, scopes: ['global', 'machine'],
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe', readOnly: false,
        inputSchema: HealthCheckSourceConfigV1ProtocolSchema,
        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, HealthCheckSourceConfigV1ProtocolSchema.jsonSchema),
        async run(input, context) {
            const draft = HealthCheckSourceConfigV1ProtocolSchema.parse(input);
            const sourceInstanceId = `health:${computeCanonicalDomainSeparatedDigest('happier.health.subject.v1',
                [createCanonicalJsonSigningInput(draft.subject)])}`;
            const sourceConfig = await context.services.healthChecks.setup({ sourceInstanceId, sourceConfig: draft,
                heartbeatContributionId: 'health-heartbeat' }, { signal: context.signal });
            return { v: 1, sourceInstanceId, sourceContractVersion: 1, sourceConfig,
                displayLabel: 'Saved health checks' };
        },
    } },
    webhooks: { 'health-heartbeat': { title: 'Health heartbeat', verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' },
        delivery: 'recordReceiptOnly' } },
    healthCheckKinds: Object.fromEntries(HEALTH_CHECK_KINDS_V1.map(id => [id, { ...healthKinds[id],
        action: `health/${id}` } satisfies Omit<HealthCheckKindContributionV1, 'id'>])),
    events: { [HEALTH_STATUS_EVENT]: { declaration: { kind: 'event', title: 'Health status changed',
        payloadSchema: healthTransition.jsonSchema,
        automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: HealthCheckSourceConfigV1ProtocolSchema.jsonSchema,
            setupActionRef: { pluginId: 'happier.machine.services', localId: 'health/setup' } } },
    } } },
    backgroundServices: [{ declaration: { id: 'health-observer', title: 'Saved health checks', placement: 'daemon' }, runner: runHealthCheckObserver }],
    hostAccess: { required: [{ id: 'health-status-storage', capability: 'storage.account',
        reason: 'Retain the last admitted health status and pending transition for enabled saved checks.', scope: { enabled: true },
    }, { id: 'systemd-process', capability: 'process',
        reason: 'Discover visible systemd services, read unit journals and control existing services of the daemon user.',
        scope: { executables: [{ kind: 'systemTool', id: 'systemctl' }, { kind: 'systemTool', id: 'journalctl' }],
            envKeys: ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LC_ALL'] },
    }, { id: 'docker-process', capability: 'process',
        reason: 'Discover and observe existing Compose projects and read their native container logs.',
        scope: { executables: [{ kind: 'systemTool', id: 'docker' }] },
    }, { id: 'journal-source', capability: 'filesystem',
        reason: 'Observe native journal changes only while a service log continuation is open.',
        scope: { locations: [{ root: 'machine', pathPrefix: '/var/log/journal' },
            { root: 'machine', pathPrefix: '/run/log/journal' }], access: ['read'] },
    }], optional: [] },
    systemTools: { systemctl: { title: 'systemd service manager', executableNames: ['systemctl'] },
        journalctl: { title: 'systemd journal reader', executableNames: ['journalctl'] },
        docker: { title: 'Docker', executableNames: ['docker'] } },
    projectNativeAdapters: {
        systemd: { declaration: { files: [], roles: ['nativeServiceLifecycle'] }, runtime: systemdRuntime },
        compose: { declaration: { files: [], roles: ['nativeServiceLifecycle'] }, runtime: composeRuntime },
    },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
