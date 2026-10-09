import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { JsonValue } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
    defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerOptionsResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCleanupObservationV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema,
    MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema,
    type MachineProvisionerContributionV1,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { addExecServiceBinding, addConnectedAccountsAvailablePluginInvocationServiceBinding, createPluginInvocationServicesFactory, createLoggerAvailablePluginInvocationServiceBinding, createUnavailablePluginServicesFactory } from '../services/factory';
import { createStablePluginConnectedAccountsHost, type StablePluginConnectedAccountsOwner } from '../services/connectedAccounts';
import { createManagedServiceCredentialFileOwner } from '../services/managedServiceCredentialFileOwner';
import { createPluginInvocationSecretRedactor, type PluginInvocationLogSink } from '../services/logger';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from '../targetActionRegistry';
import type { CreatePluginInvocationServiceBinding } from '../services/types';
import type { PluginInvocationServicesFactoryParams } from '../services/unavailable';

export const pluginId = 'acme.compute';
const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
export const roles = ['acquire', 'bootstrap', 'exec', 'putFile', 'power', 'destroy', 'rebuild'] as const;
export function roleActionId(role: typeof roles[number] | 'reconcile') { return role === 'putFile' ? 'put-file' : role; }
const native = defineProtocolObject({}, { policy: 'closed' });
const nativeOperation = defineProtocolObject({ requestId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
export const nativeOperationValue = { requestId: 'request-1' } as const;
const nativeSchemas = defineMachineProvisionerSchemas({ launch: native, resource: native });
const roleSchemas = {
    check: { input: nativeSchemas.checkInput, result: MachineProvisionerCheckResultProtocolV1Schema },
    options: { input: nativeSchemas.checkInput, result: MachineProvisionerOptionsResultProtocolV1Schema },
    acquire: { input: nativeSchemas.acquireInput, result: nativeSchemas.acquireResult },
    bootstrap: { input: nativeSchemas.bootstrapInput, result: MachineProvisionerBootstrapCarrierV1Schema },
    inspect: { input: nativeSchemas.resourceInput, result: MachineProvisionerObservationV1Schema },
    power: { input: nativeSchemas.powerInput, result: MachineProvisionerPowerResultV1Schema },
    destroy: { input: nativeSchemas.resourceInput, result: MachineProvisionerPowerResultV1Schema },
    rebuild: { input: nativeSchemas.rebuildInput, result: nativeSchemas.rebuildResult },
    exec: { input: nativeSchemas.execInput, result: MachineProvisionerNativeExecResultV1Schema },
    'put-file': { input: nativeSchemas.putFileInput, result: MachineProvisionerPutFileResultV1Schema },
};
function schemasFor(localId: string) { return Object.entries(roleSchemas).find(([id]) => id === localId)?.[1]; }
export function roleInput(localId: string): JsonValue {
    if (localId === 'acquire') return { launch: {} };
    if (localId === 'reconcile' || localId === 'cleanup') return { nativeOperation: nativeOperationValue };
    if (localId === 'exec') return { resource: {}, argv: ['fixture'] };
    if (localId === 'put-file') return { resource: {}, guestPath: '/fixture', bytesBase64: '' };
    if (localId === 'power') return { resource: {}, intent: 'delete' };
    if (localId === 'rebuild') return { resource: {}, reviewedEffectDigest: 'reviewed' };
    return ['bootstrap', 'inspect', 'destroy'].includes(localId) ? { resource: {} } : {};
}
export function roleResult(localId: string): JsonValue {
    if (localId === 'check') return { available: true };
    if (localId === 'options') return { choices: [] };
    if (localId === 'acquire' || localId === 'reconcile' || localId === 'rebuild') return { kind: 'bound', resource: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1, value: {} } };
    if (localId === 'bootstrap') return { kind: 'native', transport: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1 } };
    if (localId === 'inspect') return { observedAt: 0, availability: 'present' };
    if (['power', 'destroy', 'put-file'].includes(localId)) return { kind: 'confirmed' };
    if (localId === 'exec') return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
    return { completed: localId };
}

