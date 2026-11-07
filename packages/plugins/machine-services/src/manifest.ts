import { definePlugin, HEALTH_CHECK_KINDS_V1, HealthCheckTcpConfigV1ProtocolSchema,
    HealthCheckDnsConfigV1ProtocolSchema, HealthCheckHeartbeatConfigV1ProtocolSchema,
    type HealthCheckKindContributionV1, type HealthCheckKindV1 } from '@happier-dev/plugin-sdk';
import { systemdRuntime } from './systemd.js';
import { composeRuntime } from './compose.js';
import { HealthCheckSourceConfigV1ProtocolSchema, HealthCheckSetupInputV1ProtocolSchema,
    HealthCheckHttpConfigV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { savedHealthActions, HEALTH_STATUS_EVENT, HEALTH_CHECK_FAILED_EVENT, HEALTH_CHECK_RECOVERED_EVENT,
    healthTransition, runHealthCheckObserver } from './healthObserver.js';
import { deploymentEvents, deploymentEventActions, deploymentEventBackgroundServices } from './deploymentEvents.js';
import { managedSetupEvents, managedSetupEventActions, managedSetupEventBackgroundServices } from './managedSetupEvents.js';
import { mcpUpdateEvents, mcpUpdateEventActions, mcpUpdateEventBackgroundServices } from './mcpUpdateEvents.js';
import { machinePresenceEvents, machinePresenceEventActions, machinePresenceEventBackgroundServices } from './machinePresenceEvents.js';
import { createHealthCheckSourceInstanceIdV1, HEALTH_SETUP_OPEN_ACTION_ID, MACHINE_SERVICES_PLUGIN_ID,
    MachineServiceHealthSetupOpenInputV1Schema } from './healthSetup.js';

const healthKinds = {
    http: { title: 'HTTP', configSchema: HealthCheckHttpConfigV1ProtocolSchema.jsonSchema },
    certificate: { title: 'Certificate', configSchema: HealthCheckHttpConfigV1ProtocolSchema.jsonSchema },
    tcp: { title: 'TCP', configSchema: HealthCheckTcpConfigV1ProtocolSchema.jsonSchema },
    dns: { title: 'DNS', configSchema: HealthCheckDnsConfigV1ProtocolSchema.jsonSchema },
    heartbeat: { title: 'Heartbeat', configSchema: HealthCheckHeartbeatConfigV1ProtocolSchema.jsonSchema },
} satisfies Record<HealthCheckKindV1, Pick<HealthCheckKindContributionV1, 'title' | 'configSchema'>>;
const locales = ['en', 'de', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja'] as const;

export const plugin = definePlugin({
    id: MACHINE_SERVICES_PLUGIN_ID, version: '0.0.0', displayName: 'Machine services',
    description: 'Observe and control existing native services on the selected Machine.',
    resources: Object.fromEntries(locales.map(locale => [`i18n-${locale.toLowerCase()}`,
        { kind: 'asset' as const, path: `assets/i18n/${locale}.json`, contentType: 'application/json' }])),
    ui: { renderers: [{ id: 'health-setup', kind: 'reactNative', artifact: 'health-setup',
        requiredHostMethods: ['settleEphemeralInput'] }],
        translations: locales.map(locale => ({ locale, resourceId: `i18n-${locale.toLowerCase()}` })) },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    activation: { events: [], configuration: { automationEventSources: true } },
    actions: { ...savedHealthActions, ...deploymentEventActions, ...managedSetupEventActions, ...mcpUpdateEventActions, ...machinePresenceEventActions,
        [HEALTH_SETUP_OPEN_ACTION_ID]: {
            title: 'Open health check setup', scopes: ['global', 'machine'], surfaces: ['ui', 'plugin'], dangerLevel: 'safe',
            placementBindings: [],
            execution: { target: 'client', client: { artifactId: 'health-setup', exportName: 'activate' },
                platforms: ['web', 'ios', 'android'] },
            inputSchema: MachineServiceHealthSetupOpenInputV1Schema,
            resultSchema: defineProtocolObject({ status: defineProtocolUnion([
                defineProtocolLiteral('opened'), defineProtocolLiteral('unavailable'),
            ]) }, { policy: 'closed' }),
        }, 'health/setup': {
        title: 'Configure saved health checks', execution: { target: 'daemon' }, scopes: ['global', 'machine'],
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe', readOnly: false,
        inputSchema: HealthCheckSetupInputV1ProtocolSchema,
        inputHints: { fields: [
            { path: 'v', title: 'Version', widget: 'number', defaultValue: 1,
                visibleWhen: { op: 'not', predicate: { op: 'truthy', path: 'v' } } },
            { path: 'subject', title: 'Subject', widget: 'json', required: true,
                placeholder: '{"kind":"machineService","machineId":"…","serviceId":"…"}' },
            { path: 'checks', title: 'Health checks', widget: 'json', required: true,
                placeholder: '[{"checkId":"tcp","kind":{"pluginId":"happier.machine.services","localId":"tcp"},"binding":{"kind":"healthCheck"},"config":{"host":"127.0.0.1","port":8080},"periodMs":300000,"consecutiveFailuresBeforeAlerting":1}]' },
        ] },
        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, HealthCheckSourceConfigV1ProtocolSchema.jsonSchema),
        async run(input, context) {
            const draft = HealthCheckSetupInputV1ProtocolSchema.parse(input);
            const sourceInstanceId = createHealthCheckSourceInstanceIdV1(draft.subject);
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
    events: { ...deploymentEvents, ...managedSetupEvents, ...mcpUpdateEvents, ...machinePresenceEvents, ...Object.fromEntries(([
        [HEALTH_STATUS_EVENT, 'healthStatus', 'Health status changed', 'A saved health check failed or recovered.'],
        [HEALTH_CHECK_FAILED_EVENT, 'healthCheckFailed', 'Health check failed', 'A saved health check entered a failed condition.'],
        [HEALTH_CHECK_RECOVERED_EVENT, 'healthCheckRecovered', 'Health check recovered', 'A failed saved health check returned to healthy.'],
    ] as const).map(([id, key, title, description]) => [id, { declaration: { kind: 'event' as const,
        title: { key: `machineServices.events.${key}.title`, fallback: title },
        description: { key: `machineServices.events.${key}.description`, fallback: description },
        payloadSchema: healthTransition.jsonSchema,
        automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
            observationOnly: { kind: 'observationOnly' },
            supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: HealthCheckSourceConfigV1ProtocolSchema.jsonSchema,
            setupActionRef: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/setup' },
            setupSurface: { renderer: 'health-setup' } } },
    } }])) },
    backgroundServices: [{ declaration: { id: 'health-observer', title: 'Saved health checks', placement: 'daemon' }, runner: runHealthCheckObserver },
        ...deploymentEventBackgroundServices, ...managedSetupEventBackgroundServices, ...mcpUpdateEventBackgroundServices, ...machinePresenceEventBackgroundServices],
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
