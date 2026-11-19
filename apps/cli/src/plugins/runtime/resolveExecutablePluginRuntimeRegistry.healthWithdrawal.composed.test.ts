import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginEventAutomationSetupResultV1JsonSchema, PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol';
import { AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema } from '@happier-dev/protocol/automations/event';
import { HealthCheckDefinitionV1Schema, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { finiteHealthCheckResult } from '@/deployments/healthChecks/finiteHealthCheckResult';
import { createStablePluginEventsBroker } from './invocation/services/events';

const pluginId = 'example.health-withdrawal';
const machineId = 'machine-health-withdrawal';
const credentials = { token: 'fixture-health-withdrawal', encryption: null } as const;
const configSchema = { type: 'object' } as const;
type SourceRead = ReturnType<typeof AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse>;
function response<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

describe('adopted source health withdrawal through the executable registry', () => {
    it('withdraws deleted service and Domain sources after adoption while retaining an unrelated source', async () => {
        const check = HealthCheckDefinitionV1Schema.parse({ checkId: 'http',
            kind: { pluginId: 'happier.machine.services', localId: 'http' }, binding: { kind: 'healthCheck' },
            config: { endpoint: 'http://127.0.0.1:40797', expectStatus: 200 }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 2 });
        const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: machineId,
            ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge-machine' } });
        const targetLink = createDeploymentTargetLinkHeaderV1({ machines: ['runtime-machine'],
            members: [{ machineId: 'runtime-machine', installationId: 'runtime-installation', state: 'active' }] });
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 });
        const domainCheck = HealthCheckDefinitionV1Schema.parse({ ...check,
            binding: { kind: 'domain', domainId: domain.id, targetLinkId: targetLink.id, condition: 'domain_probe_failed' } });
        const retainedEnvironment = { ...environment, id: 'retained-environment', runtimeTargetLinkId: 'retained-target-link' };
        const retainedTargetLink = { ...targetLink, id: retainedEnvironment.runtimeTargetLinkId, environmentId: retainedEnvironment.id };
        const retainedDomain = { ...domain, id: 'retained-domain', environmentId: retainedEnvironment.id, targetLinkId: retainedTargetLink.id };
        const retainedDomainCheck = HealthCheckDefinitionV1Schema.parse({ ...domainCheck,
            binding: { kind: 'domain', domainId: retainedDomain.id, targetLinkId: retainedTargetLink.id, condition: 'domain_probe_failed' } });
        const configs: readonly HealthCheckSourceConfigV1[] = [
            { v: 1, subject: { kind: 'machineService', machineId, serviceId: 'withdrawn' }, checks: [check] },
            { v: 1, subject: { kind: 'machineService', machineId, serviceId: 'retained' }, checks: [check] },
            { v: 1, subject: { kind: 'environment', environmentId: environment.id }, checks: [domainCheck] },
            { v: 1, subject: { kind: 'environment', environmentId: retainedEnvironment.id }, checks: [retainedDomainCheck] },
        ];
        let withdrawn = false;
        let caller: SourceRead['caller'] | undefined;
        let refresh: (() => Promise<unknown>) | undefined;
        const broker = createStablePluginEventsBroker();
        // Only filesystem credentials and the Home HTTP transport are substituted.
        // Admission, activation, source adoption and both health owners remain real.
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId });
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return response({ id: 'account-health-withdrawal' });
            if (String(url).endsWith('/v1/account/encryption/currentness')) return response({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
            throw new Error(`Unexpected GET ${String(url)}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (!String(url).endsWith(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1)) throw new Error(`Unexpected POST ${String(url)}`);
            const request = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body);
            caller = request.caller;
            return response(AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page',
                revision: withdrawn ? '2' : '1', nextCursor: null,
                eventDeclarationRelease: { release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
                definitions: configs.flatMap((sourceConfig, index) => {
                    if (withdrawn && index !== 1 && index !== 3) return [];
                    const eventRef = { pluginId, localId: 'health-status' };
                    const binding = { v: 1 as const, automationId: `automation-${index}`, triggerId: `trigger-${index}`, triggerRevision: 1,
                        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: `11111111-1111-4111-8111-11111111111${index}` };
                    return [{ automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: 1, eventRef,
                        sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
                        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: request.caller.materialization },
                        payloadSchema: { type: 'object' }, storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                            definition: { v: 1, sourceInstanceId: `source-${index}`, sourceConfig, displayLabel: 'Saved health',
                                filter: null, maximumObservationAgeMs: null } }) }];
                }),
            }));
        });
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            actions: {
                setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: configSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, configSchema), run: () => { throw new Error('No setup'); } },
                reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                    resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema, run: () => { throw new Error('No reset'); } },
            },
            events: { 'health-status': { declaration: { kind: 'event', title: 'Health', payloadSchema: { type: 'object' },
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: configSchema, setupActionRef: { pluginId, localId: 'setup' },
                    historyGapResetActionRef: { pluginId, localId: 'reset' }, connectedAccountPurposeBindings: [] } } } } },
            backgroundServices: [{ declaration: { id: 'observer', title: 'Observer' }, runner: async context => {
                refresh = () => context.services.actions.execute('automation.event.sources.list', {
                    transport: { kind: 'checkpointedPull' }, knownRevision: '1' });
                await new Promise<void>(resolve => {
                    if (context.signal.aborted) resolve();
                    else context.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            } }],
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
            plugins: [{ manifest: plugin.manifest, includeAvailability: true, files: { 'daemon.mjs': 'export function activate() {}' },
                instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            runtimeOptions: { resolveCurrentMachineId: () => machineId, stableEventsBroker: broker,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-health-withdrawal', machineId }),
                scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                    getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false }) } },
        });
        const owner = fixture.registry.projectManagedServices;
        const handles: Array<Awaited<ReturnType<typeof owner.superviseMachine>>> = [];
        try {
            await fixture.registry.startConfiguredActivation();
            await vi.waitFor(() => expect(refresh).toBeTypeOf('function'));
            if (!refresh || !caller) throw new Error('Observer source owner was not initialized');
            const identity = caller;
            const observer = { machineId, installationId: 'installation' };
            for (const [index, serviceId] of ['withdrawn', 'retained'].entries()) {
                const handle = await owner.superviseMachine({ serverId: 'server-health-withdrawal', machineId,
                    watch: { v: 1, watchId: serviceId, name: serviceId, adapter: { pluginId: 'happier.machine.services', localId: 'systemd' },
                        nativeResourceId: `user/${serviceId}.service`, lifecyclePurpose: 'development' },
                    isCurrent: () => true, releaseObservation: async () => {}, lifecycle: {
                        inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }), stop: async () => ({ status: 'stopped' }) } });
                handles.push(handle);
                owner.machineServiceRows.publishHealthResult(handle, { serverId: 'server-health-withdrawal', sourceInstanceId: `source-${index}`,
                    caller: identity.materialization, occurrenceId: identity.occurrenceId,
                    subject: { kind: 'machineService', machineId, serviceId }, generation: handle.instanceId, check,
                    result: finiteHealthCheckResult({ observer, vantage: 'sameMachine' }, 'http', 1000, 995, index === 0 ? 'down' : 'up', {}) });
                expect(owner.machineServiceRows.read(handle).health).toMatchObject({ status: index === 0 ? 'down' : 'up', freshness: 'current' });
            }
            const domainOwner = fixture.registry.currentDomainEdgeObservation;
            if (!domainOwner) throw new Error('Domain health owner is absent');
            domainOwner.publish({ sourceInstanceId: 'source-2', sourceRevision: '1', checkId: domainCheck.checkId, kind: 'http',
                caller: identity.materialization, occurrenceId: identity.occurrenceId, check: domainCheck,
                environment, targetLink, domain, observer, result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 1000, 995, 'up', {}) });
            expect(domainOwner.read(environment.id, targetLink.id)?.status).toBe('up');
            domainOwner.publish({ sourceInstanceId: 'source-3', sourceRevision: '1', checkId: retainedDomainCheck.checkId, kind: 'http',
                caller: identity.materialization, occurrenceId: identity.occurrenceId, check: retainedDomainCheck,
                environment: retainedEnvironment, targetLink: retainedTargetLink, domain: retainedDomain, observer,
                result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 1000, 995, 'up', {}) });
            expect(domainOwner.read(retainedEnvironment.id, retainedTargetLink.id)?.status).toBe('up');
            withdrawn = true;
            broker.publishHostEventEnvelope({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload: {} });
            // Broker listeners run independently. The observer reads/adopts only after delivery.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(await refresh()).toMatchObject({ kind: 'page', revision: '2' });
            expect(fixture.registry.isPluginOccurrenceCurrent(pluginId, identity.occurrenceId)).toBe(true);
            expect(owner.machineServiceRows.read(handles[0]!).health?.status).toBe('unknown');
            expect(owner.machineServiceRows.read(handles[1]!).health?.status).toBe('up');
            expect(domainOwner.read(environment.id, targetLink.id)).toBeNull();
            expect(domainOwner.read(retainedEnvironment.id, retainedTargetLink.id)?.status).toBe('up');
        } finally {
            for (const handle of handles) await handle.dispose();
            await fixture.dispose();
            vi.restoreAllMocks();
        }
    });
});
