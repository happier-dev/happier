import { machineOutcomeEvents, machineOutcomeEventActions, machineOutcomeEventBackgroundServices } from './machineOutcomeEvents.js';
import { definePlugin, HEALTH_CHECK_KINDS_V1, HealthCheckTcpConfigV1ProtocolSchema,
    HealthCheckDnsConfigV1ProtocolSchema, HealthCheckHeartbeatConfigV1ProtocolSchema,
    type HealthCheckKindContributionV1, type HealthCheckKindV1, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginWebhookHeartbeatManageInputV1ProtocolSchema, PluginWebhookHeartbeatManageResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { httpRequestActions } from './httpRequest.js';
import { systemdRuntime } from './systemd.js';
import { healthCatalogActions } from './healthCatalog.js';
import { retainedHealthActions } from './healthResults.js';
import { monitorActions } from './monitorWebhooks.js';
import { monitorCapabilityContributions, monitorDefinitions, monitorKinds, monitorObserved } from './monitorDefinitions.js';
import { composeRuntime } from './compose.js';
import { HealthCheckSourceConfigV1ProtocolSchema, HealthCheckSetupInputV1ProtocolSchema,
    HealthCheckSetupPreviewInputV1ProtocolSchema, HealthCheckSetupPreviewResultV1ProtocolSchema,
    HealthCheckHttpConfigV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion, embedProtocolJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { savedHealthActions, HEALTH_STATUS_EVENT, HEALTH_CHECK_FAILED_EVENT, HEALTH_CHECK_RECOVERED_EVENT,
    healthTransition, runHealthCheckObserver } from './healthObserver.js';
import { savedHealthTransitionActions, savedHealthTransitionSourceSchema } from './healthSavedTransitions.js';
import { deploymentEvents, deploymentEventActions, deploymentEventBackgroundServices } from './deploymentEvents.js';
import { managedSetupEvents, managedSetupEventActions, managedSetupEventBackgroundServices } from './managedSetupEvents.js';
import { mcpUpdateEvents, mcpUpdateEventActions, mcpUpdateEventBackgroundServices } from './mcpUpdateEvents.js';
import { machinePresenceEvents, machinePresenceEventActions } from './machinePresenceEvents.js';
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
        requiredHostMethods: ['settleEphemeralInput', 'executeAction', 'writeClipboard'] }],
        translations: locales.map(locale => ({ locale, resourceId: `i18n-${locale.toLowerCase()}` })) },
    entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
    activation: { events: [], configuration: { automationEventSources: true } },
    actions: { ...httpRequestActions, ...machineOutcomeEventActions, ...monitorActions, ...healthCatalogActions, ...retainedHealthActions, ...savedHealthActions, ...savedHealthTransitionActions, ...deploymentEventActions, ...managedSetupEventActions, ...mcpUpdateEventActions, ...machinePresenceEventActions,
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
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe', approvalScope: 'healthCheck',
        readOnly: { op: 'eq', path: 'mode', value: 'preview' },
        inputSchema: defineProtocolUnion([HealthCheckSetupPreviewInputV1ProtocolSchema, HealthCheckSetupInputV1ProtocolSchema]),
        inputHints: { fields: [
            { path: 'v', title: 'Version', widget: 'number', defaultValue: 1,
                visibleWhen: { op: 'not', predicate: { op: 'truthy', path: 'v' } } },
            { path: 'subject', title: 'Subject', widget: 'json', required: true,
                placeholder: '{"kind":"machineService","machineId":"…","serviceId":"…"}' },
            { path: 'checks', title: 'Health checks', widget: 'json',
                requiredWhen: { op: 'not', predicate: { op: 'eq', path: 'mode', value: 'preview' } },
                placeholder: '[{"checkId":"tcp","kind":{"pluginId":"happier.machine.services","localId":"tcp"},"binding":{"kind":"healthCheck"},"config":{"host":"127.0.0.1","port":8080},"periodMs":300000,"consecutiveFailuresBeforeAlerting":1}]' },
            { path: 'investigation.mode', title: 'When a check needs attention', widget: 'select', defaultValue: 'inbox',
                options: [{ value: 'inbox', label: 'Show in Inbox' }, { value: 'auto_start', label: 'Start investigation' }] },
            { path: 'investigation.configuredActionId', title: 'Configured investigation', widget: 'text',
                description: 'Use an existing investigate Action from PRs & Issues, including its saved Machine, workspace and Agent choices.',
                visibleWhen: { op: 'eq', path: 'investigation.mode', value: 'auto_start' },
                requiredWhen: { op: 'eq', path: 'investigation.mode', value: 'auto_start' } },
        ] },
        resultSchema: { oneOf: [embedProtocolJsonSchema(HealthCheckSetupPreviewResultV1ProtocolSchema.jsonSchema, ['oneOf', 0]),
            embedProtocolJsonSchema(createPluginEventAutomationSetupResultV1JsonSchema(1, HealthCheckSourceConfigV1ProtocolSchema.jsonSchema), ['oneOf', 1])] },
        async run(input: unknown, context: PluginInvocationContext) {
            const preview = HealthCheckSetupPreviewInputV1ProtocolSchema.safeParse(input);
            if (preview.success) return context.services.healthChecks.setup({
                sourceInstanceId: createHealthCheckSourceInstanceIdV1(preview.data.subject), sourceConfig: preview.data,
            }, { signal: context.signal });
            const draft = HealthCheckSetupInputV1ProtocolSchema.parse(input);
            const sourceInstanceId = createHealthCheckSourceInstanceIdV1(draft.subject);
            const sourceConfig = await context.services.healthChecks.setup({ sourceInstanceId,
                sourceConfig: { ...draft, investigation: draft.investigation ?? { mode: 'inbox' } },
                heartbeatContributionId: 'health-heartbeat', capabilityWebhookContributions: monitorCapabilityContributions }, { signal: context.signal });
            return { v: 1, sourceInstanceId, sourceContractVersion: 1, sourceConfig,
                displayLabel: 'Saved health checks' };
        },
    }, 'health/heartbeat/manage': {
        title: 'Manage heartbeat address', execution: { target: 'daemon' }, scopes: ['global', 'machine'],
        approvalScope: 'healthCheck',
        description: 'Inspect status, rotate or revoke one saved heartbeat. Ask the person to reveal and copy its replacement address in saved-check setup; addresses are never returned here.',
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'writesRemote',
        readOnly: { op: 'eq', path: 'operation', value: 'status' },
        confirmationWhen: { op: 'not', predicate: { op: 'eq', path: 'operation', value: 'status' } },
        confirmation: { title: 'Change this heartbeat address?',
            body: 'Rotation or revocation stops the old address accepting pings. After rotating, reveal the replacement address and update your job.' },
        inputSchema: PluginWebhookHeartbeatManageInputV1ProtocolSchema,
        resultSchema: PluginWebhookHeartbeatManageResultV1ProtocolSchema,
        async run(input: unknown, context: PluginInvocationContext) {
            return context.services.healthChecks.manageHeartbeat(PluginWebhookHeartbeatManageInputV1ProtocolSchema.parse(input),
                { signal: context.signal });
        },
    } },
    webhooks: { ...Object.fromEntries(monitorKinds.map(kind => [monitorDefinitions[kind].webhookContributionId, {
        title: monitorDefinitions[kind].title, verifier: { kind: 'capabilityUrl_v1' as const, routing: 'accountEndpoint' as const },
        handlerAction: { localId: `health/${kind}/receive` },
    }])), 'health-heartbeat': { title: 'Health heartbeat', verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' },
        delivery: 'recordReceiptOnly' } },
    healthCheckKinds: Object.fromEntries([...HEALTH_CHECK_KINDS_V1.map(id => [id, { ...healthKinds[id],
        action: `health/${id}` } satisfies Omit<HealthCheckKindContributionV1, 'id'>]), ...monitorKinds.map(kind => [kind, {
        title: monitorDefinitions[kind].title, configSchema: monitorDefinitions[kind].configSchema.jsonSchema,
        action: `health/${kind}` } satisfies Omit<HealthCheckKindContributionV1, 'id'>])]),
    events: { ...machineOutcomeEvents, ...Object.fromEntries(monitorKinds.map(kind => [monitorDefinitions[kind].observedEventId, { declaration: {
        kind: 'event' as const, title: `${monitorDefinitions[kind].title} observation received`, payloadSchema: monitorObserved.jsonSchema,
    } }])), ...Object.fromEntries(monitorKinds.map(kind => [`watch-${monitorDefinitions[kind].observedEventId}`, {
        declaration: { kind: 'subscription' as const, target: { kind: 'plugin' as const,
            event: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: monitorDefinitions[kind].observedEventId } } },
        // Subscription declarations require activation registration. Delivery
        // work belongs to the observer's disposable subscribeWake lifetime.
        handler() {},
    }])), ...deploymentEvents, ...managedSetupEvents, ...mcpUpdateEvents, ...machinePresenceEvents, ...Object.fromEntries(([
        [HEALTH_STATUS_EVENT, 'healthStatus', 'Health status changed', 'A saved health check failed or recovered.'],
        [HEALTH_CHECK_FAILED_EVENT, 'healthCheckFailed', 'Health check failed', 'A saved health check entered a failed condition.'],
        [HEALTH_CHECK_RECOVERED_EVENT, 'healthCheckRecovered', 'Health check recovered', 'A failed saved health check returned to healthy.'],
    ] as const).map(([id, key, title, description]) => [id, { declaration: { kind: 'event' as const,
        title: { key: `machineServices.events.${key}.title`, fallback: title },
        description: { key: `machineServices.events.${key}.description`, fallback: description },
        payloadSchema: healthTransition.jsonSchema,
        automation: { v: 1, eligible: true, subjectKinds: ['healthCheck', 'environment', 'machine'], source: { sourceContractVersion: 1,
            observationOnly: { kind: 'observationOnly' },
            supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: id === HEALTH_STATUS_EVENT ? HealthCheckSourceConfigV1ProtocolSchema.jsonSchema : savedHealthTransitionSourceSchema.jsonSchema,
            setupActionRef: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: id === HEALTH_STATUS_EVENT ? 'health/setup' : `${id}/setup` },
            ...(id === HEALTH_STATUS_EVENT ? { setupSurface: { renderer: 'health-setup' } } : {}) } },
    } }])) },
    // Machine roles (OWNER-RULINGS 2026-11-12): local service health and events belong to the Deployments role.
    machineRoles: { services: { title: 'Machine services', description: 'Saved health checks and service events on this Machine.', partOf: 'deployments',
        backgroundServices: ['health-observer', ...[...deploymentEventBackgroundServices, ...managedSetupEventBackgroundServices,
            ...mcpUpdateEventBackgroundServices, ...machineOutcomeEventBackgroundServices].map(service => service.declaration.id)] } },
    backgroundServices: [{ declaration: { id: 'health-observer', title: 'Saved health checks', placement: 'daemon' }, runner: runHealthCheckObserver },
        ...deploymentEventBackgroundServices, ...managedSetupEventBackgroundServices, ...mcpUpdateEventBackgroundServices, ...machineOutcomeEventBackgroundServices],
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
