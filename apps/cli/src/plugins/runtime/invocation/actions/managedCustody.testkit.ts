import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import type { JsonValue } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
    defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerOptionsResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCleanupObservationV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerResizeResultV1Schema,
    MachineProvisionerNativeExecResultV1Schema, MachineProvisionerNativeStreamResultV1Schema, MachineProvisionerPutFileResultV1Schema,
    MachineProvisionerNativeCredentialApplyResultV1Schema, MachineProvisionerSnapshotResultV1Schema,
    type MachineProvisionerContributionV1,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTargetActionHostBindingResolver, type ResolveTargetActionHostBinding } from '@/plugins/runtime/hostAccess/resolve';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPluginInvocationServicesFactory, createPluginInvocationServiceBinding, createUnavailablePluginServicesFactory } from '../services/factory';
import { createStablePluginConnectedAccountsHost, type StablePluginConnectedAccountsOwner } from '../services/connectedAccounts';
import { createManagedServiceCredentialFileOwner } from '../services/managedServiceCredentialFileOwner';
import { createPluginInvocationSecretRedactor, type PluginInvocationLogSink } from '../services/logger';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from '../targetActionRegistry';
import type { CreatePluginInvocationServiceBinding, CreatePluginInvocationServices } from '../services/types';
import type { PluginInvocationServicesFactoryParams } from '../services/unavailable';
import { roles, roleActionId, managedCustodyDefaultActionIds } from './managedCustody.actionIds.testkit';

export { roles, roleActionId } from './managedCustody.actionIds.testkit';

export const pluginId = 'acme.compute';
const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
type NativeFixtureRole = typeof roles[number] | 'reconcile' | 'snapshot' | 'stream';
const native = defineProtocolObject({}, { policy: 'closed' });
const nativeOperation = defineProtocolObject({ requestId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
export const nativeOperationValue = { requestId: 'request-1' } as const;
// `guest` (optional) names one guest so tests can tell a row's own resource from another's.
const nativeResource = defineProtocolObject({ guest: defineProtocolString({ minLength: 1 }).optional() }, { policy: 'closed' });
const nativeSchemas = defineMachineProvisionerSchemas({ launch: native, resource: nativeResource });
const roleSchemas = {
    check: { input: nativeSchemas.checkInput, result: MachineProvisionerCheckResultProtocolV1Schema },
    options: { input: nativeSchemas.checkInput, result: MachineProvisionerOptionsResultProtocolV1Schema },
    acquire: { input: nativeSchemas.acquireInput, result: nativeSchemas.acquireResult },
    bootstrap: { input: nativeSchemas.bootstrapInput, result: MachineProvisionerBootstrapCarrierV1Schema },
    inspect: { input: nativeSchemas.resourceInput, result: MachineProvisionerObservationV1Schema },
    power: { input: nativeSchemas.powerInput, result: MachineProvisionerPowerResultV1Schema },
    destroy: { input: nativeSchemas.resourceInput, result: MachineProvisionerPowerResultV1Schema },
    rebuild: { input: nativeSchemas.rebuildInput, result: nativeSchemas.rebuildResult },
    resize: { input: nativeSchemas.resizeInput, result: MachineProvisionerResizeResultV1Schema },
    snapshot: { input: nativeSchemas.snapshotInput, result: MachineProvisionerSnapshotResultV1Schema },
    exec: { input: nativeSchemas.execInput, result: MachineProvisionerNativeExecResultV1Schema },
    'put-file': { input: nativeSchemas.putFileInput, result: MachineProvisionerPutFileResultV1Schema },
    stream: { input: nativeSchemas.streamInput, result: MachineProvisionerNativeStreamResultV1Schema },
    'native-credential-apply': { input: nativeSchemas.nativeCredentialApplyInput, result: MachineProvisionerNativeCredentialApplyResultV1Schema },
};
function schemasFor(localId: string) { return Object.entries(roleSchemas).find(([id]) => id === localId)?.[1]; }
export function roleInput(localId: string): JsonValue {
    if (localId === 'acquire') return { launch: {} };
    if (localId === 'reconcile' || localId === 'cleanup') return { nativeOperation: nativeOperationValue };
    if (localId === 'exec') return { resource: {}, argv: ['fixture'] };
    if (localId === 'put-file') return { resource: {}, guestPath: '/fixture', bytesBase64: '' };
    if (localId === 'stream') return { resource: {}, argv: ['fixture'] };
    if (localId === 'power') return { resource: {}, intent: 'delete' };
    if (localId === 'rebuild') return { resource: {}, reviewedEffectDigest: 'reviewed' };
    if (localId === 'resize') return { resource: {}, size: { cpuCores: 2 } };
    return ['bootstrap', 'inspect', 'destroy'].includes(localId) ? { resource: {} } : {};
}
export function roleResult(localId: string): JsonValue {
    if (localId === 'check') return { available: true };
    if (localId === 'options') return { dimensions: { size: [], image: [], location: [], network: [], duration: [] } };
    if (localId === 'acquire' || localId === 'reconcile' || localId === 'rebuild') return { kind: 'bound', resource: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1, value: {} } };
    if (localId === 'bootstrap') return { kind: 'native', transport: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1 } };
    if (localId === 'inspect') return { observedAt: 0, availability: 'present' };
    if (localId === 'snapshot') return { kind: 'confirmed', snapshotId: 'snapshot-1',
        coverage: { rootDisk: true, attachedVolumes: false }, consistency: 'running',
        cost: { kind: 'billed', source: 'https://example.test/snapshot-pricing' } };
    if (['power', 'destroy', 'put-file', 'resize'].includes(localId)) return { kind: 'confirmed' };
    if (localId === 'exec') return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
    if (localId === 'stream') return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } };
    return { completed: localId };
}