export function fixture(options: Readonly<{
    cold?: boolean; dangerous?: boolean; privateNative?: boolean;
    nativeCommandArgs?: readonly string[];
    nativePreflightArgs?: readonly string[];
    nativeCommandTimeoutMs?: number;
    nativeTransport?: boolean;
    bootstrapCredential?: 'ssh' | 'native-token';
    nativeCredentialService?: boolean;
    createHostServiceBinding?: CreatePluginInvocationServiceBinding;
    hostServiceAdapters?: Pick<PluginInvocationServicesFactoryParams, 'exec' | 'http' | 'connectedAccounts'>;
    invocationLogSink?: PluginInvocationLogSink;
    reconciliation?: boolean;
    reconciliationResource?: boolean;
    continueAcquire?: boolean;
    cleanupObservation?: { kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string };
    repairAction?: boolean;
    nativeRoleResults?: Partial<Record<typeof roles[number] | 'check' | 'inspect' | 'reconcile', JsonValue>>;
    supportedIntents?: MachineProvisionerContributionV1['retention']['supportedIntents'];
    onInspect?: (input: JsonValue | undefined, context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    onNativeRole?: (role: typeof roles[number] | 'reconcile', input: JsonValue | undefined,
        context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    onOrdinary?: (context: Parameters<TargetActionInvocationRegistration['handler']>[1]) => void | Promise<void>;
    fixtureManifest?: CanonicalPluginManifest;
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
    const reconciliationSchemas = options.reconciliation ? defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native,
        nativeOperation: options.reconciliationResource ? native : nativeOperation }) : null;
    const acquisitionSchemas = options.continueAcquire
        ? defineMachineProvisionerSchemas({ launch: native, resource: native, continueAcquire: true }) : nativeSchemas;
    const repairSchemas = options.repairAction ? {
        input: defineProtocolObject({ machineName: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
        result: defineProtocolObject({ completed: defineProtocolString() }, { policy: 'closed' }),
    } : null;
    const fixtureSchemasFor = (localId: string) => localId === 'reconcile' ? reconciliationSchemas
        : localId === 'cleanup' && reconciliationSchemas ? { input: reconciliationSchemas.cleanupInput, result: MachineProvisionerCleanupObservationV1Schema }
        : localId === 'destroy' && reconciliationSchemas ? { input: reconciliationSchemas.destroyInput, result: MachineProvisionerPowerResultV1Schema }
        : localId === 'acquire' && reconciliationSchemas ? { input: acquisitionSchemas.acquireInput, result: reconciliationSchemas.result }
        : localId === 'ordinary' && repairSchemas ? repairSchemas
        : schemasFor(localId);
    const localIds = options.fixtureManifest?.contributes.actions.map(action => action.id)
        ?? [...roles.map(roleActionId), 'check', 'options', 'inspect', 'ordinary', ...(options.reconciliation ? ['reconcile'] : []), ...(options.cleanupObservation ? ['cleanup'] : [])];
    const dangerLevel = (localId: string) => options.dangerous && !['check', 'options', 'inspect', 'reconcile', 'cleanup'].includes(localId) ? 'writesRemote' as const : 'safe' as const;
    const actions = localIds.map((localId): ResolvedActionContribution => ({
        pluginId, provenance: 'external', source: { kind: 'path' },
        definition: {
            id: localId, title: localId, description: null, kindVersion: 1,
            placements: [], slash: null, bindings: null, examples: null,
            surfaces: { cli: !options.privateNative, plugin: true, ui: false, voice: false, agent: false, mcp: false, rpc: false, api: false },
            inputHints: null, inputSchema: fixtureSchemasFor(localId)?.input.jsonSchema ?? {}, execution: { target: 'daemon' },
            safety: 'safe', dangerLevel: dangerLevel(localId),
        },
    }));
    const registrations = localIds.map((localId): TargetActionInvocationRegistration => ({
        pluginId, pluginVersion: '1.0.0', occurrenceId,
        sourceCustody: createManagedPluginSourceCustody('compute-generation-1'), localId,
        definition: {
            id: localId, dangerLevel: dangerLevel(localId),
            scopes: ['global'], surfaces: options.privateNative ? ['plugin'] : ['cli', 'plugin'],
            inputSchema: fixtureSchemasFor(localId)?.input.jsonSchema,
            resultSchema: fixtureSchemasFor(localId)?.result.jsonSchema,
            ...((options.nativeCommandArgs || options.credentialOwner) ? { hostAccessRequests: [
            ...(options.nativeCommandArgs ? [{ required: true, request: {
                id: 'native-process', capability: 'process', reason: 'Run native bootstrap transport',
                scope: { executables: [{ kind: 'systemTool', id: 'fixture-node' }] },
            } }] as const : []),
            ...(options.credentialOwner ? credentialPurposes.map(({ purpose, service }) => ({ required: true, request: {
                id: purpose, capability: 'connectedAccounts' as const, reason: 'Use captured native account',
                scope: { serviceRefs: [service], operations: ['use' as const], materializationKinds: ['environment' as const] },
            } })) : []),
            ] } : {}),
        },
        handler: async (_input, context) => {
            effects += 1;
            if (localId === 'ordinary') await options.onOrdinary?.(context);
            if (localId === 'cleanup' && options.cleanupObservation) return options.cleanupObservation;
            if (localId === 'check' && options.nativeRoleResults?.check) return options.nativeRoleResults.check;
            if (localId === 'inspect') {
                await options.onInspect?.(_input, context);
                if (options.nativeRoleResults?.inspect) return options.nativeRoleResults.inspect;
            }
            const role = [...roles, ...(options.reconciliation ? ['reconcile' as const] : [])].find((candidate) => roleActionId(candidate) === localId);
            if (role) {
                await options.onNativeRole?.(role, _input, context);
                if (options.nativeRoleResults && role in options.nativeRoleResults) return options.nativeRoleResults[role]!;
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
                schemaVersion: 1, platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
                launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema,
                billing: { location: 'cloud', stoppedBilling: 'unknown' }, retention: { supportedIntents: options.supportedIntents ?? ['delete'] },
                actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', rebuild: 'rebuild' },
                ...(options.nativeTransport === false ? {} : { bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' } }),
                ...(options.bootstrapCredential ? { bootstrapCredential: { kind: options.bootstrapCredential } } : {}),
                ...(options.reconciliation ? { reconciliation: { nativeOperationSchema: (options.reconciliationResource ? native : nativeOperation).jsonSchema, action: 'reconcile',
                    ...(options.continueAcquire ? { continueAcquire: true as const } : {}),
                    ...(options.cleanupObservation ? { cleanup: 'cleanup' } : {}) } } : {}),
            }],
        },
    }));
    const actualRegistrations = registrations.map((registration): TargetActionInvocationRegistration => {
        const action = manifest.contributes.actions.find((candidate) => candidate.id === registration.localId);
        if (!action) throw new Error(`Missing fixture Action ${registration.localId}`);
        return { ...registration, definition: { ...registration.definition,
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
    const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: loadedRegistrations, expectedActions: actualRegistrations,
        readActions: () => loadedRegistrations,
        readCurrentPluginOccurrenceId: () => currentOccurrenceId,
        resolveAuthorizationFacts: (action) => ({
            generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
        }),
        resolveHostBinding: createTargetActionHostBindingResolver(options.credentialOwner || options.nativeCommandArgs || options.nativeCredentialService ? {
            createServiceBinding: options.createHostServiceBinding ?? ((occurrence, id, requests) => {
                const binding = createLoggerAvailablePluginInvocationServiceBinding(occurrence, id);
                const execBinding = options.nativeCommandArgs ? addExecServiceBinding(binding, requests ?? []) : binding;
                return options.credentialOwner ? addConnectedAccountsAvailablePluginInvocationServiceBinding(execBinding) : execBinding;
            }),
        } : undefined),
        createServices(seed, binding) {
            // The real production factory begins this qualified diagnostic
            // scope before constructing services; reproduce that host boundary.
            secretRedactor?.beginInvocation({ pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId }, seed.redactionLifetimeSignal ?? seed.signal);
            return invocationServices(seed, binding);
        },
    });
    const contributes = createResolvedContributionRegistry({
        actions: actions.map((action) => {
            const declaration = manifest.contributes.actions.find((candidate) => candidate.id === action.definition.id)!;
            return { ...action, definition: { ...action.definition,
                inputSchema: declaration.inputSchema, dangerLevel: declaration.dangerLevel,
                surfaces: {
                    cli: declaration.surfaces.includes('cli'), plugin: declaration.surfaces.includes('plugin'),
                    ui: declaration.surfaces.includes('ui'), voice: declaration.surfaces.includes('voice'),
                    agent: declaration.surfaces.includes('agent'), mcp: declaration.surfaces.includes('mcp'),
                    rpc: declaration.surfaces.includes('rpc'), api: declaration.surfaces.includes('api'),
                },
            } };
        }), occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        machineProvisioners: manifest.contributes.machineProvisioners.map((definition) => ({ pluginId, identity: { pluginId, localId: definition.id }, definition })),
        activationTargets: [{ pluginId, manifest, provenance: 'external', source: { kind: 'path' },
            manifestPath: join(fixtureRoot, 'happier-plugin.json'), daemonEntryPath: null, sourceSpec: { kind: 'path', path: fixtureRoot },
        }],
    });
    // Only the native module-loading boundary is substituted. All final
    // invocation, policy admission and handler execution remain real.
    const runtimeRegistry = {
        contributes, targetActionInvocations,
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
        runtimeRegistry, custody, materializedAccounts,
        effects: () => effects, activations: () => activations,
        retire: () => { currentOccurrenceId = createPluginRuntimeOccurrenceId(pluginId); },
    };
}