export function fixture(options: Readonly<{
    cold?: boolean; dangerous?: boolean; privateNative?: boolean;
    /** Lets a composed caller prove that a host-reviewed child, not plugin surface access, admitted a native role. */
    nativeActionSurfaces?: readonly ('cli' | 'plugin')[];
    nativeCommandArgs?: readonly string[];
    nativePreflightArgs?: readonly string[];
    nativeCommandTimeoutMs?: number;
    nativeTransport?: boolean;
    bootstrapCredential?: 'ssh' | 'native-token';
    nativeCredentialService?: boolean;
    nativeCredentialDelivery?: boolean;
    snapshot?: boolean;
    /** Declare the optional `bootstrapTransport.stream` role. */
    streamRole?: boolean;
    onNativeCredentialApply?: (context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    createHostServiceBinding?: CreatePluginInvocationServiceBinding;
    hostServiceAdapters?: Pick<PluginInvocationServicesFactoryParams, 'exec' | 'http' | 'connectedAccounts'>;
    /** Authored module handlers and production service owners for composed native tests. */
    actionHandlers?: ReadonlyMap<string, TargetActionInvocationRegistration['handler']>;
    createServices?: CreatePluginInvocationServices;
    resolveHostBinding?: ResolveTargetActionHostBinding;
    invocationLogSink?: PluginInvocationLogSink;
    reconciliation?: boolean;
    reconciliationResource?: boolean;
    continueAcquire?: boolean;
    cleanupObservation?: { kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string };
    repairAction?: boolean;
    /** A fixed result, or one computed from the role input (a fixture guest answering commands). */
    nativeRoleResults?: Partial<Record<NativeFixtureRole | 'check' | 'options' | 'inspect', JsonValue | ((input: JsonValue | undefined) => JsonValue)>>;
    supportedIntents?: MachineProvisionerContributionV1['retention']['supportedIntents'];
    platforms?: MachineProvisionerContributionV1['platforms'];
    onInspect?: (input: JsonValue | undefined, context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    onNativeRole?: (role: NativeFixtureRole, input: JsonValue | undefined,
        context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    onAction?: (localId: string, input: JsonValue | undefined,
        context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    onOrdinary?: (context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    fixtureManifest?: CanonicalPluginManifest;
    /** Invoking-process host boundary; placement admission itself remains real. */
    executionRealm?: 'account';
    referenceManifests?: readonly CanonicalPluginManifest[];
    credentialPurposes?: readonly Readonly<{ purpose: string; service: Readonly<{ pluginId: string; localId: string }> }>[];
    afterActivation?: () => void; credentialOwner?: StablePluginConnectedAccountsOwner;
}> = {}) {
    const pluginId = options.fixtureManifest?.id ?? 'acme.compute';
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    let currentOccurrenceId = occurrenceId;
    const fixtureRoot = join(tmpdir(), 'managed-custody-fixture');
    let effects = 0;
    let activations = 0;
    const materializedAccounts: string[] = [];
    const credentialPurposes = options.credentialPurposes ?? [{ purpose: 'upstream', service: { pluginId: 'acme.accounts', localId: 'cloud' } }];
    const reconciliationSchemas = options.reconciliation ? defineMachineProvisionerReconciliationSchemas({ launch: native, resource: nativeResource,
        nativeOperation: options.reconciliationResource ? native : nativeOperation }) : null;
    const acquisitionSchemas = options.continueAcquire
        ? defineMachineProvisionerSchemas({ launch: native, resource: nativeResource, continueAcquire: true }) : nativeSchemas;
    const repairSchemas = options.repairAction ? {
        input: defineProtocolObject({ machineName: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
        result: defineProtocolObject({ completed: defineProtocolString() }, { policy: 'closed' }),
    } : null;
    const fixtureSchemasFor = (localId: string) => localId === 'reconcile' ? reconciliationSchemas
        : localId === 'cleanup' && reconciliationSchemas ? { input: reconciliationSchemas.cleanupInput, result: MachineProvisionerCleanupObservationV1Schema }
        : localId === 'destroy' && reconciliationSchemas ? { input: reconciliationSchemas.destroyInput, result: reconciliationSchemas.destroyResult }
        : localId === 'acquire' && reconciliationSchemas ? { input: acquisitionSchemas.acquireInput, result: reconciliationSchemas.result }
        : localId === 'ordinary' && repairSchemas ? repairSchemas
        : schemasFor(localId);
    const localIds = options.fixtureManifest?.contributes.actions
        .filter(action => options.executionRealm !== 'account' || action.execution?.target === 'account')
        .map(action => action.id)
        ?? [...managedCustodyDefaultActionIds, ...(options.snapshot ? ['snapshot'] : []), ...(options.streamRole ? ['stream'] : []), ...(options.nativeCredentialDelivery ? ['native-credential-apply'] : []), ...(options.reconciliation ? ['reconcile'] : []), ...(options.cleanupObservation ? ['cleanup'] : [])];
    const dangerLevel = (localId: string) => options.dangerous && !['check', 'options', 'inspect', 'reconcile', 'cleanup'].includes(localId) ? 'writesRemote' as const : 'safe' as const;
    const registrations = localIds.map((localId): TargetActionInvocationRegistration => ({
        pluginId, pluginVersion: '1.0.0', occurrenceId,
        sourceCustody: createManagedPluginSourceCustody('compute-generation-1'), localId,
        definition: {
            id: localId, dangerLevel: dangerLevel(localId),
            scopes: ['global'], surfaces: options.nativeActionSurfaces ?? (options.privateNative ? ['plugin'] : ['cli', 'plugin']),
            inputSchema: fixtureSchemasFor(localId)?.input.jsonSchema,
            resultSchema: fixtureSchemasFor(localId)?.result.jsonSchema,
            ...((options.nativeCommandArgs || options.credentialOwner) ? { hostAccessRequests: [
            ...(options.nativeCommandArgs ? [{ required: true, request: {
                id: 'native-process', capability: 'process', reason: 'Run native bootstrap transport',
                scope: { executables: [{ kind: 'systemTool', id: 'fixture-node' }] },
            } }] satisfies NonNullable<TargetActionInvocationRegistration['definition']['hostAccessRequests']> : []),
            ...(options.credentialOwner ? credentialPurposes.map(({ purpose, service }) => ({ required: true, request: {
                id: purpose, capability: 'connectedAccounts' as const, reason: 'Use captured native account',
                scope: { serviceRefs: [service], operations: ['use' as const], materializationKinds: ['environment' as const] },
            } })) : []),
            ] } : {}),
        },
        handler: async (_input, context) => {
            effects += 1;
            await options.onAction?.(localId, _input, context);
            if (localId === 'ordinary') await options.onOrdinary?.(context);
            if (localId === 'native-credential-apply') {
                await options.onNativeCredentialApply?.(context);
                return { kind: 'confirmed' };
            }
            if (localId === 'cleanup' && options.cleanupObservation) return options.cleanupObservation;
            if (localId === 'check' && options.nativeRoleResults?.check) { const result = options.nativeRoleResults.check; return typeof result === 'function' ? result(_input) : result; }
            if (localId === 'options' && options.nativeRoleResults?.options) { const result = options.nativeRoleResults.options; return typeof result === 'function' ? result(_input) : result; }
            if (localId === 'inspect') {
                await options.onInspect?.(_input, context);
                if (options.nativeRoleResults?.inspect) { const result = options.nativeRoleResults.inspect; return typeof result === 'function' ? result(_input) : result; }
            }
            if (localId === 'stream') {
                await options.onNativeRole?.('stream', _input, context);
                return roleResult('stream');
            }
            const role = [...roles, ...(options.snapshot ? ['snapshot' as const] : []), ...(options.reconciliation ? ['reconcile' as const] : [])].find((candidate) => roleActionId(candidate) === localId);
            if (role) {
                await options.onNativeRole?.(role, _input, context);
                if (options.nativeRoleResults && role in options.nativeRoleResults) {
                    const result = options.nativeRoleResults[role]!;
                    return typeof result === 'function' ? result(_input) : result;
                }
            }
            if (options.nativeCommandArgs) {
                if (options.nativePreflightArgs) await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture-node' }, args: options.nativePreflightArgs });
                const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture-node' }, args: options.nativeCommandArgs,
                    ...(options.nativeCommandTimeoutMs === undefined ? {} : { timeoutMs: options.nativeCommandTimeoutMs }),
                }, { outputDelivery: 'invocation' });
                return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
            }
            if (options.credentialOwner) {
                for (const { purpose } of credentialPurposes) {
                    const material = await context.services.connectedAccounts.materialize(purpose, { kind: 'environment', keys: ['TOKEN'] });
                    if (material.kind !== 'environment') throw new Error('Expected environment credential');
                    materializedAccounts.push(material.env.TOKEN!);
                }
            }
            return roleResult(localId);
        },
    }));
    const manifest = options.fixtureManifest ?? normalizePluginManifestV2(createPluginManifestV2Fixture({
        id: pluginId,
        hostAccess: { required: registrations[0]!.definition.hostAccessRequests?.map(({ request }) => request) ?? [] },
        contributes: {
            actions: registrations.map(({ localId, definition }) => ({
                id: localId, title: localId, scopes: definition.scopes, surfaces: definition.surfaces,
                dangerLevel: ['check', 'options', 'inspect', 'reconcile', 'cleanup'].includes(localId) ? 'safe' : definition.dangerLevel,
                ...(definition.dangerLevel === 'safe' ? {} : { confirmation: { title: 'Run native role', body: 'Apply the admitted managed-resource operation' } }),
                execution: { target: 'daemon' }, inputSchema: fixtureSchemasFor(localId)?.input.jsonSchema ?? {}, resultSchema: fixtureSchemasFor(localId)?.result.jsonSchema ?? {},
                ...(definition.hostAccessRequests?.length ? { hostAccess: definition.hostAccessRequests.map(({ request }) => request.id) } : {}),
            })),
            machineProvisioners: [{ id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'virtual-machine',
                schemaVersion: 1, platforms: options.platforms ?? ['darwin', 'linux', 'win32'], prerequisites: [],
                launchSchema: native.jsonSchema, resourceSchema: nativeResource.jsonSchema,
                billing: { location: 'cloud', stoppedBilling: 'unknown' }, retention: { supportedIntents: options.supportedIntents ?? ['delete'] },
                actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', rebuild: 'rebuild', resize: 'resize', ...(options.snapshot ? { snapshot: 'snapshot' } : {}) },
                ...(options.snapshot ? { snapshot: { coverage: { rootDisk: true, attachedVolumes: false },
                    cost: { kind: 'billed', source: 'https://example.test/snapshot-pricing' } } } : {}),
                resize: {
                    cpuCores: { kind: 'supported', requiresRestart: false, changes: 'any' },
                    memoryBytes: { kind: 'supported', requiresRestart: false, changes: 'any' },
                    diskBytes: { kind: 'supported', requiresRestart: false, changes: 'grow-only' },
                },
                ...(options.nativeTransport === false ? {} : { bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file',
                    ...(options.streamRole ? { stream: 'stream' } : {}) } }),
                ...(options.bootstrapCredential ? { bootstrapCredential: { kind: options.bootstrapCredential } } : {}),
                ...(options.nativeCredentialDelivery ? { nativeCredentialDelivery: { apply: 'native-credential-apply',
                    transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true } } : {}),
                ...(options.reconciliation ? { reconciliation: { nativeOperationSchema: (options.reconciliationResource ? native : nativeOperation).jsonSchema, action: 'reconcile',
                    ...(options.continueAcquire ? { continueAcquire: true as const } : {}),
                    ...(options.cleanupObservation ? { cleanup: 'cleanup' } : {}) } } : {}),
            }],
        },
    }));
    const actualRegistrations = registrations.map((registration): TargetActionInvocationRegistration => {
        const action = manifest.contributes.actions.find((candidate) => candidate.id === registration.localId);
        if (!action) throw new Error(`Missing fixture Action ${registration.localId}`);
        const authoredHandler = options.actionHandlers?.get(registration.localId);
        if (options.actionHandlers && !authoredHandler) throw new Error(`Missing authored Action ${registration.localId}`);
        return { ...registration,
            handler: authoredHandler ?? registration.handler,
            definition: { ...registration.definition,
            dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces,
            inputSchema: action.inputSchema, resultSchema: action.resultSchema,
            ...(action.confirmation ? { confirmation: action.confirmation } : {}),
            hostAccessRequests: resolveManifestHostAccessRequests({ manifest, pluginId,
                contribution: { family: 'actions', localId: registration.localId },
                ...(action.hostAccess ? { requestIds: action.hostAccess } : {}),
            }),
        } };
    });
    let loadedRegistrations = options.cold ? [] : actualRegistrations;
    const secretRedactor = options.nativeCredentialService ? createPluginInvocationSecretRedactor() : undefined;
    const invocationServices = options.credentialOwner || options.nativeCommandArgs || options.nativeCredentialService ? createPluginInvocationServicesFactory({
        loggerSink: options.invocationLogSink ?? { write() {} },
        ...(secretRedactor ? { secretRedactor } : {}),
        ...(options.nativeCredentialService ? { managedServiceCredentialFiles: createManagedServiceCredentialFileOwner({ rootDir: join(fixtureRoot, 'private-credentials') }) } : {}),
        ...(options.credentialOwner ? { connectedAccounts: createStablePluginConnectedAccountsHost(options.credentialOwner) } : {}),
        ...(options.nativeCommandArgs ? { exec: {
            resolveExecutable: async () => ({ command: process.execPath, args: [], env: {} }),
            resolvePath: async () => { throw new Error('No native transport cwd'); },
        } } : {}),
        ...options.hostServiceAdapters,
    }) : createUnavailablePluginServicesFactory();
    const targetActionInvocations = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
        actions: loadedRegistrations, expectedActions: actualRegistrations,
        readActions: () => loadedRegistrations,
        readCurrentPluginOccurrenceId: () => currentOccurrenceId,
        resolveAuthorizationFacts: (action) => ({
            generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
        }),
        resolveHostBinding: options.resolveHostBinding ?? createTargetActionHostBindingResolver(options.credentialOwner || options.nativeCommandArgs || options.nativeCredentialService ? {
            createServiceBinding: options.createHostServiceBinding ?? createPluginInvocationServiceBinding,
        } : undefined),
        createServices(seed, binding) {
            if (options.createServices) return options.createServices(seed, binding);
            // The real production factory begins this qualified diagnostic
            // scope before constructing services; reproduce that host boundary.
            secretRedactor?.beginInvocation({ pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId }, seed.redactionLifetimeSignal ?? seed.signal);
            return invocationServices(seed, binding);
        },
    });
    const sourceSpec = { kind: 'path', locator: fixtureRoot, trustPolicy: 'local_trusted', installPolicy: 'link' } as const;
    const manifestPath = join(fixtureRoot, 'happier-plugin.json');
    const bundledPlugins = loadCurrentBundledPluginLocatorResult().loadedPlugins;
    const bundledFixture = options.fixtureManifest !== undefined && bundledPlugins.some(plugin => plugin.pluginId === pluginId);
    const explicitPluginIds = new Set([pluginId, ...(options.referenceManifests ?? []).map(reference => reference.id)]);
    const provenance = bundledFixture ? 'first_party' : 'external';
    const contributes = createResolvedContributionRegistry({
        ...projectLoadedPluginContributes({ loadResult: { loadedPlugins: [{
            pluginId, pluginRootPath: fixtureRoot, manifestPath, manifest, sourceSpec,
            daemonEntryPath: null, devDaemonEntryPath: null,
        }, ...(options.referenceManifests ?? []).map(reference => {
            const pluginRootPath = join(fixtureRoot, reference.id);
            return { pluginId: reference.id, pluginRootPath, manifest: reference,
                manifestPath: join(pluginRootPath, 'plugin.json'),
                sourceSpec: { ...sourceSpec, locator: pluginRootPath },
                daemonEntryPath: null, devDaemonEntryPath: null };
        }), ...(bundledFixture ? bundledPlugins.filter(plugin => !explicitPluginIds.has(plugin.pluginId)) : [])],
            diagnosticsByPluginId: {} }, provenance }),
        occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        activationTargets: [{ pluginId, manifest, provenance, source: { kind: 'path' },
            manifestPath, daemonEntryPath: null, sourceSpec,
        }],
    });
    // Only the native module-loading boundary is substituted. All final
    // invocation, policy admission and handler execution remain real.
    const runtimeRegistry = {
        contributes, targetActionInvocations,
        ...(options.executionRealm ? { executionRealm: options.executionRealm } : {}),
        // The daemon's placement resolver is a host/environment boundary.
        resolveCurrentPluginApprovalReplayPlacement: async () => ({ serverId: 'home-1', machineId: 'controller-1' }),
        readPluginOccurrenceId: () => currentOccurrenceId,
        activateContributionsOnDemand: async () => {
            activations += 1;
            loadedRegistrations = actualRegistrations;
            targetActionInvocations.refresh();
            options.afterActivation?.();
            return [];
        },
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const custody = {
        managedId: 'managed-1', homeId: 'home-1', intentRevision: 3,
        controller: { machineId: 'controller-1', installationId: 'installation-1' },
        contribution: { pluginId, localId: manifest.contributes.machineProvisioners[0]!.id, occurrenceId },
        role: 'acquire' as const, isCurrent: () => true,
    };
    return {
        runtimeRegistry, targetActionInvocations, custody, materializedAccounts, manifest,
        effects: () => effects, activations: () => activations,
        retire: () => { currentOccurrenceId = createPluginRuntimeOccurrenceId(pluginId); },
    };
}
