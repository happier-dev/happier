import { randomBytes } from 'node:crypto';
import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { Buffer } from 'node:buffer';
import { isAbsolute, join } from 'node:path';
import { isWorkspacePathWithin } from '@/daemon/local/services/inventory/provenance';
import { createPrivateBearerCredential, replacePrivateBearerFile } from '@/daemon/privateBearerFile';
import {
    WorkspaceRefV1Schema,
    type WorkspaceRefV1,
} from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
    ProjectServiceDeclarationRefV1Schema,
    type ProjectServiceDeclarationRefV1,
    type LocalServiceActionTargetV1,
} from '@happier-dev/protocol/local/services/actions/v1';
import {
    RequesterWorkAttributionV1Schema,
    type RequesterWorkAttributionV1,
} from '@/daemon/lifecycle/requesterWorkAttribution';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    AgentProviderBindingMaterializationV1,
    ManagedExecutableRef,
} from '@happier-dev/protocol';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { managedServiceEndpointHostPolicyForMode, readManagedServiceEndpointUrl } from '@happier-dev/protocol/plugins/managedServiceEndpointUrl';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1 } from '@happier-dev/protocol/providers/capabilities/v1';
import { normalizeProviderPublicHeaders } from '@happier-dev/protocol/providers/credential-headers';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type {
    ManagedDependenciesService,
    ManagedServiceCredentialBinding,
    ManagedServiceHandle,
    ManagedServiceRequest,
    ManagedServiceResponse,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
    ManagedServiceNativeInstanceV1,
    ManagedServiceNativeLifecycleV1,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ExecService,
    PluginExecSpawnRequest,
} from '@happier-dev/plugin-sdk/exec';

import {
    type ManagedServiceProcessCredential,
    type ManagedServiceProcessHealthHeaderLease,
    type ManagedServiceProcessHandle,
    type ManagedServiceProcessSnapshot,
    type ManagedServiceProcessSpec,
    type ManagedServiceProcessSupervisorHost,
    type ProjectManagedServiceLaunchAuthorizer,
    readManagedServiceProcessCredentialRedactionValues,
} from './managedProcessSupervisor';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import type { ResolvedPluginExecutable } from './exec';
import {
    normalizeManagedServiceHealthyWaitTimeout,
    normalizeManagedServiceSpec,
    MANAGED_SERVICE_NUMERIC_CONTRACT,
    type NormalizedManagedServiceSpec,
} from './managedServiceSpecNormalization';
import type {
    ManagedProviderEndpointAccessProjection,
    ManagedProviderEndpointPath,
    ManagedProviderRuntimeInvocationBinding,
    ManagedServiceCredentialFileCleanup,
    ManagedServicesInvocationBindingContext,
    ManagedServicesInvocationOwner,
} from './managedServicesAdapter';
import type {
    DeclaredPluginSecretReadPort,
    DeclaredPluginSecretReadResult,
} from '../../context/secrets';
import {
    createRunnerManagedProviderBindingLaunchEnvironmentTransformer,
} from '@/agent/runtime/session/process/runnerManagedProviderBindingMaterialization';

type ManagedServicesScope = Readonly<{
    occurrenceId: string;
    sourceCustody?: PluginSourceCustodyV1;
    pluginId: string;
    contributionQualifiedId: string;
    sessionId?: string;
    operationId?: string;
    independentInvocation?: true;
    signal?: AbortSignal;
    declaredSecretReadPort?: DeclaredPluginSecretReadPort;
    isOccurrenceCurrent(): boolean;
}>;

export type ProjectManagedServiceWitness = Readonly<{
    workspace: WorkspaceRefV1;
    declaration: ProjectServiceDeclarationRefV1;
    cwd: string;
    requester: RequesterWorkAttributionV1;
    serviceId: string;
}>;
export type ProjectManagedServiceHandle = ManagedServiceHandle & ProjectManagedServiceWitness & Readonly<{
    instanceId: string;
    endpointKind: NonNullable<LocalServiceLaunchTargetV1['endpointKind']>;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
}>;
export type ProjectManagedServiceSupervisionInput = ProjectManagedServiceWitness & Readonly<{
    specIdentity: string;
    signal?: AbortSignal;
    isCurrent(): boolean;
    processSpec: Readonly<{
        mode: Extract<ManagedServiceProcessSpec['mode'], { kind: 'managedSpawn' | 'native' }>;
        startupTimeoutMs?: number;
        watchdog?: ManagedServiceProcessSpec['watchdog'];
        healthCheck?: Extract<NonNullable<ManagedServiceProcessSpec['healthCheck']>, { kind: 'http' }>;
    }>;
    authorizeLaunch: ProjectManagedServiceLaunchAuthorizer;
}>;
export type ProjectServiceAccessLossResult = ProjectManagedServiceWitness & (
    | Readonly<{ status: 'cancelled_preparation'; instanceId: null }>
    | Readonly<{
        status: 'stopped' | 'unsupported' | 'termination_incomplete';
        instanceId: string | null;
        snapshot: ManagedServiceSnapshot | null;
    }>
);
export type ProjectManagedServiceResolution =
    | Readonly<{ status: 'found'; handle: ProjectManagedServiceHandle }>
    | Readonly<{ status: 'unknown' | 'mismatch' }>;
type ProjectManagedServicesScope = Readonly<{
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean;
    sessionId?: never;
    operationId?: never;
    pluginId?: never;
    contributionQualifiedId?: never;
}>;

type ValidatedManagedServiceClientAccess =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'hostBearer';
        injectEnvironmentKey: string;
        headerName: string;
        scheme: 'Bearer';
    }>
    | Readonly<{
        kind: 'hostBasic';
        username: string;
        injectPasswordEnvironmentKey: string;
    }>
    | Readonly<{
        kind: 'declaredSecretBasic';
        username: string;
        passwordSecretId: string;
        /** Exact `new URL(normalizedAttachUrl).origin` credential scope. */
        canonicalOrigin: string;
    }>;

export type ResolveDeclaredManagedServiceSecret = (query: Readonly<{
    scope: ManagedServicesScope;
    secretId: string;
    canonicalOrigin: string;
    signal?: AbortSignal;
}>) => Promise<DeclaredPluginSecretReadResult | null>;

const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MANAGED_SERVICE_REQUEST_METHODS = new Set([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
]);
const MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_MANAGED_SERVICE_REQUEST_HEADERS = 64;
const MAX_MANAGED_SERVICE_REQUEST_HEADER_BYTES = 64 * 1024;
const MAX_MANAGED_SERVICE_RESPONSE_HEADERS = 128;
const MAX_MANAGED_SERVICE_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_MANAGED_SERVICE_RESPONSE_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MANAGED_SERVICE_REQUEST_TIMEOUT_MS = 300_000;

export function projectManagedServiceSpawnEnvironmentKeys(
    spec: ManagedServiceSpec,
): readonly string[] {
    if (spec.mode.kind !== 'spawn') return Object.freeze([]);
    const environmentKeys = new Set(Object.keys(spec.mode.launch.env ?? {}));
    if (
        spec.mode.endpoint.kind === 'assignAndInject'
        && spec.mode.endpoint.inject
    ) {
        const injection = spec.mode.endpoint.inject;
        if (injection.portEnvironmentKey) {
            environmentKeys.add(injection.portEnvironmentKey);
        }
        if (injection.baseUrlEnvironmentKey) {
            environmentKeys.add(injection.baseUrlEnvironmentKey);
        }
    }
    if (spec.clientAccess?.kind === 'hostBearer') {
        environmentKeys.add(spec.clientAccess.injectEnvironmentKey);
    } else if (spec.clientAccess?.kind === 'hostBasic') {
        environmentKeys.add(spec.clientAccess.injectPasswordEnvironmentKey);
    }
    if ('requestAuth' in spec && spec.requestAuth) {
        environmentKeys.add(spec.requestAuth.injectEnvironmentKey);
    }
    for (const binding of spec.credentialBindings ?? []) {
        if (binding.injection.kind === 'environment') {
            for (const key of Object.values(
                binding.injection.targetEnvironmentKeysByMaterializedKey,
            )) {
                environmentKeys.add(key);
            }
        } else if (binding.injection.kind === 'files') {
            for (const target of Object.values(
                binding.injection.pathsByFileId,
            )) {
                environmentKeys.add(target.environmentKey);
            }
        }
    }
    return Object.freeze([...environmentKeys].sort());
}

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function translateError(error: unknown): never {
    if (!isPluginError(error)) {
        return fail(
            'plugin_managed_service_establishment_failed',
            'Managed service establishment failed',
        );
    }
    const code = (() => {
        if (
            error.code.startsWith('plugin_managed_service_')
            || error.code === 'plugin_managed_server_termination_incomplete'
            || error.code === 'plugin_operation_aborted'
        ) return error.code;
        switch (error.code) {
            case 'plugin_managed_server_id_invalid':
            case 'plugin_managed_server_endpoint_invalid':
            case 'plugin_managed_server_endpoint_denied':
            case 'plugin_managed_server_health_invalid':
            case 'plugin_managed_server_watchdog_invalid':
            case 'plugin_managed_server_timeout_invalid':
                return 'plugin_managed_service_spec_invalid';
            case 'plugin_managed_server_health_timeout':
                return 'plugin_managed_service_health_timeout';
            case 'plugin_managed_server_aborted':
                return 'plugin_operation_aborted';
            default:
                return 'plugin_managed_service_establishment_failed';
        }
    })();
    if (code === 'plugin_managed_service_establishment_failed') {
        return fail(
            code,
            'Managed service establishment failed',
        );
    }
    throw new PluginError({
        code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
    });
}

function flattenManagedServiceCleanupFailures(
    failures: readonly unknown[],
): PluginError[] {
    const flattened: PluginError[] = [];
    const append = (failure: unknown): void => {
        if (failure instanceof AggregateError) {
            for (const nested of failure.errors) append(nested);
            return;
        }
        flattened.push(new PluginError({
            code: 'plugin_managed_service_establishment_failed',
            message: 'Managed service cleanup failed',
        }));
    };
    for (const failure of failures) append(failure);
    return flattened;
}

function managedServiceCleanupAggregate(
    failures: readonly unknown[],
    message: string,
): AggregateError & Readonly<{ code: string }> {
    return Object.assign(new AggregateError(
        flattenManagedServiceCleanupFailures(failures),
        message,
    ), {
        code: 'plugin_managed_service_establishment_failed',
    });
}

function specInvalid(message: string): never {
    return fail('plugin_managed_service_spec_invalid', message);
}

function stableJson(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
}

function canonicalSpecIdentity(spec: ManagedServiceSpec): string {
    const healthCheck = spec.healthCheck?.kind === 'none'
        ? undefined
        : spec.healthCheck;
    if (spec.mode.kind === 'attach') {
        let baseUrl = spec.mode.baseUrl;
        try {
            baseUrl = new URL(baseUrl).toString().replace(/\/$/u, '');
        } catch {
            // The process mechanic returns the stable public validation error.
        }
        return stableJson({
            ...spec,
            mode: { ...spec.mode, baseUrl },
            healthCheck,
        });
    }
    if (spec.mode.kind === 'native') {
        return stableJson({ ...spec, healthCheck });
    }
    const endpoint = spec.mode.endpoint;
    return stableJson({
        ...spec,
        mode: {
            ...spec.mode,
            launch: {
                ...spec.mode.launch,
                args: spec.mode.launch.args ?? [],
                env: spec.mode.launch.env ?? {},
            },
            endpoint: endpoint.kind === 'assignAndInject'
                ? {
                    ...endpoint,
                    host: endpoint.host ?? '127.0.0.1',
                }
                : endpoint,
        },
        healthCheck,
    });
}

function assertScopeCurrent(scope: ManagedServicesScope): void {
    if (scope.signal?.aborted || !scope.isOccurrenceCurrent()) {
        fail(
            'plugin_managed_service_unavailable',
            'Managed-service invocation authority is no longer current',
        );
    }
}

function readsCurrent(check: () => boolean): boolean {
    try {
        return check() === true;
    } catch {
        return false;
    }
}

function assertManagedProviderCurrent(
    binding: ManagedProviderRuntimeInvocationBinding | null,
): asserts binding is ManagedProviderRuntimeInvocationBinding {
    if (
        !binding
        || binding.realm !== 'managedProviderStart'
        || binding.providerLocalId.trim().length === 0
        || !readsCurrent(binding.isCurrent)
    ) {
        fail(
            'plugin_managed_service_unavailable',
            'Managed Provider invocation authority is unavailable',
        );
    }
}

function assertCanonicalName(
    value: unknown,
    kind: 'environment' | 'header' | 'file',
): asserts value is string {
    if (
        typeof value !== 'string'
        || value.length < 1
        || value.length > 256
        || value !== value.trim()
        || (kind === 'environment'
            && !ENVIRONMENT_KEY_PATTERN.test(value))
        || (kind === 'header'
            && !HTTP_HEADER_NAME_PATTERN.test(value))
    ) {
        specInvalid(`Managed-service ${kind} materialization name is invalid`);
    }
}

function assertUniqueNames(
    values: readonly string[],
    kind: 'environment' | 'header' | 'file',
): readonly string[] {
    if (values.length < 1 || values.length > 32) {
        return specInvalid(
            `Managed-service ${kind} materialization must request between 1 and 32 names`,
        );
    }
    const seen = new Set<string>();
    for (const value of values) {
        assertCanonicalName(value, kind);
        const identity = kind === 'header'
            ? value.toLowerCase()
            : value;
        if (seen.has(identity)) {
            return specInvalid(
                `Managed-service ${kind} materialization names must be unique`,
            );
        }
        seen.add(identity);
    }
    return values;
}

function assertExactRecordKeys(
    record: Readonly<Record<string, unknown>>,
    requested: readonly string[],
    kind: 'environment' | 'header' | 'file',
): void {
    const actual = Object.keys(record);
    if (actual.length !== requested.length) {
        return specInvalid(
            `Managed-service ${kind} materialization returned a partial shape`,
        );
    }
    const actualIdentities = new Set(actual.map((value) => (
        kind === 'header' ? value.toLowerCase() : value
    )));
    for (const requestedName of requested) {
        const identity = kind === 'header'
            ? requestedName.toLowerCase()
            : requestedName;
        if (!actualIdentities.has(identity)) {
            return specInvalid(
                `Managed-service ${kind} materialization returned a mismatched shape`,
            );
        }
    }
}

type ValidatedCredentialBinding = Readonly<{
    binding: ManagedServiceCredentialBinding;
    requestedNames: readonly string[];
}>;

type ValidatedRequestAuth = Readonly<{
    capabilityPath: string;
    injectEnvironmentKey: string;
    isCurrent(): boolean;
}>;

function validateRequestAuth(
    spec: ManagedServiceSpec,
    context: ManagedServicesInvocationBindingContext,
): ValidatedRequestAuth | null {
    if (!('requestAuth' in spec)) return null;
    const requestAuth = spec.requestAuth;
    if (requestAuth === undefined) return null;
    if (
        typeof requestAuth !== 'object'
        || (requestAuth.kind !== 'connectedAccountCapabilityPath'
            && requestAuth.kind !== 'connectedAccountConsumerAccessPath')
        || Object.keys(requestAuth).length !== 2
        || !Object.hasOwn(requestAuth, 'kind')
        || !Object.hasOwn(requestAuth, 'injectEnvironmentKey')
    ) {
        return specInvalid(
            'Managed-service request-auth declaration is invalid',
        );
    }
    assertCanonicalName(
        requestAuth.injectEnvironmentKey,
        'environment',
    );
    if (spec.mode.kind !== 'spawn') {
        return specInvalid(
            'Attached services cannot receive request-auth capability paths',
        );
    }
    assertManagedProviderCurrent(context.managedProvider);
    const binding = context.requestAuth;
    if (
        !binding
        || binding.realm !== 'managedProviderStart'
        || binding.requestAuthUses.length === 0
        || typeof binding.capabilityPath !== 'string'
        || binding.capabilityPath.length === 0
        || binding.capabilityPath !== binding.capabilityPath.trim()
        || binding.capabilityPath.includes('\0')
        || !isAbsolute(binding.capabilityPath)
        || !binding.isCurrent()
    ) {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed Provider request-auth capability authority is unavailable',
        );
    }
    return Object.freeze({
        capabilityPath: binding.capabilityPath,
        injectEnvironmentKey: requestAuth.injectEnvironmentKey,
        isCurrent: () => binding.isCurrent(),
    });
}

function assertRequestAuthCurrent(
    requestAuth: ValidatedRequestAuth | null,
): void {
    if (requestAuth && !requestAuth.isCurrent()) {
        fail(
            'plugin_managed_service_unavailable',
            'Managed Provider request-auth capability authority is no longer current',
        );
    }
}

function validateCredentialBindings(
    spec: ManagedServiceSpec,
    requestAuth: ValidatedRequestAuth | null,
    context: ManagedServicesInvocationBindingContext,
): readonly ValidatedCredentialBinding[] {
    const bindings = spec.credentialBindings ?? [];
    if (bindings.length > 0 && spec.durableLog?.enabled === true) {
        return specInvalid(
            'Credential-bearing managed services cannot enable durable logging',
        );
    }
    const environmentDestinations = new Set<string>();
    const headerDestinations = new Set<string>();
    const addEnvironmentDestination = (value: string): void => {
        assertCanonicalName(value, 'environment');
        // Windows environment names are case-insensitive. Keep one portable
        // ownership identity so an author key cannot shadow a host injection
        // only on that platform.
        const normalized = value.toUpperCase();
        if (environmentDestinations.has(normalized)) {
            specInvalid(
                'Managed-service environment injection destinations must be unique',
            );
        }
        environmentDestinations.add(normalized);
    };
    const addHeaderDestination = (value: string): void => {
        assertCanonicalName(value, 'header');
        const normalized = value.toLowerCase();
        if (headerDestinations.has(normalized)) {
            specInvalid(
                'Managed-service HTTP header injection destinations must be unique',
            );
        }
        headerDestinations.add(normalized);
    };
    if (spec.mode.kind === 'spawn') {
        for (const key of Object.keys(spec.mode.launch.env ?? {})) {
            addEnvironmentDestination(key);
        }
        if (spec.mode.endpoint.kind === 'assignAndInject') {
            const injection = spec.mode.endpoint.inject;
            if (injection?.portEnvironmentKey) {
                addEnvironmentDestination(
                    injection.portEnvironmentKey,
                );
            }
            if (injection?.baseUrlEnvironmentKey) {
                addEnvironmentDestination(
                    injection.baseUrlEnvironmentKey,
                );
            }
        }
    }
    if (spec.clientAccess?.kind === 'hostBearer') {
        addEnvironmentDestination(
            spec.clientAccess.injectEnvironmentKey,
        );
        addHeaderDestination(spec.clientAccess.headerName);
    } else if (spec.clientAccess?.kind === 'hostBasic') {
        addEnvironmentDestination(
            spec.clientAccess.injectPasswordEnvironmentKey,
        );
        addHeaderDestination('authorization');
    } else if (spec.clientAccess?.kind === 'declaredSecretBasic') {
        // An attached server is not this host's child, so there is no
        // environment destination — only the request/health authorization
        // header the host renders from the user's own secret.
        addHeaderDestination('authorization');
    }
    if (requestAuth) {
        addEnvironmentDestination(
            requestAuth.injectEnvironmentKey,
        );
    }
    if (spec.healthCheck?.kind === 'http') {
        for (const name of Object.keys(
            spec.healthCheck.headers ?? {},
        )) {
            addHeaderDestination(name);
        }
    }
    const out: ValidatedCredentialBinding[] = [];
    if (bindings.length === 0) return Object.freeze(out);
    for (const binding of bindings) {
        const request = binding.request;
        const injection = binding.injection;
        if (request.kind === 'environment') {
            const names = assertUniqueNames(
                request.keys,
                'environment',
            );
            if (injection.kind !== 'environment') {
                return specInvalid(
                    'Environment materialization requires environment injection',
                );
            }
            if (spec.mode.kind === 'attach') {
                return specInvalid(
                    'Attached services cannot receive environment credentials',
                );
            }
            assertExactRecordKeys(
                injection.targetEnvironmentKeysByMaterializedKey,
                names,
                'environment',
            );
            for (const destination of Object.values(
                injection.targetEnvironmentKeysByMaterializedKey,
            )) {
                addEnvironmentDestination(destination);
            }
            out.push(Object.freeze({ binding, requestedNames: names }));
            continue;
        }
        if (request.kind === 'files') {
            const names = assertUniqueNames(request.fileIds, 'file');
            if (injection.kind !== 'files') {
                return specInvalid(
                    'File materialization requires file injection',
                );
            }
            if (spec.mode.kind === 'attach') {
                return specInvalid(
                    'Attached services cannot receive credential files',
                );
            }
            assertExactRecordKeys(
                injection.pathsByFileId,
                names,
                'file',
            );
            for (const destination of Object.values(
                injection.pathsByFileId,
            )) {
                addEnvironmentDestination(destination.environmentKey);
            }
            out.push(Object.freeze({ binding, requestedNames: names }));
            continue;
        }
        const names = assertUniqueNames(
            request.headerNames,
            'header',
        );
        if (injection.kind !== 'httpHeaders') {
            return specInvalid(
                'HTTP-header materialization requires HTTP-header injection',
            );
        }
        if (
            injection.target === 'providerRequests'
            || injection.target === 'healthAndProviderRequests'
        ) {
            if (spec.mode.kind !== 'spawn') {
                return specInvalid(
                    'Provider-request credentials require a managed Provider spawn',
                );
            }
            assertManagedProviderCurrent(context.managedProvider);
        }
        if (
            injection.target !== 'providerRequests'
            && spec.healthCheck?.kind !== 'http'
        ) {
            return specInvalid(
                'Health-request credentials require an HTTP health check',
            );
        }
        for (const destination of names) {
            addHeaderDestination(destination);
        }
        out.push(Object.freeze({ binding, requestedNames: names }));
    }
    return Object.freeze(out);
}

function validateClientAccess(
    spec: ManagedServiceSpec,
    scope: ManagedServicesScope,
    context: ManagedServicesInvocationBindingContext,
    custodyOwner: ManagedServiceProcessSupervisorHost['custodyOwner'],
): ValidatedManagedServiceClientAccess {
    const access = spec.clientAccess;
    if (!access || access.kind === 'none') {
        return Object.freeze({ kind: 'none' });
    }
    if (access.kind === 'hostBearer') {
        if (spec.mode.kind !== 'spawn') {
            return specInvalid(
                'Host-bearer client access requires a managed Provider spawn',
            );
        }
        assertManagedProviderCurrent(context.managedProvider);
        return Object.freeze({ ...access });
    }
    if (access.kind === 'declaredSecretBasic') {
        // Mirror image of the host-minted kinds: a credential the host mints
        // only means something to a process the host started, and a credential
        // the *user* recorded only means something to a server the user runs.
        if (spec.mode.kind !== 'attach') {
            return specInvalid(
                'Declared-secret Basic client access requires an attached service',
            );
        }
        if (
            typeof access.passwordSecretId !== 'string'
            || access.passwordSecretId.length < 1
            || access.passwordSecretId.length > 256
            || !SECRET_ID_PATTERN.test(access.passwordSecretId)
        ) {
            return specInvalid(
                'Declared-secret Basic password secret id is invalid',
            );
        }
        const username = access.username ?? '';
        if (
            typeof username !== 'string'
            || username.length > 256
            || username !== username.trim()
            || username.includes(':')
            || CONTROL_CHARACTER_PATTERN.test(username)
        ) {
            return specInvalid('Declared-secret Basic username is invalid');
        }
        const endpoint = readManagedServiceEndpointUrl(spec.mode.baseUrl, {
            hostPolicy: 'userDeclaredAttach',
        });
        if (!endpoint.ok) {
            return specInvalid(
                'Declared-secret Basic client access requires a valid attached endpoint',
            );
        }
        return Object.freeze({
            kind: 'declaredSecretBasic' as const,
            username,
            passwordSecretId: access.passwordSecretId,
            canonicalOrigin: new URL(endpoint.endpoint.baseUrl).origin,
        });
    }
    if (spec.mode.kind !== 'spawn') {
        return specInvalid(
            'Host-Basic client access requires an owned spawn',
        );
    }
    // Host-Basic is a host-minted secret the custody owner both generates and
    // holds; it is never disclosed to the plugin. Under Session-runner custody
    // the minting process is the runner, so the credential is only meaningful
    // inside an exact Session lifecycle scope. Under daemon custody the daemon
    // mints, holds and attaches it itself — the same trust boundary host-bearer
    // already relies on above — but its credential must still belong to an
    // exact operation. A occurrenceId only bounds that operation; it is not
    // credential custody by itself.
    if (custodyOwner === 'sessionRunner' && !scope.sessionId) {
        return specInvalid(
            'Host-Basic client access requires an exact Session lifecycle scope',
        );
    }
    if (custodyOwner === 'daemon' && !scope.operationId) {
        return specInvalid(
            'Host-Basic client access requires an exact daemon operation lifecycle scope',
        );
    }
    if (
        typeof access.username !== 'string'
        || access.username.length < 1
        || access.username.length > 256
        || access.username !== access.username.trim()
        || access.username.includes(':')
        || CONTROL_CHARACTER_PATTERN.test(access.username)
    ) {
        return specInvalid('Host-Basic username is invalid');
    }
    if (
        typeof access.injectPasswordEnvironmentKey !== 'string'
        || access.injectPasswordEnvironmentKey.length < 1
        || access.injectPasswordEnvironmentKey.length > 128
        || access.injectPasswordEnvironmentKey
            !== access.injectPasswordEnvironmentKey.trim()
        || !ENVIRONMENT_KEY_PATTERN.test(
            access.injectPasswordEnvironmentKey,
        )
    ) {
        return specInvalid(
            'Host-Basic password environment destination is invalid',
        );
    }
    return Object.freeze({ ...access });
}

function renderHostClientCredential(
    access: ValidatedManagedServiceClientAccess,
    value: string,
): ManagedServiceProcessCredential | undefined {
    if (access.kind === 'none') return undefined;
    if (access.kind === 'declaredSecretBasic') {
        return Object.freeze({
            httpHeader: Object.freeze({
                name: 'authorization',
                value: `Basic ${Buffer.from(
                    `${access.username}:${value}`,
                    'utf8',
                ).toString('base64')}`,
            }),
        });
    }
    if (access.kind === 'hostBasic') {
        return Object.freeze({
            environment: Object.freeze({
                name: access.injectPasswordEnvironmentKey,
                value,
            }),
            httpHeader: Object.freeze({
                name: 'authorization',
                value: `Basic ${Buffer.from(
                    `${access.username}:${value}`,
                    'utf8',
                ).toString('base64')}`,
            }),
        });
    }
    return Object.freeze({
        environment: Object.freeze({
            name: access.injectEnvironmentKey,
            value,
        }),
        httpHeader: Object.freeze({
            name: access.headerName,
            value: `${access.scheme} ${value}`,
        }),
    });
}

function createHostClientCredential(
    access: ValidatedManagedServiceClientAccess,
): ManagedServiceProcessCredential | undefined {
    if (access.kind === 'declaredSecretBasic') return undefined;
    return renderHostClientCredential(
        access,
        createPrivateBearerCredential(),
    );
}

/**
 * Resolves the one credential an attached service can be authenticated with.
 *
 * A present lease with an absent or empty value is the unauthenticated case.
 * A missing lease means its custody authority is unavailable and must fail
 * closed. The static process shape remains credential-free while the owner
 * still resolves the declared secret again before each health or exact-handle
 * request.
 */
type ResolvedDeclaredClientCredential = Readonly<{
    credential: ManagedServiceProcessCredential | undefined;
    environmentValue?: string;
    isCurrent?: DeclaredPluginSecretReadResult['isCurrent'];
}>;

async function resolveDeclaredClientCredential(
    access: ValidatedManagedServiceClientAccess,
    scope: ManagedServicesScope,
    resolveDeclaredSecret: ResolveDeclaredManagedServiceSecret | undefined,
    signal: AbortSignal | undefined,
): Promise<ResolvedDeclaredClientCredential> {
    if (access.kind !== 'declaredSecretBasic') {
        return Object.freeze({ credential: createHostClientCredential(access) });
    }
    if (!resolveDeclaredSecret) {
        return fail(
            'plugin_managed_service_unavailable',
            'Declared-secret client access is unavailable',
        );
    }
    const secret = await resolveDeclaredSecret({
        scope,
        secretId: access.passwordSecretId,
        canonicalOrigin: access.canonicalOrigin,
        ...(signal ? { signal } : {}),
    });
    if (secret === null) {
        return fail(
            'plugin_managed_service_unavailable',
            'Declared-secret client access is unavailable',
        );
    }
    return Object.freeze({
        credential: typeof secret.value === 'string' && secret.value.length > 0
            ? renderHostClientCredential(access, secret.value)
            : undefined,
        ...(typeof secret.value === 'string' && secret.value.length > 0
            ? { environmentValue: secret.value }
            : {}),
        isCurrent: secret.isCurrent,
    });
}

function translateHealthCheck(
    value: NormalizedManagedServiceSpec['healthCheck'],
    credentialHeaders: Readonly<Record<string, string>>,
    clientCredentialHeader:
        | Readonly<{ name: string; value: string }>
        | undefined,
    resolveHealthHeaders:
        | ((signal?: AbortSignal) => Promise<ManagedServiceProcessHealthHeaderLease>)
        | undefined,
): ManagedServiceProcessSpec['healthCheck'] {
    if (!value || value.kind === 'none') return undefined;
    if (value.kind === 'command') return value;
    const headers = Object.freeze({
        ...(value.headers ?? {}),
        ...credentialHeaders,
        ...(clientCredentialHeader
            ? { [clientCredentialHeader.name]: clientCredentialHeader.value }
            : {}),
    });
    return Object.freeze({
        kind: 'http' as const,
        ...(value.alternatives
            ? {
                alternatives: Object.freeze(value.alternatives.map(
                    (alternative) => Object.freeze({
                        target: Object.freeze({
                            kind: 'serverPath' as const,
                            path: alternative.target.path,
                        }),
                        response: alternative.response,
                    }),
                )),
            }
            : {}),
        ...(value.target
            ? {
                target: Object.freeze({
                    kind: 'serverPath' as const,
                    path: value.target.path,
                }),
            }
            : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(resolveHealthHeaders
            ? { resolveHeaders: resolveHealthHeaders }
            : {}),
        timeoutMs: value.timeoutMs,
    });
}

function translateSpec(
    spec: NormalizedManagedServiceSpec,
    materialized: Readonly<{
        environment: Readonly<Record<string, string>>;
        healthHeaders: Readonly<Record<string, string>>;
        requestHeaders(
            target: 'health' | 'provider',
        ): Promise<Readonly<Record<string, string>>>;
        hasHealthRequestHeaders: boolean;
    }>,
    requestAuth: ValidatedRequestAuth | null,
    credential: ManagedServiceProcessCredential | undefined,
    resolveHealthHeaders:
        | ((signal?: AbortSignal) => Promise<ManagedServiceProcessHealthHeaderLease>)
        | undefined,
    nativeLifecycle?: ManagedServiceNativeLifecycleV1,
): ManagedServiceProcessSpec {
    const healthCheck = translateHealthCheck(
        spec.healthCheck,
        materialized.healthHeaders,
        credential?.httpHeader,
        resolveHealthHeaders,
    );
    const watchdog = Object.freeze({
        intervalMs: spec.healthPolicy.intervalMs,
        missedIntervals: spec.healthPolicy.consecutiveFailures,
    });
    if (spec.mode.kind === 'attach') {
        return Object.freeze({
            id: spec.id,
            mode: Object.freeze({
                kind: 'externalAttach' as const,
                baseUrl: spec.mode.baseUrl,
                ...(credential ? { credential } : {}),
            }),
            ...(healthCheck ? { healthCheck } : {}),
            watchdog,
            startupTimeoutMs: spec.startupTimeoutMs,
        });
    }
    if (spec.mode.kind === 'native') {
        if (!nativeLifecycle) {
            return fail('plugin_managed_service_unavailable', 'Declared native service lifecycle is unavailable');
        }
        return Object.freeze({
            id: spec.id,
            mode: Object.freeze({
                kind: 'native' as const,
                instance: spec.mode.instance,
                lifecycle: nativeLifecycle,
            }),
            launch: spec.mode.launch,
            watchdog,
            startupTimeoutMs: spec.startupTimeoutMs,
        });
    }
    if (spec.mode.endpoint.kind === 'none') {
        return Object.freeze({
            id: spec.id,
            mode: Object.freeze({
                kind: 'managedSpawn' as const,
                endpointNone: true as const,
                ...(credential ? { credential } : {}),
            }),
            launch: Object.freeze({
                ...spec.mode.launch,
                env: Object.freeze({
                    ...(spec.mode.launch.env ?? {}),
                    ...materialized.environment,
                    ...(requestAuth
                        ? { [requestAuth.injectEnvironmentKey]: requestAuth.capabilityPath }
                        : {}),
                }),
            }),
            ...(healthCheck ? { healthCheck } : {}),
            watchdog,
            startupTimeoutMs: spec.startupTimeoutMs,
            ...(spec.durableLog ? { durableLog: spec.durableLog } : {}),
        });
    }
    if (spec.mode.endpoint.kind === 'detectAfterLaunch') {
        const environment = Object.freeze({
            ...materialized.environment,
            ...(requestAuth
                ? {
                    [requestAuth.injectEnvironmentKey]:
                        requestAuth.capabilityPath,
                }
                : {}),
        });
        return Object.freeze({
            id: spec.id,
            mode: Object.freeze({
                kind: 'managedSpawn' as const,
                endpointDetection: Object.freeze({
                    kind: 'detectAfterLaunch' as const,
                    minimumConfidence:
                        spec.mode.endpoint.minimumConfidence ?? 'high',
                }),
                ...(credential ? { credential } : {}),
            }),
            launch: Object.freeze({
                ...spec.mode.launch,
                ...(Object.keys(environment).length > 0
                    ? {
                        env: Object.freeze({
                            ...(spec.mode.launch.env ?? {}),
                            ...environment,
                        }),
                    }
                    : {}),
            }),
            ...(healthCheck ? { healthCheck } : {}),
            watchdog,
            startupTimeoutMs: spec.startupTimeoutMs,
            ...(spec.durableLog ? { durableLog: spec.durableLog } : {}),
        });
    }
    const endpoint = spec.mode.endpoint;
    const injection = endpoint.inject;
    const port = endpoint.port.kind === 'fixed'
        ? endpoint.port.port
        : endpoint.port.preferredPort;
    const environment = Object.freeze({
        ...materialized.environment,
        ...(requestAuth
            ? {
                [requestAuth.injectEnvironmentKey]:
                    requestAuth.capabilityPath,
            }
            : {}),
    });
    return Object.freeze({
        id: spec.id,
        mode: Object.freeze({
            kind: 'managedSpawn' as const,
            host: endpoint.host ?? '127.0.0.1',
            ...(port !== undefined ? { port } : {}),
            ...(injection?.argument
                ? { portArgument: injection.argument }
                : {}),
            ...(injection?.portEnvironmentKey
                ? {
                    portEnvironmentKey:
                        injection.portEnvironmentKey,
                }
                : {}),
            ...(injection?.baseUrlEnvironmentKey
                ? {
                    baseUrlEnvironmentKey:
                        injection.baseUrlEnvironmentKey,
                }
                : {}),
            onPortCollision: endpoint.port.onCollision,
            ...(credential ? { credential } : {}),
        }),
        launch: Object.freeze({
            ...spec.mode.launch,
            ...(Object.keys(environment).length > 0
                ? {
                    env: Object.freeze({
                        ...(spec.mode.launch.env ?? {}),
                        ...environment,
                    }),
                }
                : {}),
        }),
        ...(healthCheck ? { healthCheck } : {}),
        watchdog,
        startupTimeoutMs: spec.startupTimeoutMs,
        ...(spec.durableLog
            ? { durableLog: spec.durableLog }
            : {}),
    });
}

type MaterializedCredentialSpec = Readonly<{
    environment: Readonly<Record<string, string>>;
    healthHeaders: Readonly<Record<string, string>>;
    requestHeaders(
        target: 'health' | 'provider',
    ): Promise<Readonly<Record<string, string>>>;
    hasHealthRequestHeaders: boolean;
    isInvalidated(): boolean;
    attachHandle(handle: ManagedServiceProcessHandle): boolean;
    dispose(): Promise<void>;
}>;

async function stopInvalidatedManagedService(
    handle: ManagedServiceProcessHandle,
): Promise<void> {
    let stopFailure: unknown;
    let result: Awaited<ReturnType<ManagedServiceProcessHandle['stop']>> | undefined;
    try {
        result = await handle.stop();
    } catch (error) {
        stopFailure = error;
    }
    if (result?.status === 'stopped' || result?.status === 'detached') return;
    if (result?.status === 'unsupported') {
        return fail('plugin_managed_service_unavailable', 'Managed service Stop is unsupported');
    }
    if (stopFailure === undefined) {
        stopFailure = new PluginError({
            code: 'plugin_managed_server_termination_incomplete',
            message: 'Managed server termination could not be verified',
            retryable: true,
        });
    }
    try {
        await handle.dispose();
    } catch (error) {
        throw managedServiceCleanupAggregate(
            [stopFailure, error],
            'Managed service invalidation cleanup failed',
        );
    }
}

type CredentialBindingCleanupOwner = Readonly<{
    registerFileLease(lease: ManagedServiceCredentialFileCleanup): void;
    registerSubscription(subscription: Readonly<{ dispose(): void }>): void;
    dispose(): Promise<void>;
}>;

function createCredentialBindingCleanupOwner(): CredentialBindingCleanupOwner {
    const fileLeases: ManagedServiceCredentialFileCleanup[] = [];
    const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
    let disposePromise: Promise<void> | null = null;
    let disposed = false;
    const dispose = async (): Promise<void> => {
        if (disposed) return;
        if (disposePromise) return await disposePromise;
        const attempt = (async () => {
            const failures: unknown[] = [];
            for (let index = fileLeases.length - 1; index >= 0; index -= 1) {
                try {
                    await fileLeases[index]!.dispose();
                    fileLeases.splice(index, 1);
                } catch (error) {
                    failures.push(error);
                }
            }
            for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
                try {
                    subscriptions[index]!.dispose();
                    subscriptions.splice(index, 1);
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length > 0) {
                throw managedServiceCleanupAggregate(
                    failures,
                    'Managed-service credential cleanup failed',
                );
            }
            disposed = true;
        })();
        disposePromise = attempt;
        try {
            await attempt;
        } finally {
            if (disposePromise === attempt) disposePromise = null;
        }
    };
    return Object.freeze({
        registerFileLease(lease) {
            if (disposed) {
                return fail(
                    'plugin_managed_service_establishment_failed',
                    'Managed-service credential cleanup is already complete',
                );
            }
            fileLeases.push(lease);
        },
        registerSubscription(subscription) {
            if (disposed) {
                return fail(
                    'plugin_managed_service_establishment_failed',
                    'Managed-service credential cleanup is already complete',
                );
            }
            subscriptions.push(subscription);
        },
        dispose,
    });
}

async function materializeCredentialBindings(input: Readonly<{
    spec: ManagedServiceSpec;
    bindings: readonly ValidatedCredentialBinding[];
    scope: ManagedServicesScope;
    context: ManagedServicesInvocationBindingContext;
    cleanup: CredentialBindingCleanupOwner;
    signal?: AbortSignal;
}>): Promise<MaterializedCredentialSpec> {
    if (input.bindings.length === 0) {
        return Object.freeze({
            environment: Object.freeze({}),
            healthHeaders: Object.freeze({}),
            async requestHeaders() {
                return Object.freeze({});
            },
            hasHealthRequestHeaders: false,
            isInvalidated: () => false,
            attachHandle: () => true,
            dispose: input.cleanup.dispose,
        });
    }
    const connectedAccounts = input.context.connectedAccounts;
    if (!connectedAccounts) {
        return fail(
            'plugin_managed_service_unavailable',
            'Connected Accounts materialization is unavailable for managed services',
        );
    }
    const environment = Object.create(null) as Record<string, string>;
    const healthHeaders = Object.create(null) as Record<string, string>;
    const providerHeaders = Object.create(null) as Record<string, string>;
    let invalidated = false;
    let headerLeaseStale = false;
    let headerLeaseRevision = 0;
    let currentHealthHeaders: Readonly<Record<string, string>> =
        Object.freeze({});
    let currentProviderHeaders: Readonly<Record<string, string>> =
        Object.freeze({});
    let headerRefresh: Promise<void> | null = null;
    let attachedHandle: ManagedServiceProcessHandle | null = null;
    const invalidate = (): void => {
        if (invalidated) return;
        invalidated = true;
        const handle = attachedHandle;
        if (handle) {
            void stopInvalidatedManagedService(handle)
                .then(input.cleanup.dispose)
                .catch(() => undefined);
        }
    };
    for (const purpose of new Set(
            input.bindings.map(({ binding }) => binding.purpose),
        )) {
        const purposeBindings = input.bindings.filter(
            ({ binding }) => binding.purpose === purpose,
        );
        const hasProcessMaterialization = purposeBindings.some(
            ({ binding }) => binding.injection.kind !== 'httpHeaders',
        );
        const hasRequestHeaders = purposeBindings.some(
            ({ binding }) => binding.injection.kind === 'httpHeaders',
        );
        let initialResyncPending = true;
        input.cleanup.registerSubscription(
            connectedAccounts.watch(purpose, () => {
                if (initialResyncPending) {
                    initialResyncPending = false;
                    return;
                }
                if (hasRequestHeaders) {
                    headerLeaseRevision += 1;
                    headerLeaseStale = true;
                }
                if (hasProcessMaterialization) invalidate();
            }),
        );
    }
    for (const validated of input.bindings) {
        assertScopeCurrent(input.scope);
        if (invalidated) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed-service credentials changed during establishment',
            );
        }
        const { binding, requestedNames } = validated;
        const materialized = await connectedAccounts.materialize(
            binding.purpose,
            binding.request,
            input.signal ? { signal: input.signal } : undefined,
        );
        assertScopeCurrent(input.scope);
        if (invalidated) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed-service credentials changed during establishment',
            );
        }
        if (materialized.kind !== binding.request.kind) {
            return specInvalid(
                'Connected Accounts returned the wrong managed-service materialization kind',
            );
        }
        if (binding.injection.kind === 'environment') {
            const value = materialized as Extract<
                PluginConnectedAccountMaterialization,
                Readonly<{ kind: 'environment' }>
            >;
            assertExactRecordKeys(
                value.env,
                requestedNames,
                'environment',
            );
            for (const [source, destination] of Object.entries(
                binding.injection
                    .targetEnvironmentKeysByMaterializedKey,
            )) {
                const secret = value.env[source];
                if (typeof secret !== 'string') {
                    return specInvalid(
                        'Connected Accounts returned a partial environment materialization',
                    );
                }
                environment[destination] = secret;
            }
            continue;
        }
        if (binding.injection.kind === 'httpHeaders') {
            const value = materialized as Extract<
                PluginConnectedAccountMaterialization,
                Readonly<{ kind: 'httpHeaders' }>
            >;
            assertExactRecordKeys(
                value.headers,
                requestedNames,
                'header',
            );
            for (const [name, secret] of Object.entries(
                value.headers,
            )) {
                if (
                    binding.injection.target === 'healthRequests'
                    || binding.injection.target
                        === 'healthAndProviderRequests'
                ) {
                    healthHeaders[name] = secret;
                }
                if (
                    binding.injection.target === 'providerRequests'
                    || binding.injection.target
                        === 'healthAndProviderRequests'
                ) {
                    providerHeaders[name] = secret;
                }
            }
            continue;
        }
        const value = materialized as Extract<
            PluginConnectedAccountMaterialization,
            Readonly<{ kind: 'files' }>
        >;
        assertExactRecordKeys(
            value.files,
            requestedNames,
            'file',
        );
        const fileOwner = input.context.credentialFiles;
        if (!fileOwner) {
            return fail(
                'plugin_managed_service_unavailable',
                'Private managed-service credential-file materialization is unavailable',
            );
        }
        const lease = await fileOwner.materialize({
            scope: Object.freeze({
                occurrenceId: input.scope.occurrenceId,
                pluginId: input.scope.pluginId,
                contributionQualifiedId:
                    input.scope.contributionQualifiedId,
                ...(input.scope.sessionId
                    ? { sessionId: input.scope.sessionId }
                    : {}),
                ...(input.scope.operationId
                    ? { operationId: input.scope.operationId }
                    : {}),
            }),
            files: value.files,
            retainCleanup: input.cleanup.registerFileLease,
        });
        assertExactRecordKeys(
            lease.pathsByFileId,
            requestedNames,
            'file',
        );
        for (const [fileId, destination] of Object.entries(
            binding.injection.pathsByFileId,
        )) {
            const path = lease.pathsByFileId[fileId];
            if (typeof path !== 'string' || path.trim().length === 0) {
                return specInvalid(
                    'Private credential-file owner returned an invalid path',
                );
            }
            environment[destination.environmentKey] = path;
        }
    }
    assertScopeCurrent(input.scope);
    if (invalidated) {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed-service credentials changed during establishment',
        );
    }
    currentHealthHeaders = Object.freeze({ ...healthHeaders });
    currentProviderHeaders = Object.freeze({ ...providerHeaders });
    const refreshRequestHeaders = async (): Promise<void> => {
        if (!headerLeaseStale) return;
        headerRefresh ??= (async () => {
            const refreshingRevision = headerLeaseRevision;
            const nextHealthHeaders = Object.create(null) as Record<
                string,
                string
            >;
            const nextProviderHeaders = Object.create(null) as Record<
                string,
                string
            >;
            for (const validated of input.bindings) {
                const { binding, requestedNames } = validated;
                if (binding.injection.kind !== 'httpHeaders') continue;
                assertScopeCurrent(input.scope);
                const materialized = await connectedAccounts.materialize(
                    binding.purpose,
                    binding.request,
                    input.signal ? { signal: input.signal } : undefined,
                );
                if (materialized.kind !== 'httpHeaders') {
                    return specInvalid(
                        'Connected Accounts returned the wrong managed-service materialization kind',
                    );
                }
                assertExactRecordKeys(
                    materialized.headers,
                    requestedNames,
                    'header',
                );
                for (const [name, secret] of Object.entries(
                    materialized.headers,
                )) {
                    if (
                        binding.injection.target === 'healthRequests'
                        || binding.injection.target
                            === 'healthAndProviderRequests'
                    ) nextHealthHeaders[name] = secret;
                    if (
                        binding.injection.target === 'providerRequests'
                        || binding.injection.target
                            === 'healthAndProviderRequests'
                    ) nextProviderHeaders[name] = secret;
                }
            }
            assertScopeCurrent(input.scope);
            currentHealthHeaders = Object.freeze(nextHealthHeaders);
            currentProviderHeaders = Object.freeze(nextProviderHeaders);
            headerLeaseStale =
                headerLeaseRevision !== refreshingRevision;
        })();
        try {
            await headerRefresh;
        } finally {
            headerRefresh = null;
        }
    };
    return Object.freeze({
        environment: Object.freeze(environment),
        healthHeaders: currentHealthHeaders,
        async requestHeaders(target) {
            await refreshRequestHeaders();
            return target === 'health'
                ? currentHealthHeaders
                : currentProviderHeaders;
        },
        hasHealthRequestHeaders: input.bindings.some(({ binding }) => (
            binding.injection.kind === 'httpHeaders'
            && binding.injection.target !== 'providerRequests'
        )),
        isInvalidated: () => invalidated,
        attachHandle(handle) {
            if (invalidated) return false;
            attachedHandle = handle;
            return true;
        },
        dispose: input.cleanup.dispose,
    });
}

function translateSnapshot(
    value: ManagedServiceProcessSnapshot,
): ManagedServiceSnapshot {
    return Object.freeze({
        id: value.id,
        state: value.state,
        mode: value.mode === 'managedSpawn' ? 'spawn' : value.mode === 'native' ? 'native' : 'attach',
        ...(value.readiness ? { readiness: value.readiness } : {}),
        ...(value.nativePhase ? { nativePhase: value.nativePhase } : {}),
        baseUrl: value.baseUrl,
        startedAtMs: value.startedAtMs,
        lastHealthyAtMs: value.lastHealthyAtMs,
        diagnostics: value.diagnostics,
        diagnosticsTruncated: value.diagnosticsTruncated,
    });
}

function wrapHandle(
    handle: ManagedServiceProcessHandle,
    cleanupCredentials: () => Promise<void>,
    stopResult: Readonly<{ status: 'stopped' | 'detached' }>,
    healthyWaitDefaultTimeoutMs: number | undefined,
    request: (
        request: ManagedServiceRequest,
        lifetimeSignal: AbortSignal,
    ) => Promise<ManagedServiceResponse>,
    signal?: AbortSignal,
    onTerminalDetected?: () => void,
    onTerminalComplete?: () => void,
    stopOnAuthorityAbort = true,
): ManagedServiceHandle {
    let underlyingCleanupPromise: Promise<void> | null = null;
    let cleanupPromise: Promise<void> | null = null;
    let underlyingCleanupComplete = false;
    let credentialCleanupComplete = false;
    let terminal = false;
    let terminalCompletionPublished = false;
    const requestLifetime = new AbortController();
    const markTerminal = (): void => {
        if (terminal) return;
        terminal = true;
        requestLifetime.abort('Managed-service handle is terminal');
    };
    const cleanup = async (): Promise<void> => {
        if (credentialCleanupComplete) return;
        if (cleanupPromise) return await cleanupPromise;
        const attempt = cleanupCredentials();
        cleanupPromise = attempt;
        try {
            await attempt;
            credentialCleanupComplete = true;
        } finally {
            if (cleanupPromise === attempt) cleanupPromise = null;
        }
    };
    let terminalObservation: Readonly<{ dispose(): void }> | undefined;
    let abort = (): void => undefined;
    const detachTerminalObservation = (): void => {
        if (!terminalObservation) return;
        terminalObservation.dispose();
        terminalObservation = undefined;
    };
    const runUnderlyingCleanup = async (
        operation: () => Promise<unknown>,
    ): Promise<void> => {
        if (underlyingCleanupComplete) return;
        if (underlyingCleanupPromise) {
            return await underlyingCleanupPromise;
        }
        const attempt = Promise.resolve()
            .then(operation)
            .then((result) => {
                if (
                    result !== null
                    && typeof result === 'object'
                    && 'status' in result
                    && result.status !== 'stopped'
                    && result.status !== 'detached'
                ) {
                    throw new PluginError({
                        code: result.status === 'unsupported' ? 'plugin_managed_service_unavailable' : 'plugin_managed_server_termination_incomplete',
                        message: 'Managed server termination could not be verified',
                        retryable: true,
                    });
                }
            });
        underlyingCleanupPromise = attempt;
        try {
            await attempt;
            underlyingCleanupComplete = true;
        } finally {
            if (underlyingCleanupPromise === attempt) {
                underlyingCleanupPromise = null;
            }
        }
    };
    const runWithFinalization = async (
        operation: () => Promise<unknown>,
    ): Promise<void> => {
        requestLifetime.abort('Managed-service cleanup is in progress');
        let operationError: unknown;
        try {
            await runUnderlyingCleanup(operation);
        } catch (error) {
            operationError = error;
        }
        let cleanupError: unknown;
        try {
            await cleanup();
        } catch (error) {
            cleanupError = error;
        }
        let observationError: unknown;
        if (operationError === undefined) {
            try {
                detachTerminalObservation();
            } catch (error) {
                observationError = error;
            }
        }
        const failures = [
            observationError,
            operationError,
            cleanupError,
        ].filter((error) => error !== undefined);
        if (failures.length > 1) {
            throw managedServiceCleanupAggregate(
                failures,
                'Managed-service process and credential cleanup failed',
            );
        }
        if (observationError !== undefined) {
            return translateError(observationError);
        }
        if (operationError !== undefined) {
            return translateError(operationError);
        }
        if (cleanupError !== undefined) {
            return translateError(cleanupError);
        }
        signal?.removeEventListener('abort', abort);
        markTerminal();
        if (!terminalCompletionPublished) {
            terminalCompletionPublished = true;
            onTerminalComplete?.();
        }
    };
    abort = (): void => {
        requestLifetime.abort('Managed-service serving authority retired');
        if (!stopOnAuthorityAbort) return;
        void runWithFinalization(
            async () => await stopInvalidatedManagedService(handle),
        ).catch(() => undefined);
    };
    try {
        terminalObservation = handle.observe?.((snapshot) => {
            const processTerminal = snapshot.diagnostics.some(({ code }) => (
                code === 'plugin_managed_server_process_exited'
                || code === 'plugin_managed_server_process_failed'
            ));
            if (
                snapshot.state === 'stopped'
                || processTerminal
            ) {
                onTerminalDetected?.();
                void runWithFinalization(
                    async () => await handle.dispose(),
                ).catch(() => undefined);
            }
        });
        if (terminal) detachTerminalObservation();
    } catch {
        // Observation is advisory; explicit lifecycle cleanup remains authoritative.
    }
    if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    }
    return Object.freeze({
        snapshot: () => translateSnapshot(handle.snapshot()),
        observe(listener) {
            const observation = handle.observe?.((snapshot) => {
                listener(translateSnapshot(snapshot));
            });
            return observation ?? Object.freeze({ dispose() {} });
        },
        async waitUntilHealthy(options) {
            const timeoutMs = normalizeManagedServiceHealthyWaitTimeout(
                options?.timeoutMs,
                healthyWaitDefaultTimeoutMs,
            );
            try {
                return translateSnapshot(
                    await handle.waitUntilHealthy({
                        timeoutMs,
                        ...(options?.signal
                            ? { signal: options.signal }
                            : {}),
                    }),
                );
            } catch (error) {
                return translateError(error);
            }
        },
        async request(input) {
            if (terminal || requestLifetime.signal.aborted) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed-service handle is unavailable',
                );
            }
            try {
                return await request(input, requestLifetime.signal);
            } catch (error) {
                return translateError(error);
            }
        },
        async stop(options) {
            await runWithFinalization(
                async () => await handle.stop(options),
            );
            return stopResult;
        },
        async dispose() {
            await runWithFinalization(
                async () => await handle.dispose(),
            );
        },
    } satisfies ManagedServiceHandle);
}

type ManagedProviderEndpointAccessFacts = Readonly<{
    scope: ManagedServicesScope;
    binding: ManagedProviderRuntimeInvocationBinding;
    clientAccess: ValidatedManagedServiceClientAccess;
    credential: ManagedServiceProcessCredential | undefined;
    requestHeaders(
        target: 'health' | 'provider',
    ): Promise<Readonly<Record<string, string>>>;
}>;

/**
 * A healthy service's address, admitted under the rule its own mode implies: a
 * spawned service listens on a loopback port this host allocated, an attached
 * one listens wherever the user runs it.
 */
function readHealthyServiceEndpoint(
    service: ManagedServiceHandle,
): Readonly<{ baseUrl: URL; startedAtMs: number }> | null {
    try {
        const snapshot = service.snapshot();
        if (
            snapshot.state !== 'healthy'
            || snapshot.baseUrl === null
            || snapshot.startedAtMs === null
        ) return null;
        const read = readManagedServiceEndpointUrl(snapshot.baseUrl, {
            hostPolicy: managedServiceEndpointHostPolicyForMode(snapshot.mode),
        });
        if (!read.ok) return null;
        return Object.freeze({
            baseUrl: new URL(read.endpoint.baseUrl),
            startedAtMs: snapshot.startedAtMs,
        });
    } catch {
        return null;
    }
}

type ManagedServiceRequestInput = Readonly<{
    pathAndQuery: string;
    method: string;
    headers: Headers;
    body: Uint8Array | undefined;
    timeoutMs: number;
    signal: AbortSignal | undefined;
}>;

type ManagedServiceProcessEndpoint = Readonly<{
    baseUrl: URL;
    instanceId: string;
    startedAtMs: number | null;
}>;

function readHealthyServiceProcessEndpoint(
    service: ManagedServiceProcessHandle,
): ManagedServiceProcessEndpoint | null {
    try {
        const snapshot = service.snapshot();
        if (snapshot.state !== 'healthy' || snapshot.baseUrl === null) {
            return null;
        }
        const read = readManagedServiceEndpointUrl(snapshot.baseUrl, {
            hostPolicy: managedServiceEndpointHostPolicyForMode(snapshot.mode),
        });
        if (!read.ok) return null;
        return Object.freeze({
            baseUrl: new URL(read.endpoint.baseUrl),
            instanceId: snapshot.instanceId,
            startedAtMs: snapshot.startedAtMs,
        });
    } catch {
        return null;
    }
}

function requestUnavailable(message: string): never {
    return fail('plugin_managed_service_unavailable', message);
}

/**
 * Cancellation provenance for one managed request.
 *
 * Establishment and streaming compose several abort authorities into one signal — the caller's own
 * `signal`, the exact handle's lifetime, and the invocation scope — so by the time a request fails
 * the composed signal no longer says who ended it. Reporting all of them as unavailability tells a
 * plugin that its service, credentials or occurrenceId are gone when in fact it cancelled itself, and
 * that is the difference between retrying, re-establishing, and reporting an outage to the user.
 * The caller's signal is therefore consulted directly: it aborted, so this is `plugin_operation_aborted`;
 * anything else (handle/scope/currentness/process retirement, timeout, transport failure) stays
 * `plugin_managed_service_unavailable`.
 */
function requestFailure(
    callerSignal: AbortSignal | null | undefined,
    message: string,
): never {
    if (callerSignal?.aborted) {
        return fail('plugin_operation_aborted', message);
    }
    return requestUnavailable(message);
}

function normalizeManagedServiceRequest(
    request: ManagedServiceRequest,
): ManagedServiceRequestInput {
    if (!request || typeof request !== 'object') {
        return requestUnavailable('Managed-service request is invalid');
    }
    const rawPath = request.pathAndQuery;
    if (typeof rawPath !== 'string') {
        return requestUnavailable('Managed-service request target is invalid');
    }
    const rawPathname = rawPath.split(/[?#]/u, 1)[0] ?? rawPath;
    if (rawPathname.split('/').some((part) => part === '.' || part === '..')) {
        return requestUnavailable(
            'Managed-service request target must not contain traversal segments',
        );
    }
    let pathAndQuery: string;
    try {
        pathAndQuery = normalizeProviderOriginRelativePathSyntax(
            rawPath,
            { allowQuery: true },
        );
    } catch {
        return requestUnavailable('Managed-service request target is invalid');
    }
    const method = request.method ?? 'GET';
    if (
        typeof method !== 'string'
        || !MANAGED_SERVICE_REQUEST_METHODS.has(method)
    ) {
        return requestUnavailable('Managed-service request method is invalid');
    }
    const rawHeaders = request.headers ?? {};
    if (
        typeof rawHeaders !== 'object'
        || rawHeaders === null
        || Array.isArray(rawHeaders)
    ) {
        return requestUnavailable('Managed-service request headers are invalid');
    }
    const headerEntries = Object.entries(rawHeaders);
    if (headerEntries.length > MAX_MANAGED_SERVICE_REQUEST_HEADERS) {
        return requestUnavailable('Managed-service request has too many headers');
    }
    const headers = new Headers();
    const seenHeaders = new Set<string>();
    let headerBytes = 0;
    for (const [rawName, value] of headerEntries) {
        const name = rawName.toLowerCase();
        let publicHeaderNameIsValid = true;
        try {
            normalizeProviderPublicHeaders({ [rawName]: '' });
        } catch {
            publicHeaderNameIsValid = false;
        }
        if (
            rawName.length < 1
            || rawName.length > 128
            || rawName !== rawName.trim()
            || !HTTP_HEADER_NAME_PATTERN.test(rawName)
            || seenHeaders.has(name)
            || !publicHeaderNameIsValid
            || typeof value !== 'string'
            || value.length > 8_192
            || CONTROL_CHARACTER_PATTERN.test(value)
        ) {
            return requestUnavailable(
                'Managed-service request headers are invalid',
            );
        }
        headerBytes += Buffer.byteLength(rawName) + Buffer.byteLength(value);
        if (headerBytes > MAX_MANAGED_SERVICE_REQUEST_HEADER_BYTES) {
            return requestUnavailable(
                'Managed-service request headers are too large',
            );
        }
        seenHeaders.add(name);
        headers.set(name, value);
    }
    const body = request.body;
    if (
        body !== undefined
        && (
            !(body instanceof Uint8Array)
            || body.byteLength > MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES
        )
    ) {
        return requestUnavailable('Managed-service request body is invalid');
    }
    if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
        return requestUnavailable(
            'Managed-service GET and HEAD requests cannot include a body',
        );
    }
    const timeoutMs = request.timeoutMs
        ?? DEFAULT_MANAGED_SERVICE_REQUEST_TIMEOUT_MS;
    if (
        !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1
        || timeoutMs > DEFAULT_MANAGED_SERVICE_REQUEST_TIMEOUT_MS
    ) {
        return requestUnavailable('Managed-service request timeout is invalid');
    }
    if (
        request.signal !== undefined
        && !(request.signal instanceof AbortSignal)
    ) {
        return requestUnavailable('Managed-service request signal is invalid');
    }
    return Object.freeze({
        pathAndQuery,
        method,
        headers,
        ...(body ? { body: body.slice() } : { body: undefined }),
        timeoutMs,
        signal: request.signal,
    });
}

function resolveManagedServiceRequestTarget(
    baseUrl: URL,
    pathAndQuery: string,
): URL {
    try {
        const base = new URL(`${baseUrl.toString().replace(/\/+$/u, '')}/`);
        const target = new URL(pathAndQuery.slice(1), base);
        const basePath = base.pathname.replace(/\/+$/u, '');
        if (
            target.origin !== base.origin
            || target.username !== ''
            || target.password !== ''
            || target.hash !== ''
            || (
                basePath.length > 0
                && target.pathname !== basePath
                && !target.pathname.startsWith(`${basePath}/`)
            )
        ) {
            return requestUnavailable(
                'Managed-service request target escaped its exact handle',
            );
        }
        return target;
    } catch (error) {
        if (isPluginError(error)) throw error;
        return requestUnavailable('Managed-service request target is invalid');
    }
}

function mergeManagedServiceRequestHeaders(
    headers: Headers,
    injected: Readonly<Record<string, string>>,
): Headers {
    const merged = new Headers(headers);
    for (const [name, value] of Object.entries(injected)) {
        if (
            name.length < 1
            || name.length > 128
            || !HTTP_HEADER_NAME_PATTERN.test(name)
            || value.length > 8_192
            || CONTROL_CHARACTER_PATTERN.test(value)
            || merged.has(name)
        ) {
            return requestUnavailable(
                'Managed-service request credentials are invalid',
            );
        }
        merged.set(name, value);
    }
    let count = 0;
    let bytes = 0;
    merged.forEach((value, name) => {
        count += 1;
        bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    });
    if (
        count > MAX_MANAGED_SERVICE_REQUEST_HEADERS
        || bytes > MAX_MANAGED_SERVICE_REQUEST_HEADER_BYTES
    ) {
        return requestUnavailable(
            'Managed-service request headers exceed their final bounds',
        );
    }
    return merged;
}

function readManagedServiceResponseHeaders(
    response: Response,
): Readonly<Record<string, string>> {
    const headers: Record<string, string> = Object.create(null);
    let count = 0;
    let bytes = 0;
    response.headers.forEach((value, rawName) => {
        const name = rawName.toLowerCase();
        if (
            name === 'authorization'
            || name === 'proxy-authorization'
            || name === 'set-cookie'
            || name === 'set-cookie2'
        ) return;
        count += 1;
        bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        if (
            count > MAX_MANAGED_SERVICE_RESPONSE_HEADERS
            || name.length < 1
            || name.length > 128
            || !HTTP_HEADER_NAME_PATTERN.test(name)
            || value.length > 8_192
            || CONTROL_CHARACTER_PATTERN.test(value)
            || bytes > MAX_MANAGED_SERVICE_RESPONSE_HEADER_BYTES
        ) {
            return requestUnavailable(
                'Managed-service response headers are invalid',
            );
        }
        headers[name] = value;
    });
    return Object.freeze(headers);
}

function boundManagedServiceResponseBody(input: Readonly<{
    body: ReadableStream<Uint8Array> | null;
    signal: AbortSignal;
    callerSignal?: AbortSignal | null;
    isCurrent(): boolean;
    cleanup(): void;
}>): ReadableStream<Uint8Array> | null {
    if (!input.body) {
        input.cleanup();
        return null;
    }
    const reader = input.body.getReader();
    let pending: Uint8Array | null = null;
    let pendingOffset = 0;
    let settled = false;
    let outputController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
    const settle = (): void => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', abort);
        try {
            reader.releaseLock();
        } catch {
            // An in-flight read releases the lock after it settles.
        }
        input.cleanup();
    };
    const cancelInput = (): void => {
        void reader.cancel('Managed-service response body is unavailable')
            .catch(() => undefined);
    };
    const abort = (): void => {
        if (settled) return;
        cancelInput();
        try {
            outputController?.error(input.callerSignal?.aborted
                ? new PluginError({
                    code: 'plugin_operation_aborted',
                    message:
                        'Managed-service request was cancelled by its caller',
                })
                : new PluginError({
                    code: 'plugin_managed_service_unavailable',
                    message: 'Managed-service response body is unavailable',
                }));
        } catch {
            // A concurrently settled stream needs no second notification.
        }
        settle();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    return new ReadableStream<Uint8Array>({
        start(controller) {
            outputController = controller;
            if (input.signal.aborted || !input.isCurrent()) abort();
        },
        async pull(controller) {
            if (
                settled
                || input.signal.aborted
                || !input.isCurrent()
            ) {
                abort();
                return;
            }
            try {
                if (!pending) {
                    const next = await reader.read();
                    if (next.done) {
                        controller.close();
                        settle();
                        return;
                    }
                    if (!(next.value instanceof Uint8Array)) {
                        cancelInput();
                        controller.error(new PluginError({
                            code: 'plugin_managed_service_unavailable',
                            message: 'Managed-service response body is invalid',
                        }));
                        settle();
                        return;
                    }
                    pending = next.value;
                    pendingOffset = 0;
                }
                if (input.signal.aborted || !input.isCurrent()) {
                    abort();
                    return;
                }
                const end = Math.min(
                    pendingOffset + MAX_MANAGED_SERVICE_RESPONSE_CHUNK_BYTES,
                    pending.byteLength,
                );
                controller.enqueue(pending.subarray(pendingOffset, end));
                pendingOffset = end;
                if (pendingOffset === pending.byteLength) {
                    pending = null;
                    pendingOffset = 0;
                }
            } catch (error) {
                controller.error(error);
                settle();
            }
        },
        async cancel(reason) {
            if (settled) return;
            try {
                await reader.cancel(reason);
            } finally {
                settle();
            }
        },
    });
}

async function executeManagedServiceFetch(input: Readonly<{
    fetch: typeof globalThis.fetch;
    target: URL;
    init: RequestInit;
    signals: readonly (AbortSignal | null | undefined)[];
    /** The request's own `signal`, kept apart from the composed lifetime so cancellation stays attributable. */
    callerSignal?: AbortSignal | null;
    timeoutMs: number;
    isCurrent(): boolean;
    isDispatchCurrent?(signal: AbortSignal): Promise<boolean>;
}>): Promise<ManagedServiceResponse> {
    if (!input.isCurrent()) {
        return requestUnavailable('Managed-service request is unavailable');
    }
    const lifetime = composeAbortSignals(input.signals);
    const timeout = new AbortController();
    const timeoutHandle = setTimeout(
        () => timeout.abort('Managed-service request timed out'),
        input.timeoutMs,
    );
    const establishment = composeAbortSignals([
        lifetime.signal,
        timeout.signal,
    ]);
    let establishmentCleaned = false;
    const cleanupEstablishment = (): void => {
        if (establishmentCleaned) return;
        establishmentCleaned = true;
        clearTimeout(timeoutHandle);
        establishment.cleanup();
    };
    let lifetimeCleaned = false;
    const cleanupLifetime = (): void => {
        if (lifetimeCleaned) return;
        lifetimeCleaned = true;
        lifetime.cleanup();
    };
    if (establishment.signal.aborted) {
        cleanupEstablishment();
        cleanupLifetime();
        return requestFailure(
            input.callerSignal,
            'Managed-service request is unavailable',
        );
    }
    if (
        input.isDispatchCurrent
        && !await input.isDispatchCurrent(establishment.signal)
    ) {
        cleanupEstablishment();
        cleanupLifetime();
        return requestFailure(
            input.callerSignal,
            'Managed-service request is unavailable',
        );
    }
    if (establishment.signal.aborted) {
        cleanupEstablishment();
        cleanupLifetime();
        return requestFailure(
            input.callerSignal,
            'Managed-service request is unavailable',
        );
    }
    let response: Response;
    try {
        response = await input.fetch(input.target, {
            ...input.init,
            credentials: 'omit',
            redirect: 'manual',
            signal: establishment.signal,
        });
    } catch {
        cleanupEstablishment();
        cleanupLifetime();
        return requestFailure(
            input.callerSignal,
            'Managed-service request failed',
        );
    }
    let status: number;
    let statusText: string;
    let headers: Readonly<Record<string, string>>;
    try {
        status = response.status;
        statusText = response.statusText.slice(0, 1_024);
        if (
            status < 100
            || status > 599
            || (status >= 300 && status < 400)
        ) {
            cleanupEstablishment();
            await response.body?.cancel().catch(() => undefined);
            cleanupLifetime();
            return requestUnavailable(
                'Managed-service response is unavailable',
            );
        }
        headers = readManagedServiceResponseHeaders(response);
    } catch (error) {
        cleanupEstablishment();
        await response.body?.cancel().catch(() => undefined);
        cleanupLifetime();
        if (isPluginError(error)) throw error;
        return requestUnavailable('Managed-service response is unavailable');
    }
    const establishmentAborted = establishment.signal.aborted;
    cleanupEstablishment();
    if (
        !input.isCurrent()
        || establishmentAborted
        || lifetime.signal.aborted
    ) {
        await response.body?.cancel().catch(() => undefined);
        cleanupLifetime();
        return requestFailure(
            input.callerSignal,
            'Managed-service response is unavailable',
        );
    }
    const body = boundManagedServiceResponseBody({
        body: response.body,
        signal: lifetime.signal,
        ...(input.callerSignal ? { callerSignal: input.callerSignal } : {}),
        isCurrent: input.isCurrent,
        cleanup: cleanupLifetime,
    });
    return Object.freeze({
        ok: status >= 200 && status <= 299,
        status,
        statusText,
        headers,
        body,
    });
}

function resolveManagedProviderEndpointUrls(
    baseUrl: URL,
    endpoints: readonly ManagedProviderEndpointPath[],
): ReadonlyMap<string, URL> | null {
    if (
        endpoints.length < 1
        || endpoints.length
            > PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration
    ) return null;
    const resolved = new Map<string, URL>();
    for (const endpoint of endpoints) {
        if (
            endpoint.endpointTemplateId.trim().length === 0
            || endpoint.servicePath.length < 1
            || endpoint.servicePath.length > 2_048
            || endpoint.servicePath !== endpoint.servicePath.trim()
            || !endpoint.servicePath.startsWith('/')
            || endpoint.servicePath.includes('?')
            || endpoint.servicePath.includes('#')
            || resolved.has(endpoint.endpointTemplateId)
        ) return null;
        try {
            const url = new URL(endpoint.servicePath, baseUrl);
            if (
                url.origin !== baseUrl.origin
                || url.pathname !== endpoint.servicePath
                || url.search !== ''
                || url.hash !== ''
            ) return null;
            resolved.set(endpoint.endpointTemplateId, url);
        } catch {
            return null;
        }
    }
    return resolved;
}

function isWithinEndpointPath(
    target: URL,
    endpoints: ReadonlyMap<string, URL>,
): boolean {
    for (const endpoint of endpoints.values()) {
        if (target.origin !== endpoint.origin) continue;
        if (endpoint.pathname === '/') return true;
        if (
            target.pathname === endpoint.pathname
            || target.pathname.startsWith(
                endpoint.pathname.endsWith('/')
                    ? endpoint.pathname
                    : `${endpoint.pathname}/`,
            )
        ) return true;
    }
    return false;
}

function composeAbortSignals(
    signals: readonly (AbortSignal | null | undefined)[],
): Readonly<{ signal: AbortSignal; cleanup(): void }> {
    const controller = new AbortController();
    const listeners: Array<Readonly<{
        signal: AbortSignal;
        listener(): void;
    }>> = [];
    for (const signal of signals) {
        if (!signal) continue;
        const listener = (): void => controller.abort(signal.reason);
        if (signal.aborted) {
            listener();
            break;
        }
        signal.addEventListener('abort', listener, { once: true });
        listeners.push(Object.freeze({ signal, listener }));
    }
    return Object.freeze({
        signal: controller.signal,
        cleanup() {
            for (const entry of listeners) {
                entry.signal.removeEventListener('abort', entry.listener);
            }
        },
    });
}

type ManagedServiceLifecycle = Readonly<{
    kind: 'session' | 'operation' | 'occurrenceId' | 'project';
    identity: string;
    retainedAcrossOrdinaryGenerationRetirement: boolean;
}>;

type ManagedServiceSemanticEntry = {
    readonly kind: 'service';
    readonly effectiveOwnerKey: string;
    readonly lifecycle: ManagedServiceLifecycle;
    readonly specIdentity: string;
    readonly establishmentAbort: AbortController;
    /** Consumer authority belongs to this existing physical custody entry. */
    sharedConsumers?: {
        path: string;
        pending: number;
        unsettled: Set<string>;
        healthPaths: readonly string[];
        claims: Map<string, Readonly<{
            token: string;
            capabilityPath: string;
            purposes: readonly NonNullable<NonNullable<ManagedServicesInvocationBindingContext['requestAuth']>['qualifiedRequestAuthUses']>[number]['purpose'][];
        }>>;
        mutation: Promise<void>;
    };
    establishment: Promise<ManagedServiceHandle>;
    establishmentSettled: boolean;
    waiterCount: number;
    terminal: boolean;
    processHandle: ManagedServiceProcessHandle | null;
    // Observation only: successful wrapping transfers all process cleanup custody to the public handle.
    readProcessSnapshot: (() => ManagedServiceProcessSnapshot) | null;
    activityObservation?: Readonly<{ dispose(): void }>;
    readAcquiredCustody?: () => boolean;
    establishmentCleanup: (() => Promise<void>) | null;
    credentialCleanup: CredentialBindingCleanupOwner | null;
    retirement: Promise<void> | null;
} & (
    | Readonly<{
        authority: 'plugin';
        occurrenceId: string;
        pluginId: string;
        scope: ManagedServicesScope;
        project?: never;
    }>
    | Readonly<{
        authority: 'project';
        occurrenceId?: never;
        pluginId?: never;
        scope: ProjectManagedServicesScope;
        project: ProjectManagedServiceWitness & { handle: ProjectManagedServiceHandle | null };
    }>
);

export type ManagedProviderExplicitStartOperationOutcome = Readonly<{
    status: 'running';
    /** Host-private endpoint authority retained by the semantic operation. */
    projection: ManagedProviderEndpointAccessProjection;
}>;

export type ManagedProviderExplicitStartOperationResult =
    | Readonly<{
        status: 'established';
        value: ManagedProviderExplicitStartOperationOutcome;
    }>
    | Readonly<{ status: 'not_current' }>
    | Readonly<{ status: 'unavailable' }>;

export type ManagedProviderExplicitStartOperationInput = Readonly<{
    /** Only admitted shared Provider claims belong to controller custody. */
    sharedProvider?: true;
    operationId: string;
    pluginId: string;
    contributionQualifiedId: string;
    occurrenceId: string;
    purposeBindingsEqualityKey: string;
    /** Bounds only this caller's joined projection, never the shared operation. */
    signal?: AbortSignal;
    isCurrent(): boolean;
    lifecycleKind?: 'publicExplicitStart' | 'providerBroker';
    retirementGroup?: Readonly<{ identity: string; onRetired(): Promise<void> }>;
    /** Re-enters the durable authority for the retained semantic claim. */
    revalidateRetainedCurrentness?(signal?: AbortSignal): Promise<boolean>;
    establish(input: Readonly<{
        signal: AbortSignal;
        release(): Promise<void>;
    }>): Promise<ManagedProviderExplicitStartOperationOutcome>;
}>;

type ManagedProviderExplicitStartOperationEntry = {
    readonly sharedProvider?: true;
    readonly kind: 'explicitStartOperation';
    readonly operationId: string;
    readonly pluginId: string;
    readonly contributionQualifiedId: string;
    readonly occurrenceId: string;
    readonly purposeBindingsEqualityKey: string;
    readonly isCurrent: () => boolean;
    readonly lifecycleKind: 'publicExplicitStart' | 'providerBroker';
    readonly retirementGroup: ManagedProviderExplicitStartOperationInput['retirementGroup'];
    cleanupComplete: boolean;
    revalidateRetainedCurrentness: ((signal?: AbortSignal) => Promise<boolean>) | null;
    readonly abort: AbortController;
    establishment: Promise<ManagedProviderExplicitStartOperationOutcome>;
    terminal: boolean;
    retirement: Promise<void> | null;
};

type ManagedServicesSemanticEntry =
    | ManagedServiceSemanticEntry
    | ManagedProviderExplicitStartOperationEntry;

function projectManagedProviderExplicitStartJoin(
    outcome: ManagedProviderExplicitStartOperationOutcome,
    input: Pick<ManagedProviderExplicitStartOperationInput, 'signal' | 'isCurrent'>,
): ManagedProviderExplicitStartOperationOutcome {
    const lifetime = new AbortController();
    let active = true;
    const readsJoinCurrent = (): boolean => (
        active
        && !lifetime.signal.aborted
        && !input.signal?.aborted
        && readsCurrent(input.isCurrent)
        && readsCurrent(outcome.projection.isCurrent)
    );
    const unavailable = (): never => fail(
        'plugin_managed_service_unavailable',
        'Managed Provider explicit-start endpoint access is unavailable',
    );
    const projection = Object.freeze({
        access: Object.freeze({
            endpointUrl(endpointTemplateId: string): string | null {
                return readsJoinCurrent()
                    ? outcome.projection.access.endpointUrl(endpointTemplateId)
                    : null;
            },
            async request(
                request: ManagedServiceRequest & Readonly<{ timeoutMs: number }>,
            ): Promise<ManagedServiceResponse> {
                if (!readsJoinCurrent()) return unavailable();
                const signals = [
                    lifetime.signal,
                    input.signal,
                    request.signal,
                ].filter((candidate): candidate is AbortSignal => (
                    candidate !== undefined
                ));
                return await outcome.projection.access.request({
                    ...request,
                    signal: signals.length === 1
                        ? signals[0]!
                        : AbortSignal.any(signals),
                });
            },
        }),
        isCurrent: readsJoinCurrent,
        cleanup() {
            if (!active) return;
            active = false;
            lifetime.abort(
                'Managed Provider explicit-start endpoint join retired',
            );
        },
    });
    return Object.freeze({ status: 'running', projection });
}

function isManagedServiceSemanticEntry(
    entry: ManagedServicesSemanticEntry,
): entry is ManagedServiceSemanticEntry {
    return entry.kind === 'service';
}

function isPluginManagedServiceSemanticEntry(
    entry: ManagedServicesSemanticEntry,
): entry is ManagedServiceSemanticEntry & { authority: 'plugin' } {
    return isManagedServiceSemanticEntry(entry) && entry.authority === 'plugin';
}

function isProjectManagedServiceSemanticEntry(
    entry: ManagedServicesSemanticEntry,
): entry is ManagedServiceSemanticEntry & { authority: 'project' } {
    return isManagedServiceSemanticEntry(entry) && entry.authority === 'project';
}

function managedProviderExplicitStartOperationEntryKey(input: Readonly<{
    operationId: string;
    pluginId: string;
    contributionQualifiedId: string;
}>): string {
    return [
        'managed-provider-explicit-start-operation',
        input.operationId,
        input.pluginId,
        input.contributionQualifiedId,
    ].join('\u0000');
}

function managedServiceSemanticEntryKey(input: Readonly<{
    lifecycleIdentity: string;
    pluginId: string;
    contributionQualifiedId: string;
    serviceId: string;
    occurrenceId: string;
}>): string {
    return [
        input.lifecycleIdentity,
        input.pluginId,
        input.contributionQualifiedId,
        input.serviceId,
        input.occurrenceId,
    ].join('\u0000');
}

function managedServiceLifecycle(
    scope: ManagedServicesScope,
    custodyOwner: ManagedServiceProcessSupervisorHost['custodyOwner'],
): ManagedServiceLifecycle {
    if (custodyOwner === 'sessionRunner' && scope.sessionId) {
        return Object.freeze({
            kind: 'session',
            identity: `session:${scope.sessionId}`,
            retainedAcrossOrdinaryGenerationRetirement: true,
        });
    }
    if (scope.operationId) {
        return Object.freeze({
            kind: 'operation',
            identity: `operation:${scope.operationId}`,
            retainedAcrossOrdinaryGenerationRetirement: false,
        });
    }
    if (scope.sessionId) {
        return fail(
            'plugin_managed_service_unavailable',
            'Retained Session managed services require Session-runner custody',
        );
    }
    const identity = [
        'occurrenceId',
        scope.pluginId,
        scope.occurrenceId,
        scope.contributionQualifiedId,
    ].join(':');
    return Object.freeze({
        kind: 'occurrenceId',
        identity,
        retainedAcrossOrdinaryGenerationRetirement: false,
    });
}

function waitForManagedServiceEstablishment(
    entry: ManagedServiceSemanticEntry,
    signal?: AbortSignal,
): Promise<ManagedServiceHandle> {
    entry.waiterCount += 1;
    const waiting = !signal
        ? entry.establishment
        : signal.aborted
            ? Promise.reject(new PluginError({
                code: 'plugin_operation_aborted',
                message: 'Managed-service supervision was aborted',
            }))
            : new Promise<ManagedServiceHandle>((resolve, reject) => {
        const aborted = (): void => reject(new PluginError({
            code: 'plugin_operation_aborted',
            message: 'Managed-service supervision was aborted',
        }));
        signal.addEventListener('abort', aborted, { once: true });
        void entry.establishment.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', aborted);
        });
    });
    return waiting.catch((error) => translateError(error)).finally(() => {
        entry.waiterCount -= 1;
        if (entry.waiterCount === 0 && !entry.establishmentSettled) {
            entry.establishmentAbort.abort(
                'Managed-service establishment has no remaining waiters',
            );
        }
    });
}

type SessionManagedServiceIdentity = Readonly<{
    sessionId: string;
    pluginId: string;
    contributionQualifiedId: string;
    serviceId: string;
}> & (
    | Readonly<{ occurrenceId: string; instanceId?: never }>
    | Readonly<{ instanceId: string; occurrenceId?: never }>
);

export type ManagedServicesOwnerInput = Readonly<{
    processSupervisorHost: ManagedServiceProcessSupervisorHost;
    sharedGatewayAccessDirectory?: string;
    resolveManagedExecutable?(scope: ManagedServicesScope, executable: ManagedExecutableRef, isCurrent: () => boolean): Promise<ResolvedPluginExecutable>;
    /** Resolves only the currently admitted manifest-declared native service role. */
    resolveNativeLifecycle?(scope: ManagedServicesScope, instance: ManagedServiceNativeInstanceV1,
        admission: Readonly<{ exec: ExecService; launch: PluginExecSpawnRequest }>): Promise<ManagedServiceNativeLifecycleV1 | null>;
    fetch?: typeof globalThis.fetch;
    registerRawForRedaction?: (
        scope: ManagedServicesScope,
        value: string,
    ) => void;
    /**
     * Reads one secret the supervising plugin declared for its own scope from
     * the daemon-local encrypted secret store. Supplied by the owner
     * construction site because that site already holds the store paths and
     * the declared-access authority; the value never leaves this owner.
     */
    resolveDeclaredSecret?: ResolveDeclaredManagedServiceSecret;
    dependencies:
        | ManagedDependenciesService
        | ((scope: ManagedServicesScope) => ManagedDependenciesService);
    resolveScope(seed: Readonly<{
        occurrenceId: string;
        sourceCustody?: PluginSourceCustodyV1;
        pluginId: string;
        contributionQualifiedId: string;
        sessionId?: string;
        signal?: AbortSignal;
        isOccurrenceCurrent(): boolean;
    }>, context?: ManagedServicesInvocationBindingContext):
        ManagedServicesScope | null;
}>;

export function createManagedServicesOwner(input: ManagedServicesOwnerInput): ManagedServicesInvocationOwner & Readonly<{
    /** Private daemon projection of the same retained supervisor custody. */
    activity: LiveWorkProducerV1;
    dispose(options?: Readonly<{ preserveProjectServices?: boolean; preserveSharedProviderServices?: boolean }>): Promise<void>;
    /** Updated only at the controller's synchronous publication boundary. */
    configureHostBindings(bindings: Omit<ManagedServicesOwnerInput, 'processSupervisorHost' | 'sharedGatewayAccessDirectory'>): void;
    retireSharedProviderServices(pluginIds?: readonly string[]): Promise<void>;
    retireProjectServices(): Promise<void>;
    /** Host-private visibility for bounded custody diagnostics and owner-level tests. */
    readRetainedSemanticCustodyCount(): number;
    superviseProject(input: ProjectManagedServiceSupervisionInput): Promise<ProjectManagedServiceHandle>;
    stopForAccessLoss(requester: RequesterWorkAttributionV1, options?: Readonly<{
        /** Host-private frozen signed request; never a plugin/public service input. */
        verifyCurrentMachineAdmission: () => Promise<boolean>;
    }>): Promise<readonly ProjectServiceAccessLossResult[]>;
    resolveProjectService(target: Extract<LocalServiceActionTargetV1, { kind: 'managed_service' }>): ProjectManagedServiceResolution;
    listProjectServices(options?: Readonly<{ requireComplete?: true; workspaceRoot?: string }>): readonly ProjectManagedServiceHandle[];
    bindScope(
        scope: ManagedServicesScope,
        exec: ExecService,
        context?: Partial<ManagedServicesInvocationBindingContext>,
    ): ManagedServices;
    bindSessionManagedServiceRequest(input: SessionManagedServiceIdentity): ((
        request: ManagedServiceRequest,
    ) => Promise<ManagedServiceResponse>) | null;
    materializeSessionManagedServiceClientEnvironment(input: SessionManagedServiceIdentity & Readonly<{
        environmentKey: string;
        signal?: AbortSignal;
    }>): Promise<Readonly<Record<string, string>> | null>;
    runManagedProviderExplicitStart(
        input: ManagedProviderExplicitStartOperationInput,
    ): Promise<ManagedProviderExplicitStartOperationResult>;
    retireManagedProviderExplicitStart(input: Readonly<{
        operationId: string;
        pluginId: string;
        contributionQualifiedId: string;
    }>): Promise<boolean>;
    revalidateManagedProviderExplicitStarts(signal?: AbortSignal): Promise<number>;
    retireManagedProviderExplicitStarts(
        lifecycleKind: 'publicExplicitStart' | 'providerBroker',
    ): Promise<number>;
    materializeManagedProviderAgentBinding(input: Readonly<{
        service: ManagedServiceHandle;
        projection: ManagedProviderEndpointAccessProjection;
        endpointTemplateId: string;
        materialize(input: Readonly<{
            endpointUrl: string;
            credentialPlaceholder: string | null;
        }>): Promise<unknown>;
    }>): Promise<Readonly<{
        materialization: AgentProviderBindingMaterializationV1;
        redactionValues: readonly string[];
        /** Host-private exact rendered binding; never a plugin result. */
        httpBinding: Readonly<{ endpointUrl: string; headers: Readonly<Record<string, string>> }>;
        transformLaunchEnvironment(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
    }> | null>;
}> {
    const endpointAccessByService = new WeakMap<
        ManagedServiceHandle,
        ManagedProviderEndpointAccessFacts
    >();
    const clientEnvironmentByService = new WeakMap<
        ManagedServiceHandle,
        (
            environmentKey: string,
            signal?: AbortSignal,
        ) => Promise<Readonly<Record<string, string>>>
    >();
    const projectedEndpointAccess = new WeakSet<ManagedServiceHandle>();
    const semanticEntries = new Map<
        string,
        ManagedServicesSemanticEntry
    >();
    const activityListeners = new Set<() => void>();
    const notifyActivity = (): void => {
        for (const listener of activityListeners) {
            try { listener(); } catch { /* Observation cannot alter service custody. */ }
        }
    };
    const observeServiceProcess = (entry: ManagedServiceSemanticEntry, process: ManagedServiceProcessHandle): void => {
        entry.activityObservation?.dispose();
        entry.activityObservation = process.observe?.(notifyActivity);
        notifyActivity();
    };
    const activity: LiveWorkProducerV1 = Object.freeze({
        read(): Omit<LiveWorkInventoryV1, 'idleSince'> {
            const items: LiveWorkItemV1[] = [...semanticEntries.values()].map(entry => {
                if (!isManagedServiceSemanticEntry(entry)) return {
                    category: 'service', ownerRef: entry.operationId,
                    attribution: { kind: 'unknown' }, state: 'unknown',
                };
                const snapshot = entry.readProcessSnapshot?.();
                return {
                    category: 'service', ownerRef: snapshot?.instanceId ?? entry.effectiveOwnerKey,
                    attribution: isProjectManagedServiceSemanticEntry(entry) ? entry.project.requester : { kind: 'unknown' },
                    // Health/access retirement is not process exit. Only the supervisor's stopped fact settles custody.
                    state: snapshot?.state === 'stopped' ? 'settled' : snapshot ? 'active'
                        : !entry.establishmentSettled ? 'active' : 'unknown',
                };
            });
            return { items, coverage: 'complete' };
        },
        subscribe(listener: () => void): () => void {
            activityListeners.add(listener);
            return () => { activityListeners.delete(listener); };
        },
    });
    let permanentRetirementStarted = false;
    let projectRetirementStarted = false;
    let sharedProviderRetirementStarted = false;
    const resolveSessionManagedServiceEntry = (
        identity: SessionManagedServiceIdentity,
    ): (ManagedServiceSemanticEntry & { authority: 'plugin' }) | null => {
        if (permanentRetirementStarted) return null;
        const matchesIdentity = (entry: ManagedServicesSemanticEntry): entry is ManagedServiceSemanticEntry & { authority: 'plugin' } => (
            isPluginManagedServiceSemanticEntry(entry)
            && !entry.terminal
            && entry.lifecycle.kind === 'session'
            && entry.scope.sessionId === identity.sessionId
            && entry.scope.pluginId === identity.pluginId
            && entry.scope.contributionQualifiedId === identity.contributionQualifiedId
        );
        if (identity.occurrenceId !== undefined) {
            const entry = semanticEntries.get(managedServiceSemanticEntryKey({
                lifecycleIdentity: `session:${identity.sessionId}`,
                ...identity,
                occurrenceId: identity.occurrenceId,
            }));
            return entry && matchesIdentity(entry) ? entry : null;
        }
        const matches = [...semanticEntries.entries()].filter((candidate): candidate is [string, ManagedServiceSemanticEntry & { authority: 'plugin' }] => {
            const [key, entry] = candidate;
            if (!matchesIdentity(entry)) return false;
            const snapshot = entry.readProcessSnapshot?.();
            return key === managedServiceSemanticEntryKey({
                lifecycleIdentity: entry.lifecycle.identity,
                pluginId: identity.pluginId,
                contributionQualifiedId: identity.contributionQualifiedId,
                serviceId: identity.serviceId,
                occurrenceId: entry.occurrenceId,
            }) && snapshot?.instanceId === identity.instanceId;
        });
        return matches.length === 1 ? matches[0]![1] : null;
    };
    const assertAcceptingSupervision = (sharedProvider = false): void => {
        if (sharedProvider ? sharedProviderRetirementStarted : permanentRetirementStarted) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed-service owner is permanently retired',
            );
        }
    };
    const hostFetch = input.fetch ?? globalThis.fetch.bind(globalThis);
    const removeSemanticEntry = (
        entry: ManagedServicesSemanticEntry,
    ): void => {
        if (isManagedServiceSemanticEntry(entry)) {
            entry.activityObservation?.dispose();
            entry.activityObservation = undefined;
        }
        for (const [key, candidate] of semanticEntries) {
            if (candidate === entry) semanticEntries.delete(key);
        }
        notifyActivity();
    };
    const releaseEntryCredentialCleanup = async (
        entry: ManagedServiceSemanticEntry,
    ): Promise<void> => {
        const cleanup = entry.credentialCleanup;
        if (!cleanup) return;
        await cleanup.dispose();
        if (entry.credentialCleanup === cleanup) {
            entry.credentialCleanup = null;
        }
    };
    const releaseEntryProcessHandle = async (
        entry: ManagedServiceSemanticEntry,
        attemptStop: boolean,
    ): Promise<void> => {
        const handle = entry.processHandle;
        if (!handle) return;
        try {
            if (attemptStop) {
                await stopInvalidatedManagedService(handle);
            } else {
                await handle.dispose();
            }
        } catch (error) {
            throw managedServiceCleanupAggregate(
                [error],
                'Managed-service process cleanup failed',
            );
        }
        if (entry.processHandle === handle) {
            entry.processHandle = null;
            // A retained credential-cleanup failure does not keep an observer
            // attached to a process whose physical handle was released.
            const activityObservation = entry.activityObservation;
            activityObservation?.dispose();
            if (entry.activityObservation === activityObservation) entry.activityObservation = undefined;
        }
    };
    const releaseEntryEstablishmentCleanup = async (
        entry: ManagedServiceSemanticEntry,
    ): Promise<void> => {
        const cleanup = entry.establishmentCleanup;
        if (!cleanup) return;
        try {
            await cleanup();
        } catch (error) {
            throw managedServiceCleanupAggregate(
                [error],
                'Managed-service establishment cleanup failed',
            );
        }
        if (entry.establishmentCleanup === cleanup) {
            entry.establishmentCleanup = null;
        }
    };
    const retireEntry = async (
        entry: ManagedServiceSemanticEntry,
    ): Promise<void> => {
        if (entry.retirement) return await entry.retirement;
        const retirement = (async () => {
            entry.terminal = true;
            entry.establishmentAbort.abort(
                'Managed-service lifecycle retired during establishment',
            );
            if (
                entry.establishmentSettled
                && (
                    entry.processHandle
                    || entry.establishmentCleanup
                )
            ) {
                const failures: unknown[] = [];
                try {
                    await releaseEntryProcessHandle(entry, false);
                } catch (error) {
                    failures.push(error);
                }
                try {
                    await releaseEntryEstablishmentCleanup(entry);
                } catch (error) {
                    failures.push(error);
                }
                try {
                    await releaseEntryCredentialCleanup(entry);
                } catch (error) {
                    failures.push(error);
                }
                if (
                    entry.processHandle === null
                    && entry.establishmentCleanup === null
                    && entry.credentialCleanup === null
                ) {
                    removeSemanticEntry(entry);
                }
                if (failures.length > 0) {
                    throw managedServiceCleanupAggregate(
                        failures,
                        'Managed-service retained cleanup failed',
                    );
                }
                return;
            }
            let handle: ManagedServiceHandle;
            try {
                handle = await entry.establishment;
            } catch (error) {
                let credentialCleanupFailure: unknown;
                try {
                    await releaseEntryCredentialCleanup(entry);
                } catch (cleanupError) {
                    credentialCleanupFailure = cleanupError;
                }
                if (
                    entry.processHandle === null
                    && entry.establishmentCleanup === null
                    && entry.credentialCleanup === null
                ) {
                    removeSemanticEntry(entry);
                    return;
                }
                if (credentialCleanupFailure !== undefined) {
                    throw managedServiceCleanupAggregate(
                        [error, credentialCleanupFailure],
                        'Managed-service establishment cleanup failed',
                    );
                }
                throw error;
            }
            await handle.dispose();
            removeSemanticEntry(entry);
        })();
        entry.retirement = retirement;
        try {
            await retirement;
        } finally {
            if (entry.retirement === retirement) {
                entry.retirement = null;
            }
        }
    };
    const managedServiceEntriesForExplicitStartOperation = (
        operation: Readonly<{
            operationId: string;
            pluginId: string;
            contributionQualifiedId: string;
            occurrenceId: string;
        }>,
    ): readonly (ManagedServiceSemanticEntry & { authority: 'plugin' })[] => (
        [...semanticEntries.values()]
            .filter(isPluginManagedServiceSemanticEntry)
            .filter((entry) => (
                entry.scope.operationId === operation.operationId
                && entry.pluginId === operation.pluginId
                && entry.scope.contributionQualifiedId
                    === operation.contributionQualifiedId
                && entry.occurrenceId === operation.occurrenceId
            ))
    );
    const explicitStartOperationForScope = (
        scope: ManagedServicesScope,
    ): ManagedProviderExplicitStartOperationEntry | null => {
        if (!scope.operationId) return null;
        const entry = semanticEntries.get(
            managedProviderExplicitStartOperationEntryKey({
                operationId: scope.operationId,
                pluginId: scope.pluginId,
                contributionQualifiedId: scope.contributionQualifiedId,
            }),
        );
        if (
            !entry
            || isManagedServiceSemanticEntry(entry)
            || entry.occurrenceId !== scope.occurrenceId
        ) return null;
        return entry;
    };
    const retireExplicitStartOperation = async (
        entry: ManagedProviderExplicitStartOperationEntry,
        abort = true,
    ): Promise<void> => {
        if (entry.retirement) return await entry.retirement;
        const retirement = (async () => {
            entry.terminal = true;
            if (abort) {
                entry.abort.abort(
                    'Managed Provider explicit-start operation retired',
                );
            }
            const established = entry.cleanupComplete ? null : await entry.establishment.catch(() => null);
            const results = await Promise.allSettled(
                [
                    ...(established
                        ? [Promise.resolve(
                            established.projection.cleanup(),
                        )]
                        : []),
                    ...managedServiceEntriesForExplicitStartOperation(entry)
                        .map(retireEntry),
                ],
            );
            const failures = results.flatMap((result) => (
                result.status === 'rejected' ? [result.reason] : []
            ));
            if (failures.length > 0) {
                throw managedServiceCleanupAggregate(
                    failures,
                    'Managed Provider explicit-start cleanup failed',
                );
            }
            entry.cleanupComplete = true;
            const group = entry.retirementGroup;
            if (group && ![...semanticEntries.values()].some((other) => (
                other !== entry && !isManagedServiceSemanticEntry(other)
                && other.retirementGroup?.identity === group.identity
            ))) {
                await group.onRetired();
            }
            removeSemanticEntry(entry);
        })();
        entry.retirement = retirement;
        try {
            await retirement;
        } finally {
            if (entry.retirement === retirement) {
                entry.retirement = null;
            }
        }
    };
    const retireSemanticEntry = async (
        entry: ManagedServicesSemanticEntry,
    ): Promise<void> => {
        if (isManagedServiceSemanticEntry(entry)) {
            await retireEntry(entry);
            return;
        }
        await retireExplicitStartOperation(entry);
    };
    const acquireSharedConsumer = async (
        entry: ManagedServiceSemanticEntry,
        scope: ManagedServicesScope,
        context: ManagedServicesInvocationBindingContext,
        signal?: AbortSignal,
    ): Promise<ManagedServiceHandle> => {
        const census = entry.sharedConsumers!;
        census.pending += 1;
        let physical: ManagedServiceHandle;
        try {
            physical = await waitForManagedServiceEstablishment(entry, signal);
        } catch (error) {
            census.pending -= 1;
            throw error;
        }
        const serialize = async (effect: () => Promise<void>): Promise<void> => {
            const mutation = census.mutation.then(effect);
            census.mutation = mutation.catch(() => undefined);
            await mutation;
        };
        const publish = () => replacePrivateBearerFile({
            path: census.path,
            contents: JSON.stringify({ v: 1, consumers: [...census.claims.values()] }),
        });
        const token = createPrivateBearerCredential();
        let active = true;
        const lifetime = new AbortController();
        let cleanup: Promise<void> | null = null;
        const isCurrent = () => active && !entry.terminal
            && !scope.signal?.aborted && !signal?.aborted
            && readsCurrent(scope.isOccurrenceCurrent)
            && readsCurrent(context.managedProvider!.isCurrent)
            && readsCurrent(context.requestAuth!.isCurrent);
        try {
            await serialize(async () => {
                census.pending -= 1;
                if (!isCurrent()) return requestUnavailable('Managed Provider consumer authority is unavailable');
                census.claims.set(token, {
                    token,
                    capabilityPath: context.requestAuth!.capabilityPath,
                    purposes: [...new Map(context.requestAuth!.qualifiedRequestAuthUses!.map(({ purpose }) => (
                        [qualifiedPurposeKey(purpose), purpose] as const
                    ))).values()],
                });
                try { await publish(); } catch (error) { census.claims.delete(token); throw error; }
            });
        } catch (error) {
            if (census.claims.size === 0 && census.pending === 0 && census.unsettled.size === 0) await retireEntry(entry);
            throw error;
        }
        const release = (): Promise<void> => {
            active = false;
            lifetime.abort('Managed Provider consumer retired');
            if (cleanup) return cleanup;
            cleanup = serialize(async () => {
                census.claims.delete(token);
                census.unsettled.add(token);
                await publish();
                // Revocation precedes settlement. The wrapper owns complete
                // HTTP/stream/WebSocket lifetime, including requests made by
                // an Agent rather than through this host request adapter.
                if (entry.terminal) await retireEntry(entry);
                // A hard source fence may have already retired this exact
                // physical process. Its canonical stopped witness settles all
                // ingress; stale HTTP authority is neither needed nor usable.
                const physicallySettled = entry.terminal && entry.readProcessSnapshot?.().state === 'stopped';
                if (!physicallySettled) {
                    const settled = await physical.request({
                        pathAndQuery: '/_happier/consumer-access/settle', method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: Buffer.from(JSON.stringify({ token })),
                    });
                    await settled.body?.cancel();
                    if (settled.status !== 200) {
                        return requestUnavailable('Managed Provider consumer settlement is unavailable');
                    }
                }
                census.unsettled.delete(token);
                if (census.claims.size === 0 && census.pending === 0 && census.unsettled.size === 0) await retireEntry(entry);
            }).catch(error => { cleanup = null; throw error; });
            return cleanup;
        };
        const physicalFacts = endpointAccessByService.get(physical)!;
        const credential = renderHostClientCredential(physicalFacts.clientAccess, token)!;
        const consumer: ManagedServiceHandle = Object.freeze({
            snapshot: () => active ? physical.snapshot() : { ...physical.snapshot(), state: 'stopped' as const, baseUrl: null },
            observe: physical.observe,
            async waitUntilHealthy(options?: Parameters<ManagedServiceHandle['waitUntilHealthy']>[0]) {
                if (!isCurrent()) return requestUnavailable('Managed Provider consumer authority is unavailable');
                return await physical.waitUntilHealthy(options);
            },
            async request(request: ManagedServiceRequest) {
                if (!isCurrent()) return requestUnavailable('Managed Provider consumer authority is unavailable');
                const normalized = normalizeManagedServiceRequest(request);
                if (census.healthPaths.includes(normalized.pathAndQuery)) return await physical.request(request);
                const endpoint = readHealthyServiceEndpoint(physical);
                if (!endpoint) return requestUnavailable('Managed Provider endpoint is unavailable');
                const current = () => isCurrent() && readHealthyServiceEndpoint(physical)?.baseUrl.toString() === endpoint.baseUrl.toString();
                return await executeManagedServiceFetch({
                    fetch: hostFetch,
                    target: resolveManagedServiceRequestTarget(endpoint.baseUrl, normalized.pathAndQuery),
                    init: {
                        method: normalized.method,
                        headers: mergeManagedServiceRequestHeaders(normalized.headers, { [credential.httpHeader!.name]: credential.httpHeader!.value }),
                        ...(normalized.body === undefined ? {} : { body: Uint8Array.from(normalized.body) }),
                    },
                    signals: [lifetime.signal, scope.signal, signal, normalized.signal],
                    ...(normalized.signal ? { callerSignal: normalized.signal } : {}),
                    timeoutMs: normalized.timeoutMs,
                    isCurrent: current,
                });
            },
            async stop() { await release(); return { status: 'stopped' as const }; },
            dispose: release,
        });
        endpointAccessByService.set(consumer, {
            ...physicalFacts,
            scope,
            binding: { ...context.managedProvider!, isCurrent },
            credential,
        });
        input.registerRawForRedaction?.(scope, token);
        return consumer;
    };
    const bindScope = (
        suppliedScope: ManagedServicesScope,
        exec: ExecService,
        suppliedContext: Partial<
            ManagedServicesInvocationBindingContext
        > = {},
    ): ManagedServices => {
        const dependencies = typeof input.dependencies === 'function'
            ? input.dependencies(suppliedScope)
            : input.dependencies;
        const suppliedBindingContext: ManagedServicesInvocationBindingContext =
            Object.freeze({
                connectedAccounts:
                    suppliedContext.connectedAccounts ?? null,
                credentialFiles:
                    suppliedContext.credentialFiles ?? null,
                declaredSecretReadPort:
                    suppliedContext.declaredSecretReadPort ?? null,
                managedProvider:
                    suppliedContext.managedProvider ?? null,
                requestAuth:
                    suppliedContext.requestAuth ?? null,
            });
        const services: ManagedServices = Object.freeze({
            dependencies,
            async supervise(spec, options) {
                assertAcceptingSupervision('requestAuth' in spec && spec.requestAuth?.kind === 'connectedAccountConsumerAccessPath');
                let scope = suppliedScope;
                let context = suppliedBindingContext;
                let normalizedSpec = normalizeManagedServiceSpec(spec);
                let requestAuth = validateRequestAuth(
                    normalizedSpec,
                    context,
                );
                let sharedConsumers: ManagedServiceSemanticEntry['sharedConsumers'];
                if ('requestAuth' in normalizedSpec && normalizedSpec.requestAuth?.kind === 'connectedAccountConsumerAccessPath') {
                    const gateway = context.managedProvider?.sharedGateway;
                    const isPhysicalOccurrenceCurrent = context.managedProvider?.isPhysicalOccurrenceCurrent;
                    if (!gateway || !isPhysicalOccurrenceCurrent || !context.requestAuth?.qualifiedRequestAuthUses?.length || !input.sharedGatewayAccessDirectory
                        || input.processSupervisorHost.custodyOwner !== 'daemon'
                        || normalizedSpec.mode.kind !== 'spawn'
                        || normalizedSpec.clientAccess?.kind !== 'hostBearer'
                        || (normalizedSpec.credentialBindings?.length ?? 0) !== 0
                        || Object.values(gateway).some(value => typeof value !== 'string' || !value || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value))) {
                        return requestUnavailable('Shared managed Provider custody is unavailable');
                    }
                    assertScopeCurrent(scope);
                    validateCredentialBindings(normalizedSpec, requestAuth, context);
                    const physicalOperationId = `sharedGateway:${JSON.stringify([gateway.homeId, gateway.accountId, gateway.connectionId, gateway.machineId])}`;
                    scope = {
                        occurrenceId: scope.occurrenceId,
                        ...(scope.sourceCustody ? { sourceCustody: scope.sourceCustody } : {}),
                        pluginId: scope.pluginId, contributionQualifiedId: scope.contributionQualifiedId,
                        operationId: physicalOperationId,
                        independentInvocation: true,
                        // Generation retirement still belongs to semanticEntries;
                        // an individual consumer's abort is not physical custody.
                        isOccurrenceCurrent: () => !sharedProviderRetirementStarted && readsCurrent(isPhysicalOccurrenceCurrent),
                    };
                    const prior = semanticEntries.get(managedServiceSemanticEntryKey({
                        lifecycleIdentity: `operation:${physicalOperationId}`,
                        pluginId: scope.pluginId, contributionQualifiedId: scope.contributionQualifiedId,
                        serviceId: normalizedSpec.id, occurrenceId: scope.occurrenceId,
                    }));
                    sharedConsumers = prior && isManagedServiceSemanticEntry(prior)
                        ? prior.sharedConsumers : undefined;
                    sharedConsumers ??= {
                        path: join(input.sharedGatewayAccessDirectory, createPrivateBearerCredential(), 'request-auth', 'consumers.json'),
                        pending: 0, unsettled: new Set(),
                        healthPaths: normalizedSpec.healthCheck?.kind === 'http'
                            ? normalizedSpec.healthCheck.target ? [normalizedSpec.healthCheck.target.path]
                                : (normalizedSpec.healthCheck.alternatives ?? []).map(probe => probe.target.path)
                            : [],
                        claims: new Map(), mutation: Promise.resolve(),
                    };
                    const { requestAuth: declaration, ...physicalSpec } = normalizedSpec;
                    normalizedSpec = normalizeManagedServiceSpec({
                        ...physicalSpec,
                        mode: { ...normalizedSpec.mode, launch: {
                            ...normalizedSpec.mode.launch,
                            env: { ...normalizedSpec.mode.launch.env, [declaration.injectEnvironmentKey]: sharedConsumers.path },
                        } },
                    });
                    context = { ...context, requestAuth: null,
                        managedProvider: { ...context.managedProvider!, isCurrent: scope.isOccurrenceCurrent } };
                    requestAuth = null;
                }
                const processSupervisor = input.processSupervisorHost.bind({
                    occurrenceId: scope.occurrenceId,
                    ...(scope.sourceCustody ? { sourceCustody: scope.sourceCustody } : {}),
                    pluginId: scope.pluginId, contributionId: scope.contributionQualifiedId,
                    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
                    ...(scope.operationId ? { operationId: scope.operationId } : {}),
                    ...(scope.independentInvocation ? { independentInvocation: true as const } : {}),
                    ...(scope.independentInvocation && input.resolveManagedExecutable ? {
                        resolveManagedExecutable: (executable: ManagedExecutableRef, isCurrent: () => boolean) => input.resolveManagedExecutable!(scope, executable, isCurrent),
                    } : {}),
                    isOccurrenceCurrent: scope.isOccurrenceCurrent, exec,
                });
                const clientAccess = validateClientAccess(
                    normalizedSpec,
                    scope,
                    context,
                    input.processSupervisorHost.custodyOwner,
                );
                if (
                    (
                        clientAccess.kind === 'hostBasic'
                        || clientAccess.kind === 'declaredSecretBasic'
                    )
                    && !input.registerRawForRedaction
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Host-Basic redaction authority is unavailable',
                    );
                }
                const bindings = validateCredentialBindings(
                    normalizedSpec,
                    requestAuth,
                    context,
                );
                assertScopeCurrent(scope);
                if (context.managedProvider) {
                    assertManagedProviderCurrent(context.managedProvider);
                }
                assertRequestAuthCurrent(requestAuth);
                if (
                    clientAccess.kind === 'declaredSecretBasic'
                    && !input.resolveDeclaredSecret
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Declared-secret client access is unavailable',
                    );
                }
                const lifecycle = managedServiceLifecycle(
                    scope,
                    input.processSupervisorHost.custodyOwner,
                );
                const effectiveOwnerKey = [
                    lifecycle.identity,
                    scope.pluginId,
                    scope.contributionQualifiedId,
                    normalizedSpec.id,
                ].join('\u0000');
                const entryKey = managedServiceSemanticEntryKey({
                    lifecycleIdentity: lifecycle.identity,
                    pluginId: scope.pluginId,
                    contributionQualifiedId:
                        scope.contributionQualifiedId,
                    serviceId: normalizedSpec.id,
                    occurrenceId: scope.occurrenceId,
                });
                const specIdentity = canonicalSpecIdentity(normalizedSpec);
                let existing = semanticEntries.get(entryKey);
                if (existing && !isManagedServiceSemanticEntry(existing)) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed-service semantic entry is unavailable',
                    );
                }
                if (existing) {
                    if (existing.specIdentity !== specIdentity) {
                        return fail(
                            'plugin_managed_service_spec_conflict',
                            'A different managed-service specification already owns this exact lifecycle scope',
                        );
                    }
                    if (existing.terminal) {
                        await retireEntry(existing);
                        removeSemanticEntry(existing);
                        existing = semanticEntries.get(entryKey);
                        if (
                            existing
                            && !isManagedServiceSemanticEntry(existing)
                        ) {
                            return fail(
                                'plugin_managed_service_unavailable',
                                'Managed-service semantic entry is unavailable',
                            );
                        }
                        if (
                            existing
                            && existing.specIdentity !== specIdentity
                        ) {
                            return fail(
                                'plugin_managed_service_spec_conflict',
                                'A different managed-service specification already owns this exact lifecycle scope',
                            );
                        }
                    }
                }
                if (existing) {
                    if (existing.terminal) {
                        return fail(
                            'plugin_managed_service_not_reusable',
                            'Managed-service handle is terminal and cannot be reused',
                        );
                    }
                    return sharedConsumers
                        ? await acquireSharedConsumer(existing, suppliedScope, suppliedBindingContext, options?.signal)
                        : await waitForManagedServiceEstablishment(existing, options?.signal);
                }

                const priorEffectiveOwners = [...semanticEntries.values()]
                    .filter(isPluginManagedServiceSemanticEntry)
                    .filter((entry) => (
                        entry.effectiveOwnerKey === effectiveOwnerKey
                        && entry.occurrenceId !== scope.occurrenceId
                    ));
                for (const prior of priorEffectiveOwners) {
                    if (
                        prior.terminal
                        || (prior.lifecycle.kind !== 'session'
                            && !readsCurrent(prior.scope.isOccurrenceCurrent))
                    ) {
                        await retireEntry(prior);
                        // Settlement yields to concurrent admissions. Re-enter
                        // the canonical acquisition so they share whichever
                        // exact entry and private census now owns this scope.
                        return await services.supervise(spec, options);
                    }
                    return fail(
                        'plugin_managed_service_unavailable',
                        'A different managed-service occurrenceId still owns this lifecycle scope',
                    );
                }

                assertAcceptingSupervision(Boolean(sharedConsumers));

                const credentialCleanup =
                    createCredentialBindingCleanupOwner();
                const entry: ManagedServiceSemanticEntry = {
                    kind: 'service',
                    authority: 'plugin',
                    effectiveOwnerKey,
                    lifecycle,
                    occurrenceId: scope.occurrenceId,
                    pluginId: scope.pluginId,
                    specIdentity,
                    scope,
                    establishmentAbort: new AbortController(),
                    establishment: Promise.resolve(null as never),
                    establishmentSettled: false,
                    waiterCount: 0,
                    terminal: false,
                    processHandle: null,
                    readProcessSnapshot: null,
                    establishmentCleanup: null,
                    credentialCleanup,
                    retirement: null,
                    ...(sharedConsumers ? { sharedConsumers } : {}),
                };
                entry.establishment = (async () => {
                    const establishmentSignals = composeAbortSignals([
                        scope.signal,
                        entry.establishmentAbort.signal,
                    ]);
                    const credential =
                        clientAccess.kind === 'declaredSecretBasic'
                            ? undefined
                            : createHostClientCredential(clientAccess);
                    let materialized: MaterializedCredentialSpec | null = null;
                    try {
                        assertAcceptingSupervision(Boolean(sharedConsumers));
                        if (sharedConsumers) await replacePrivateBearerFile({
                            path: sharedConsumers.path,
                            contents: JSON.stringify({ v: 1, consumers: [] }),
                        });
                        assertScopeCurrent(scope);
                        if (context.managedProvider) {
                            assertManagedProviderCurrent(
                                context.managedProvider,
                            );
                        }
                        materialized = await materializeCredentialBindings({
                            spec: normalizedSpec,
                            bindings,
                            scope,
                            context,
                            cleanup: credentialCleanup,
                            signal: establishmentSignals.signal,
                        });
                        assertAcceptingSupervision(Boolean(sharedConsumers));
                        assertScopeCurrent(scope);
                        if (context.managedProvider) {
                            assertManagedProviderCurrent(
                                context.managedProvider,
                            );
                        }
                        assertRequestAuthCurrent(requestAuth);
                        if (clientAccess.kind === 'hostBasic') {
                            for (const value of
                                readManagedServiceProcessCredentialRedactionValues(
                                    credential,
                                )) {
                                input.registerRawForRedaction!(scope, value);
                            }
                        }
                        const staticClientCredential = credential;
                        const establishedMaterialization = materialized;
                        const resolveCurrentDeclaredClientCredential =
                            clientAccess.kind === 'declaredSecretBasic'
                                ? async (signal?: AbortSignal) => {
                                    if (signal?.aborted) {
                                        return fail(
                                            'plugin_operation_aborted',
                                            'Declared-secret client access was aborted',
                                        );
                                    }
                                    assertScopeCurrent(scope);
                                    const current =
                                        await resolveDeclaredClientCredential(
                                            clientAccess,
                                            scope,
                                            input.resolveDeclaredSecret,
                                            signal,
                                        );
                                    if (signal?.aborted) {
                                        return fail(
                                            'plugin_operation_aborted',
                                            'Declared-secret client access was aborted',
                                        );
                                    }
                                    assertScopeCurrent(scope);
                                    if (current.credential) {
                                        for (const value of
                                            readManagedServiceProcessCredentialRedactionValues(
                                                current.credential,
                                            )) {
                                            input.registerRawForRedaction!(
                                                scope,
                                                value,
                                            );
                                        }
                                    }
                                    return current;
                                }
                                : undefined;
                        const resolveCurrentHealthHeaders =
                            establishedMaterialization.hasHealthRequestHeaders
                            || resolveCurrentDeclaredClientCredential
                                ? async (signal?: AbortSignal) => {
                                    const materializedHeaders =
                                        establishedMaterialization
                                            .hasHealthRequestHeaders
                                            ? await establishedMaterialization
                                                .requestHeaders(
                                                'health',
                                                )
                                            : Object.freeze({});
                                    const currentCredential =
                                        resolveCurrentDeclaredClientCredential
                                            ? await resolveCurrentDeclaredClientCredential(
                                                signal,
                                            )
                                            : undefined;
                                    const credentialHeader =
                                        currentCredential?.credential
                                            ?.httpHeader;
                                    return Object.freeze({
                                        headers: Object.freeze({
                                            ...materializedHeaders,
                                            ...(credentialHeader
                                                ? {
                                                    [credentialHeader.name]:
                                                        credentialHeader.value,
                                                }
                                                : {}),
                                        }),
                                        ...(currentCredential?.isCurrent
                                            ? {
                                                isCurrent:
                                                    currentCredential.isCurrent,
                                            }
                                            : {}),
                                    });
                                }
                                : undefined;
                        const nativeLifecycle = normalizedSpec.mode.kind === 'native'
                            ? await input.resolveNativeLifecycle?.(scope, normalizedSpec.mode.instance, { exec, launch: normalizedSpec.mode.launch })
                            : undefined;
                        assertScopeCurrent(scope);
                        if (normalizedSpec.mode.kind === 'native' && !nativeLifecycle) {
                            return fail('plugin_managed_service_unavailable', 'Declared native service lifecycle is unavailable');
                        }
                        const handle = await processSupervisor.supervise(
                            translateSpec(
                                normalizedSpec,
                                materialized,
                                requestAuth,
                                staticClientCredential,
                                resolveCurrentHealthHeaders,
                                nativeLifecycle ?? undefined,
                            ),
                            {
                                signal: establishmentSignals.signal,
                                registerEstablishmentCleanup(cleanup) {
                                    entry.establishmentCleanup = cleanup;
                                    const custody = Object.freeze({
                                        release() {
                                            if (
                                                entry.establishmentCleanup
                                                === cleanup
                                            ) {
                                                entry.establishmentCleanup =
                                                    null;
                                            }
                                        },
                                    });
                                    return custody;
                                },
                            },
                        );
                        entry.processHandle = handle;
                        entry.readProcessSnapshot = () => handle.snapshot();
                        observeServiceProcess(entry, handle);
                        entry.establishmentCleanup = null;
                        if (
                            entry.establishmentAbort.signal.aborted
                            || !scope.isOccurrenceCurrent()
                            || (context.managedProvider
                                && !readsCurrent(
                                    context.managedProvider.isCurrent,
                                ))
                            || (requestAuth
                                && !readsCurrent(requestAuth.isCurrent))
                        ) {
                            await releaseEntryProcessHandle(entry, true);
                            await materialized.dispose();
                            return fail(
                                'plugin_managed_service_unavailable',
                                'Managed-service invocation authority changed during establishment',
                            );
                        }
                        if (!materialized.attachHandle(handle)) {
                            await releaseEntryProcessHandle(entry, true);
                            await materialized.dispose();
                            return fail(
                                'plugin_managed_service_unavailable',
                                'Managed-service credentials changed during establishment',
                            );
                        }
                        const cleanupCredentials = materialized.dispose;
                        const requestHeaders = materialized.requestHeaders;
                        const requestFromExactHandle = async (
                            request: ManagedServiceRequest,
                            lifetimeSignal: AbortSignal,
                        ): Promise<ManagedServiceResponse> => {
                            const normalized = normalizeManagedServiceRequest(
                                request,
                            );
                            const endpoint =
                                readHealthyServiceProcessEndpoint(handle);
                            if (!endpoint) {
                                return requestUnavailable(
                                    'Managed-service endpoint is unavailable',
                                );
                            }
                            const isCurrent = (): boolean => {
                                const current =
                                    readHealthyServiceProcessEndpoint(handle);
                                return !lifetimeSignal.aborted
                                    && !scope.signal?.aborted
                                    && readsCurrent(
                                        scope.isOccurrenceCurrent,
                                    )
                                    && (
                                        !context.managedProvider
                                        || readsCurrent(
                                            context.managedProvider.isCurrent,
                                        )
                                    )
                                    && (
                                        !requestAuth
                                        || readsCurrent(requestAuth.isCurrent)
                                    )
                                    && current !== null
                                    && current.instanceId
                                        === endpoint.instanceId
                                    && current.startedAtMs
                                        === endpoint.startedAtMs
                                    && current.baseUrl.toString()
                                        === endpoint.baseUrl.toString();
                            };
                            if (!isCurrent()) {
                                return requestUnavailable(
                                    'Managed-service endpoint is unavailable',
                                );
                            }
                            const providerHeaders = context.managedProvider
                                ? await requestHeaders('provider')
                                : Object.freeze({});
                            if (!isCurrent()) {
                                return requestUnavailable(
                                    'Managed-service endpoint is unavailable',
                                );
                            }
                            let requestCredential = staticClientCredential;
                            let requestCredentialCurrentness:
                                | DeclaredPluginSecretReadResult['isCurrent']
                                | undefined;
                            if (resolveCurrentDeclaredClientCredential) {
                                const credentialSignals = composeAbortSignals([
                                    lifetimeSignal,
                                    scope.signal,
                                    normalized.signal,
                                ]);
                                try {
                                    const currentCredential =
                                        await resolveCurrentDeclaredClientCredential(
                                            credentialSignals.signal,
                                        );
                                    requestCredential =
                                        currentCredential.credential;
                                    requestCredentialCurrentness =
                                        currentCredential.isCurrent;
                                } finally {
                                    credentialSignals.cleanup();
                                }
                            }
                            if (!isCurrent()) {
                                return requestUnavailable(
                                    'Managed-service endpoint is unavailable',
                                );
                            }
                            const injectedHeaders: Record<string, string> = {
                                ...providerHeaders,
                            };
                            if (requestCredential?.httpHeader) {
                                injectedHeaders[
                                    requestCredential.httpHeader.name
                                ] = requestCredential.httpHeader.value;
                            }
                            const headers = mergeManagedServiceRequestHeaders(
                                normalized.headers,
                                injectedHeaders,
                            );
                            const target = resolveManagedServiceRequestTarget(
                                endpoint.baseUrl,
                                normalized.pathAndQuery,
                            );
                            const requestBody = normalized.body === undefined
                                ? undefined
                                : Uint8Array.from(normalized.body);
                            return await executeManagedServiceFetch({
                                fetch: hostFetch,
                                target,
                                init: {
                                    method: normalized.method,
                                    headers,
                                    ...(requestBody
                                        ? { body: requestBody }
                                        : {}),
                                },
                                signals: [
                                    lifetimeSignal,
                                    scope.signal,
                                    normalized.signal,
                                ],
                                ...(normalized.signal
                                    ? { callerSignal: normalized.signal }
                                    : {}),
                                timeoutMs: normalized.timeoutMs,
                                isCurrent,
                                ...(requestCredentialCurrentness
                                    ? {
                                        isDispatchCurrent:
                                            requestCredentialCurrentness,
                                    }
                                    : {}),
                            });
                        };
                        const wrapped = wrapHandle(
                            handle,
                            cleanupCredentials,
                            Object.freeze({
                                status: normalizedSpec.mode.kind !== 'attach'
                                    ? 'stopped'
                                    : 'detached',
                            }),
                            normalizedSpec.startupTimeoutMs,
                            requestFromExactHandle,
                            scope.signal,
                            () => {
                                entry.terminal = true;
                                const operation =
                                    explicitStartOperationForScope(scope);
                                if (operation) operation.terminal = true;
                            },
                            () => {
                                removeSemanticEntry(entry);
                                const operation =
                                    explicitStartOperationForScope(scope);
                                if (
                                    operation?.terminal
                                    && managedServiceEntriesForExplicitStartOperation(
                                        operation,
                                    ).length === 0
                                ) {
                                    if (operation.retirementGroup) {
                                        void retireExplicitStartOperation(operation).catch(() => undefined);
                                    } else {
                                        removeSemanticEntry(operation);
                                    }
                                }
                            },
                        );
                        clientEnvironmentByService.set(
                            wrapped,
                            async (environmentKey, signal) => {
                                assertCanonicalName(environmentKey, 'environment');
                                if (
                                    signal?.aborted
                                    || entry.terminal
                                    || !readsCurrent(scope.isOccurrenceCurrent)
                                ) {
                                    return fail(
                                        'plugin_managed_service_unavailable',
                                        'Managed-service client environment is unavailable',
                                    );
                                }
                                if (clientAccess.kind === 'none') {
                                    return Object.freeze({});
                                }
                                const current = resolveCurrentDeclaredClientCredential
                                    ? await resolveCurrentDeclaredClientCredential(signal)
                                    : null;
                                const value = current?.environmentValue
                                    ?? staticClientCredential?.environment?.value;
                                if (
                                    !value
                                    || current?.isCurrent
                                        && !await current.isCurrent(signal)
                                    || signal?.aborted
                                    || entry.terminal
                                    || !readsCurrent(scope.isOccurrenceCurrent)
                                ) {
                                    return fail(
                                        'plugin_managed_service_unavailable',
                                        'Managed-service client environment is unavailable',
                                    );
                                }
                                return Object.freeze({ [environmentKey]: value });
                            },
                        );
                        if (context.managedProvider) {
                            endpointAccessByService.set(
                                wrapped,
                                Object.freeze({
                                    scope,
                                    binding: context.managedProvider,
                                    clientAccess,
                                    credential: staticClientCredential,
                                    requestHeaders:
                                        materialized.requestHeaders,
                                }),
                            );
                        }
                        materialized = null;
                        entry.processHandle = null;
                        entry.credentialCleanup = null;
                        return wrapped;
                    } catch (error) {
                        try {
                            await releaseEntryCredentialCleanup(entry);
                        } catch (cleanupError) {
                            throw managedServiceCleanupAggregate(
                                [
                                    error,
                                    cleanupError,
                                ],
                                'Managed-service establishment and credential cleanup failed',
                            );
                        }
                        throw error;
                    } finally {
                        establishmentSignals.cleanup();
                    }
                })().finally(() => {
                    entry.establishmentSettled = true;
                    notifyActivity();
                }).catch((error) => {
                    entry.terminal = true;
                    if (
                        entry.processHandle === null
                        && entry.establishmentCleanup === null
                        && entry.credentialCleanup === null
                    ) {
                        removeSemanticEntry(entry);
                    }
                    if (error instanceof AggregateError) {
                        throw managedServiceCleanupAggregate(
                            [error],
                            'Managed-service establishment cleanup failed',
                        );
                    }
                    return translateError(error);
                });
                semanticEntries.set(entryKey, entry);
                notifyActivity();
                return sharedConsumers
                    ? await acquireSharedConsumer(entry, suppliedScope, suppliedBindingContext, options?.signal)
                    : await waitForManagedServiceEstablishment(entry, options?.signal);
            },
        } satisfies ManagedServices);
        return services;
    };
    const projectEntries = () => [...semanticEntries.values()]
        .filter(isProjectManagedServiceSemanticEntry);
    const listProjectServices = (options?: Readonly<{ requireComplete?: true; workspaceRoot?: string }>): readonly ProjectManagedServiceHandle[] => {
        const matching = projectEntries().filter(entry => !options?.workspaceRoot
            || isWorkspacePathWithin(options.workspaceRoot, entry.project.cwd));
        if (options?.requireComplete && (projectRetirementStarted
            || matching.some(entry => !entry.project.handle || !entry.project.handle.isCurrent()))) {
            return fail('plugin_managed_service_unavailable', 'Project service native custody is unsettled');
        }
        return Object.freeze(matching.flatMap(entry => entry.project.handle ? [entry.project.handle] : []));
    };
    const superviseProject = async (
        request: ProjectManagedServiceSupervisionInput,
    ): Promise<ProjectManagedServiceHandle> => {
        const assertAcceptingProjectSupervision = (): void => {
            if (projectRetirementStarted) {
                fail('plugin_managed_service_unavailable', 'Project service custody owner is retired');
            }
        };
        assertAcceptingProjectSupervision();
        if (request.signal?.aborted) {
            return fail('plugin_operation_aborted', 'Project service supervision was aborted');
        }
        if (
            input.processSupervisorHost.custodyOwner !== 'daemon'
            || !readsCurrent(request.isCurrent)
        ) {
            return fail('plugin_managed_service_unavailable', 'Current Project service admission is unavailable');
        }
        const workspace = Object.freeze(WorkspaceRefV1Schema.parse(request.workspace));
        const declaration = Object.freeze(ProjectServiceDeclarationRefV1Schema.parse(request.declaration));
        const requester = Object.freeze(RequesterWorkAttributionV1Schema.parse(request.requester));
        if (
            !isAbsolute(request.cwd)
            || declaration.workspaceRefId !== workspace.id
            || requester.serverId !== workspace.serverId
            || requester.machineId !== workspace.machineId
            || !request.serviceId.trim()
            || !request.specIdentity.trim()
        ) {
            return fail('plugin_managed_service_unavailable', 'Project service provenance does not match its admitted Workspace');
        }
        const witness = Object.freeze({
            workspace,
            declaration,
            requester,
            cwd: request.cwd,
            serviceId: request.serviceId,
        });
        const entryKey = JSON.stringify([
            'project-service', workspace.serverId, workspace.machineId,
            workspace.id, declaration, request.cwd,
        ]);
        const existing = semanticEntries.get(entryKey);
        if (existing) {
            if (
                !isProjectManagedServiceSemanticEntry(existing)
                || existing.specIdentity !== request.specIdentity
            ) {
                return fail('plugin_managed_service_spec_conflict', 'A different reviewed service effect owns this Project declaration');
            }
            if (existing.terminal || existing.establishmentAbort.signal.aborted) {
                await retireEntry(existing);
                return await superviseProject(request);
            }
            await waitForManagedServiceEstablishment(existing, request.signal);
            if (!existing.project.handle || !readsCurrent(request.isCurrent)) {
                return fail('plugin_managed_service_unavailable', 'Project service admission changed');
            }
            return existing.project.handle;
        }
        const lifetime = new AbortController();
        const isCurrent = (): boolean => (
            !lifetime.signal.aborted && readsCurrent(request.isCurrent)
        );
        const scope: ProjectManagedServicesScope = {
            signal: lifetime.signal,
            isOccurrenceCurrent: isCurrent,
        };
        const entry: ManagedServiceSemanticEntry & { authority: 'project' } = {
            kind: 'service',
            authority: 'project',
            effectiveOwnerKey: entryKey,
            lifecycle: {
                kind: 'project',
                identity: entryKey,
                retainedAcrossOrdinaryGenerationRetirement: false,
            },
            scope,
            specIdentity: request.specIdentity,
            project: { ...witness, handle: null },
            establishmentAbort: lifetime,
            establishment: Promise.resolve(null as never),
            establishmentSettled: false,
            waiterCount: 0,
            terminal: false,
            processHandle: null,
            readProcessSnapshot: null,
            establishmentCleanup: null,
            credentialCleanup: null,
            retirement: null,
        };
        const assertCurrent = (): void => {
            assertAcceptingProjectSupervision();
            if (!isCurrent()) {
                fail('plugin_managed_service_unavailable', 'Project service admission changed');
            }
        };
        entry.establishment = (async () => {
            assertCurrent();
            const commonSpec = {
                id: request.serviceId,
                startupTimeoutMs: request.processSpec.startupTimeoutMs,
                ...(request.processSpec.healthCheck ? { healthCheck: request.processSpec.healthCheck } : {}),
                watchdog: request.processSpec.watchdog ?? {
                    intervalMs: MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue,
                    missedIntervals: MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures.defaultValue,
                },
                authorizeLaunch: async (launchInput: Parameters<ProjectManagedServiceLaunchAuthorizer>[0]) => {
                    assertCurrent();
                    const authorized = await request.authorizeLaunch(launchInput);
                    try {
                        assertCurrent();
                    } catch (error) {
                        await authorized.release();
                        throw error;
                    }
                    return authorized;
                },
            };
            const processSpec: ManagedServiceProcessSpec = request.processSpec.mode.kind === 'native'
                ? { ...commonSpec, mode: request.processSpec.mode }
                : { ...commonSpec, mode: request.processSpec.mode };
            const processSupervisor = input.processSupervisorHost.bind({
                kind: 'project',
                isOccurrenceCurrent: isCurrent,
            });
            const process = await processSupervisor.supervise(processSpec, {
                signal: lifetime.signal,
                registerEstablishmentCleanup(cleanup, observation) {
                    entry.establishmentCleanup = cleanup;
                    entry.readProcessSnapshot = observation.snapshot;
                    entry.readAcquiredCustody = observation.hasAcquiredCustody;
                    return Object.freeze({
                        release() {
                            if (entry.establishmentCleanup === cleanup) {
                                entry.establishmentCleanup = null;
                            }
                        },
                    });
                },
            });
            entry.processHandle = process;
            entry.readProcessSnapshot = () => process.snapshot();
            observeServiceProcess(entry, process);
            entry.establishmentCleanup = null;
            try {
                assertCurrent();
            } catch (error) {
                await releaseEntryProcessHandle(entry, true);
                throw error;
            }
            const wrapped = wrapHandle(
                process,
                async () => {},
                { status: 'stopped' },
                request.processSpec.startupTimeoutMs,
                async (rawRequest, requestLifetime) => {
                    const normalized = normalizeManagedServiceRequest(rawRequest);
                    const endpoint = readHealthyServiceProcessEndpoint(process);
                    if (!endpoint) {
                        return requestUnavailable('Project service endpoint is unavailable');
                    }
                    const dispatchCurrent = (): boolean => {
                        const current = readHealthyServiceProcessEndpoint(process);
                        return isCurrent()
                            && !requestLifetime.aborted
                            && current !== null
                            && current.instanceId === endpoint.instanceId
                            && current.baseUrl.toString() === endpoint.baseUrl.toString();
                    };
                    return await executeManagedServiceFetch({
                        fetch: hostFetch,
                        target: resolveManagedServiceRequestTarget(endpoint.baseUrl, normalized.pathAndQuery),
                        init: {
                            method: normalized.method,
                            headers: normalized.headers,
                            ...(normalized.body ? { body: Uint8Array.from(normalized.body) } : {}),
                        },
                        signals: [lifetime.signal, requestLifetime, normalized.signal],
                        ...(normalized.signal ? { callerSignal: normalized.signal } : {}),
                        timeoutMs: normalized.timeoutMs,
                        isCurrent: dispatchCurrent,
                    });
                },
                lifetime.signal,
                () => {
                    entry.terminal = true;
                },
                () => {
                    lifetime.abort('Project service custody settled');
                    removeSemanticEntry(entry);
                },
                // The Project lifetime retires serving immediately. Its trusted
                // custody owner performs Stop after the final Home recheck.
                false,
            );
            const handle = Object.freeze({
                ...wrapped,
                ...witness,
                instanceId: process.snapshot().instanceId,
                endpointKind: request.processSpec.mode.kind === 'native' ? 'native' as const
                    : request.processSpec.mode.endpointNone ? 'none' as const : 'http' as const,
                retirementSignal: lifetime.signal,
                isCurrent,
            });
            entry.project.handle = handle;
            entry.processHandle = null;
            return handle;
        })().finally(() => {
            entry.establishmentSettled = true;
            notifyActivity();
        }).catch((error) => {
            entry.terminal = true;
            if (!entry.processHandle && !entry.establishmentCleanup) {
                removeSemanticEntry(entry);
            }
            return translateError(error);
        });
        semanticEntries.set(entryKey, entry);
        notifyActivity();
        await waitForManagedServiceEstablishment(entry, request.signal);
        if (!entry.project.handle) {
            return fail('plugin_managed_service_unavailable', 'Project service establishment is unavailable');
        }
        return entry.project.handle;
    };
    return Object.freeze({
        activity,
        readRetainedSemanticCustodyCount: () => semanticEntries.size,
        superviseProject,
        listProjectServices,
        resolveProjectService(target: Extract<LocalServiceActionTargetV1, { kind: 'managed_service' }>) {
            const handle = listProjectServices().find(candidate => candidate.instanceId === target.managedServiceId);
            if (!handle) {
                return Object.freeze({ status: 'unknown' as const });
            }
            const declaration = ProjectServiceDeclarationRefV1Schema.safeParse(target.declaration);
            if (
                target.machineId !== handle.workspace.machineId
                || target.cwd !== handle.cwd
                || !declaration.success
                || JSON.stringify(declaration.data) !== JSON.stringify(handle.declaration)
                || target.workspaceId !== undefined && target.workspaceId !== handle.workspace.id
                || target.sessionId !== undefined
            ) {
                return Object.freeze({ status: 'mismatch' as const });
            }
            return Object.freeze({ status: 'found' as const, handle });
        },
        async stopForAccessLoss(requester: RequesterWorkAttributionV1, options?: Readonly<{
            verifyCurrentMachineAdmission: () => Promise<boolean>;
        }>) {
            const matching = projectEntries().filter(entry => (
                entry.project.requester.serverId === requester.serverId
                && entry.project.requester.accountId === requester.accountId
                && entry.project.requester.machineId === requester.machineId
                && entry.project.requester.installationId === requester.installationId
            ));
            return await Promise.all(matching.map(async (entry): Promise<ProjectServiceAccessLossResult> => {
                const { handle: _handle, ...witness } = entry.project;
                const incomplete = (): ProjectServiceAccessLossResult => {
                    const handle = entry.project.handle;
                    const rawSnapshot = entry.readProcessSnapshot?.();
                    return Object.freeze({
                        ...witness,
                        status: 'termination_incomplete',
                        instanceId: handle?.instanceId ?? rawSnapshot?.instanceId ?? null,
                        snapshot: handle?.snapshot() ?? (rawSnapshot ? translateSnapshot(rawSnapshot) : null),
                    });
                };
                const currentLoss = async (): Promise<boolean> => {
                    try {
                        return !options || await options.verifyCurrentMachineAdmission() === true;
                    } catch {
                        return false;
                    }
                };
                if (!await currentLoss()) return incomplete();
                entry.terminal = true;
                entry.establishmentAbort.abort('Requester lost final effective Machine access');
                try {
                    const established = await entry.establishment.catch(() => null);
                    if (!await currentLoss()) return incomplete();
                    if (established && entry.project.handle) {
                        await established.stop();
                        if (!await currentLoss()) return incomplete();
                        return Object.freeze({
                            ...witness,
                            status: 'stopped',
                            instanceId: entry.project.handle.instanceId,
                            snapshot: established.snapshot(),
                        });
                    }
                    await retireEntry(entry);
                    if (!await currentLoss()) return incomplete();
                    if (entry.readAcquiredCustody?.()) {
                        const snapshot = entry.readProcessSnapshot?.();
                        if (!snapshot || snapshot.state !== 'stopped') {
                            return Object.freeze({
                                ...witness,
                                status: 'termination_incomplete',
                                instanceId: snapshot?.instanceId ?? null,
                                snapshot: snapshot ? translateSnapshot(snapshot) : null,
                            });
                        }
                        return Object.freeze({
                            ...witness,
                            status: 'stopped',
                            instanceId: snapshot.instanceId,
                            snapshot: translateSnapshot(snapshot),
                        });
                    }
                    return Object.freeze({ ...witness, status: 'cancelled_preparation', instanceId: null });
                } catch (error) {
                    const handle = entry.project.handle;
                    return Object.freeze({
                        ...witness,
                        status: isPluginError(error) && error.code === 'plugin_managed_service_unavailable'
                            ? 'unsupported' : 'termination_incomplete',
                        instanceId: handle?.instanceId ?? entry.readProcessSnapshot?.().instanceId ?? null,
                        snapshot: handle?.snapshot() ?? (entry.readProcessSnapshot ? translateSnapshot(entry.readProcessSnapshot()) : null),
                    });
                }
            }));
        },
        isAvailable({ occurrenceId, contributionQualifiedId }) {
            return input.resolveScope({
                occurrenceId,
                pluginId:
                    contributionQualifiedId.split('/')[0]
                    ?? '',
                contributionQualifiedId,
                isOccurrenceCurrent: () => true,
            }) !== null;
        },
        bind() {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed services require the invocation exec owner',
            );
        },
        bindWithExec(seed, exec, context) {
            const resolvedScope = input.resolveScope({
                occurrenceId: seed.occurrenceId,
                ...(seed.sourceCustody
                    ? { sourceCustody: seed.sourceCustody }
                    : {}),
                pluginId: seed.plugin.id,
                contributionQualifiedId:
                    seed.contribution.qualifiedId,
                ...(seed.session
                    ? { sessionId: seed.session.id }
                    : {}),
                signal: seed.signal,
                isOccurrenceCurrent:
                    seed.isOccurrenceCurrent,
            }, context);
            if (!resolvedScope) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed-services invocation scope is unavailable',
                );
            }
            const operationId = context.managedProvider
                ?.operationClaimId?.trim()
                || seed.correlationId.trim();
            const scope = operationId
                ? Object.freeze({ ...resolvedScope, operationId })
                : resolvedScope;
            return bindScope(scope, exec, context);
        },
        async runManagedProviderExplicitStart(operationInput) {
            const acceptsOperation = () => operationInput.sharedProvider
                ? !sharedProviderRetirementStarted : !permanentRetirementStarted;
            if (!acceptsOperation()) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            if (operationInput.retirementGroup) {
                const retiring = [...semanticEntries.values()].filter(
                    (entry): entry is ManagedProviderExplicitStartOperationEntry => (
                        !isManagedServiceSemanticEntry(entry) && entry.terminal
                        && entry.retirementGroup?.identity === operationInput.retirementGroup?.identity
                    ),
                );
                if (retiring.length > 0) {
                    // A later invocation may finish previously failed cleanup,
                    // but it cannot rejoin the authority being retired.
                    for (const entry of retiring) {
                        if (!entry.retirement) await retireExplicitStartOperation(entry);
                    }
                    return Object.freeze({ status: 'unavailable' as const });
                }
            }
            const operationId = operationInput.operationId.trim();
            const pluginId = operationInput.pluginId.trim();
            const contributionQualifiedId =
                operationInput.contributionQualifiedId.trim();
            const occurrenceId = operationInput.occurrenceId.trim();
            const purposeBindingsEqualityKey =
                operationInput.purposeBindingsEqualityKey.trim();
            if (
                !operationId
                || !pluginId
                || !occurrenceId
                || !purposeBindingsEqualityKey
                || !contributionQualifiedId.startsWith(
                    `${pluginId}/providers/`,
                )
            ) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            if (
                operationInput.signal?.aborted
                || !readsCurrent(operationInput.isCurrent)
            ) {
                return Object.freeze({ status: 'not_current' as const });
            }
            const entryKey = managedProviderExplicitStartOperationEntryKey({
                operationId,
                pluginId,
                contributionQualifiedId,
            });
            let existing = semanticEntries.get(entryKey);
            if (existing && isManagedServiceSemanticEntry(existing)) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            const retainedServices =
                managedServiceEntriesForExplicitStartOperation({
                    operationId,
                    pluginId,
                    contributionQualifiedId,
                    occurrenceId,
                });
            if (retainedServices.some((entry) => entry.terminal)) {
                for (const retained of retainedServices) {
                    if (retained.terminal) await retireEntry(retained);
                }
                existing = semanticEntries.get(entryKey);
                if (existing && isManagedServiceSemanticEntry(existing)) {
                    return Object.freeze({ status: 'unavailable' as const });
                }
            }
            if (
                existing
                && managedServiceEntriesForExplicitStartOperation(existing)
                    .some((entry) => entry.terminal)
            ) {
                existing.terminal = true;
            }
            if (
                existing
                && existing.purposeBindingsEqualityKey
                    !== purposeBindingsEqualityKey
            ) {
                await retireExplicitStartOperation(existing);
                return Object.freeze({ status: 'not_current' as const });
            }
            if (existing?.terminal) {
                await retireExplicitStartOperation(existing);
                existing = semanticEntries.get(entryKey);
                if (existing && isManagedServiceSemanticEntry(existing)) {
                    return Object.freeze({ status: 'unavailable' as const });
                }
            }
            if (existing) {
                if (
                    existing.occurrenceId !== occurrenceId
                    || !readsCurrent(existing.isCurrent)
                ) {
                    return Object.freeze({ status: 'not_current' as const });
                }
                try {
                    const value = await existing.establishment;
                    if (existing.terminal) {
                        await retireExplicitStartOperation(existing);
                        return Object.freeze({
                            status: 'not_current' as const,
                        });
                    }
                    return acceptsOperation()
                        && semanticEntries.get(entryKey) === existing
                        && readsCurrent(operationInput.isCurrent)
                        ? Object.freeze({
                            status: 'established' as const,
                            value: projectManagedProviderExplicitStartJoin(
                                value,
                                operationInput,
                            ),
                        })
                        : Object.freeze({ status: 'not_current' as const });
                } catch (error) {
                    throw error;
                }
            }

            // A terminal physical service can outlive its explicit-start
            // claim while cleanup is incomplete.  Re-admit through that
            // retained custody before invoking the caller's establishment
            // callback; otherwise a new launch attempt could race an exact
            // child whose absence has not been proven.
            const orphanedRetainedServices =
                managedServiceEntriesForExplicitStartOperation({
                    operationId,
                    pluginId,
                    contributionQualifiedId,
                    occurrenceId,
                });
            if (orphanedRetainedServices.some((entry) => !entry.terminal)) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            for (const retained of orphanedRetainedServices) {
                await retireEntry(retained);
            }

            const abort = new AbortController();
            let entry!: ManagedProviderExplicitStartOperationEntry;
            let released = false;
            const release = async (): Promise<void> => {
                if (released) return;
                released = true;
                entry.terminal = true;
                abort.abort('Managed Provider explicit-start operation retired');
                // The canonical retirement owns removal once every closer
                // settles. Its projection can release this claim while an
                // earlier resource failed; keep the exact entry for retry.
                if (!entry.retirementGroup && !entry.retirement) removeSemanticEntry(entry);
            };
            entry = {
                ...(operationInput.sharedProvider ? { sharedProvider: true as const } : {}),
                kind: 'explicitStartOperation',
                operationId,
                pluginId,
                contributionQualifiedId,
                occurrenceId,
                purposeBindingsEqualityKey,
                isCurrent: operationInput.isCurrent,
                lifecycleKind:
                    operationInput.lifecycleKind ?? 'publicExplicitStart',
                retirementGroup: operationInput.retirementGroup,
                cleanupComplete: false,
                revalidateRetainedCurrentness:
                    operationInput.revalidateRetainedCurrentness ?? null,
                abort,
                establishment: Promise.resolve(null as never),
                terminal: false,
                retirement: null,
            };
            entry.establishment = Promise.resolve().then(async () => {
                if (
                    !acceptsOperation()
                    || entry.terminal
                    || !readsCurrent(operationInput.isCurrent)
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider explicit-start authority is unavailable',
                    );
                }
                return await operationInput.establish(Object.freeze({
                    signal: abort.signal,
                    release,
                }));
            }).catch((error) => {
                entry.terminal = true;
                if (!entry.retirementGroup) removeSemanticEntry(entry);
                throw error;
            });
            semanticEntries.set(entryKey, entry);
            notifyActivity();
            try {
                const value = await entry.establishment;
                return acceptsOperation()
                    && !entry.terminal
                    && semanticEntries.get(entryKey) === entry
                    && readsCurrent(operationInput.isCurrent)
                    ? Object.freeze({
                        status: 'established' as const,
                        value: projectManagedProviderExplicitStartJoin(
                            value,
                            operationInput,
                        ),
                    })
                    : Object.freeze({ status: 'not_current' as const });
            } catch (error) {
                // An establishment failure still owns the external operation
                // claim until its cleanup and retirement-group acknowledgement
                // have completed. Reuse the existing retirement owner so the
                // Home-side current-operation binding is released exactly once.
                // `entry.establishment` is already settled here, so retirement
                // can safely await its rejected promise without a cycle.
                await retireExplicitStartOperation(entry);
                throw error;
            }
        },
        async retireManagedProviderExplicitStart({
            operationId,
            pluginId,
            contributionQualifiedId,
        }) {
            const entry = semanticEntries.get(
                managedProviderExplicitStartOperationEntryKey({
                    operationId: operationId.trim(),
                    pluginId: pluginId.trim(),
                    contributionQualifiedId:
                        contributionQualifiedId.trim(),
                }),
            );
            if (!entry || isManagedServiceSemanticEntry(entry)) return false;
            await retireExplicitStartOperation(entry);
            return true;
        },
        async revalidateManagedProviderExplicitStarts(signal) {
            signal?.throwIfAborted();
            const candidates = [...semanticEntries.values()].filter(
                (entry): entry is ManagedProviderExplicitStartOperationEntry => (
                    !isManagedServiceSemanticEntry(entry)
                    && (entry.terminal || entry.revalidateRetainedCurrentness !== null)
                ),
            );
            const results = await Promise.all(candidates.map(async (entry) => {
                signal?.throwIfAborted();
                if (semanticEntries.get(managedProviderExplicitStartOperationEntryKey(entry)) !== entry) return false;
                // A failed closer already withdrew authority. Its exact claim
                // remains here solely for cleanup, not another currentness
                // decision or acquisition.
                if (entry.terminal) {
                    await retireExplicitStartOperation(entry);
                    return true;
                }
                let current = false;
                try {
                    const established = await entry.establishment;
                    signal?.throwIfAborted();
                    const readSignal = signal
                        ? AbortSignal.any([signal, entry.abort.signal])
                        : entry.abort.signal;
                    const retainedCurrent =
                        established.projection.isCurrent() === true
                        && await entry.revalidateRetainedCurrentness!(readSignal) === true;
                    signal?.throwIfAborted();
                    current = retainedCurrent;
                } catch {
                    signal?.throwIfAborted();
                    // An unreadable currentness source is unknown, not
                    // authority loss. Preserve the retained operation so a
                    // later revalidation can decide it from fresh evidence.
                    return false;
                }
                if (
                    current
                    || entry.terminal
                    || semanticEntries.get(
                        managedProviderExplicitStartOperationEntryKey(entry),
                    ) !== entry
                ) return false;
                await retireExplicitStartOperation(entry);
                return true;
            }));
            return results.filter(Boolean).length;
        },
        async retireManagedProviderExplicitStarts(lifecycleKind) {
            const candidates = [...semanticEntries.values()].filter(
                (entry): entry is ManagedProviderExplicitStartOperationEntry => (
                    !isManagedServiceSemanticEntry(entry)
                    && entry.lifecycleKind === lifecycleKind
                ),
            );
            await Promise.all(candidates.map(async (entry) => {
                await retireExplicitStartOperation(entry);
            }));
            return candidates.length;
        },
        bindSessionManagedServiceRequest(requestInput) {
            const entry = resolveSessionManagedServiceEntry(requestInput);
            if (!entry) return null;
            return async (request) => {
                if (resolveSessionManagedServiceEntry(requestInput) !== entry) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed-service handle is unavailable',
                    );
                }
                const handle = await entry.establishment;
                if (resolveSessionManagedServiceEntry(requestInput) !== entry) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed-service handle is unavailable',
                    );
                }
                return await handle.request(request);
            };
        },
        async materializeSessionManagedServiceClientEnvironment(requestInput) {
            const entry = resolveSessionManagedServiceEntry(requestInput);
            if (!entry) return null;
            const service = await entry.establishment;
            if (resolveSessionManagedServiceEntry(requestInput) !== entry) return null;
            const materialize = clientEnvironmentByService.get(service);
            const environment = materialize
                ? await materialize(
                    requestInput.environmentKey,
                    requestInput.signal,
                )
                : null;
            return resolveSessionManagedServiceEntry(requestInput) === entry ? environment : null;
        },
        async projectManagedProviderEndpointAccess({
            service,
            endpoints,
            signal,
            isCurrent: isCallerCurrent,
        }): Promise<ManagedProviderEndpointAccessProjection | null> {
            const facts = endpointAccessByService.get(service);
            if (
                !facts
                || projectedEndpointAccess.has(service)
                || signal.aborted
                || facts.scope.signal?.aborted
                || !readsCurrent(facts.scope.isOccurrenceCurrent)
                || !readsCurrent(facts.binding.isCurrent)
                || !readsCurrent(isCallerCurrent)
            ) return null;
            let projectedEndpoint = readHealthyServiceEndpoint(service);
            if (!projectedEndpoint) {
                try {
                    await service.waitUntilHealthy({ signal });
                } catch {
                    return null;
                }
                if (
                    signal.aborted
                    || facts.scope.signal?.aborted
                    || !readsCurrent(facts.scope.isOccurrenceCurrent)
                    || !readsCurrent(facts.binding.isCurrent)
                    || !readsCurrent(isCallerCurrent)
                ) return null;
                projectedEndpoint = readHealthyServiceEndpoint(service);
            }
            if (!projectedEndpoint) return null;
            const endpointUrls = resolveManagedProviderEndpointUrls(
                projectedEndpoint.baseUrl,
                endpoints,
            );
            if (!endpointUrls) return null;
            projectedEndpointAccess.add(service);
            const lifetime = new AbortController();
            let active = true;
            const readsAccessCurrent = (): boolean => {
                const currentEndpoint =
                    readHealthyServiceEndpoint(service);
                return active
                    && !lifetime.signal.aborted
                    && !signal.aborted
                    && !facts.scope.signal?.aborted
                    && readsCurrent(facts.scope.isOccurrenceCurrent)
                    && readsCurrent(facts.binding.isCurrent)
                    && readsCurrent(isCallerCurrent)
                    && currentEndpoint !== null
                    && currentEndpoint.baseUrl.toString()
                        === projectedEndpoint.baseUrl.toString()
                    && currentEndpoint.startedAtMs
                        === projectedEndpoint.startedAtMs;
            };
            const unavailable = (): never => fail(
                'plugin_managed_service_unavailable',
                'Managed Provider endpoint access is unavailable',
            );
            const access = Object.freeze({
                endpointUrl(endpointTemplateId: string): string | null {
                    if (!readsAccessCurrent()) return null;
                    return endpointUrls.get(endpointTemplateId)?.toString()
                        ?? null;
                },
                /**
                 * The one transport for an admitted managed Provider endpoint.
                 * It scopes the caller's relative request to the declared
                 * endpoint paths, then dispatches through the exact supervised
                 * handle, so header injection, credential currentness, redirect
                 * refusal and request bounding have a single owner.
                 */
                async request(
                    request: ManagedServiceRequest,
                ): Promise<ManagedServiceResponse> {
                    if (!readsAccessCurrent()) return unavailable();
                    let target: URL;
                    try {
                        target = new URL(
                            request.pathAndQuery,
                            projectedEndpoint.baseUrl,
                        );
                    } catch {
                        return unavailable();
                    }
                    if (
                        // The scheme and origin have to be the supervised
                        // endpoint's own, so an attached https server is
                        // reachable while a request still cannot leave it.
                        target.protocol !== projectedEndpoint.baseUrl.protocol
                        || target.origin !== projectedEndpoint.baseUrl.origin
                        || target.username !== ''
                        || target.password !== ''
                        || target.hash !== ''
                        || !isWithinEndpointPath(target, endpointUrls)
                    ) return unavailable();
                    // The response body outlives this call frame, so the
                    // composed signal must too: `composeAbortSignals` needs a
                    // deterministic teardown this scope cannot provide.
                    const signals = [
                        lifetime.signal,
                        signal,
                        facts.scope.signal,
                        request.signal,
                    ].filter((candidate): candidate is AbortSignal => (
                        candidate !== undefined && candidate !== null
                    ));
                    return await service.request({
                        pathAndQuery: `${target.pathname}${target.search}`,
                        ...(request.method ? { method: request.method } : {}),
                        ...(request.headers ? { headers: request.headers } : {}),
                        ...(request.body ? { body: request.body } : {}),
                        timeoutMs: request.timeoutMs,
                        signal: signals.length === 1
                            ? signals[0]!
                            : AbortSignal.any(signals),
                    });
                },
            });
            let cleaned = false;
            return Object.freeze({
                access,
                isCurrent: readsAccessCurrent,
                async cleanup() {
                    if (cleaned) return;
                    active = false;
                    lifetime.abort(
                        'Managed Provider endpoint access retired',
                    );
                    if (facts.binding.sharedGateway) await service.dispose();
                    cleaned = true;
                },
            });
        },
        async materializeManagedProviderAgentBinding({
            service,
            projection,
            endpointTemplateId,
            materialize,
        }) {
            const facts = endpointAccessByService.get(service);
            const credential = facts?.credential;
            const rawCredential = credential?.environment?.value;
            const renderedCredential = credential?.httpHeader?.value;
            const endpointUrl = projection.access.endpointUrl(
                endpointTemplateId,
            );
            if (
                !facts
                || !endpointUrl
                || !projection.isCurrent()
                || !readsCurrent(facts.scope.isOccurrenceCurrent)
                || !readsCurrent(facts.binding.isCurrent)
            ) return null;
            if (facts.clientAccess.kind === 'none') {
                const rawMaterialization = await materialize({
                    endpointUrl,
                    credentialPlaceholder: null,
                });
                if (
                    endpointAccessByService.get(service) !== facts
                    || !projection.isCurrent()
                    || !readsCurrent(facts.scope.isOccurrenceCurrent)
                    || !readsCurrent(facts.binding.isCurrent)
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider authority changed during Agent materialization',
                    );
                }
                return Object.freeze({
                    materialization:
                        AgentProviderBindingMaterializationV1Schema.parse(
                            rawMaterialization,
                        ),
                    redactionValues: Object.freeze([]),
                    httpBinding: Object.freeze({ endpointUrl, headers: Object.freeze({}) }),
                    transformLaunchEnvironment: (
                        environment: Readonly<Record<string, string>>,
                    ) => environment,
                });
            }
            if (!credential || !rawCredential || !renderedCredential) {
                return null;
            }
            const credentialPlaceholder =
                `happier_runner_provider_${randomBytes(32).toString('base64url')}`;
            const renderedCredentialPlaceholder =
                renderHostClientCredential(
                    facts.clientAccess,
                    credentialPlaceholder,
                )?.httpHeader?.value;
            if (!renderedCredentialPlaceholder) return null;
            const rawMaterialization = await materialize({
                endpointUrl,
                credentialPlaceholder,
            });
            if (
                endpointAccessByService.get(service) !== facts
                || !projection.isCurrent()
                || !readsCurrent(facts.scope.isOccurrenceCurrent)
                || !readsCurrent(facts.binding.isCurrent)
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed Provider authority changed during Agent materialization',
                );
            }
            const transformer =
                createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
                materialization: rawMaterialization,
                placeholder: credentialPlaceholder,
                credential: rawCredential,
                renderedPlaceholder:
                    renderedCredentialPlaceholder,
                renderedCredential,
                isCurrent: () => (
                    endpointAccessByService.get(service) === facts
                    && projection.isCurrent()
                    && readsCurrent(facts.scope.isOccurrenceCurrent)
                    && readsCurrent(facts.binding.isCurrent)
                ),
            });
            return Object.freeze({
                materialization: transformer.materialization,
                redactionValues: transformer.redactionValues,
                httpBinding: Object.freeze({ endpointUrl, headers: Object.freeze({ [credential.httpHeader!.name]: renderedCredential }) }),
                transformLaunchEnvironment: transformer.transform,
            });
        },
        async retireGeneration(occurrenceId, pluginId) {
            const retiring = [...semanticEntries.values()].filter((entry) => {
                if (isManagedServiceSemanticEntry(entry) ? entry.sharedConsumers !== undefined : entry.sharedProvider === true) return false;
                if (!isManagedServiceSemanticEntry(entry)) {
                    return entry.occurrenceId === occurrenceId
                        && entry.pluginId === pluginId;
                }
                return entry.occurrenceId === occurrenceId
                    && entry.pluginId === pluginId
                    && (
                        entry.processHandle !== null
                        || entry.establishmentCleanup !== null
                        || entry.credentialCleanup !== null
                        || !entry.lifecycle
                            .retainedAcrossOrdinaryGenerationRetirement
                    );
            });
            const results = await Promise.allSettled(
                retiring.map(retireSemanticEntry),
            );
            const failures = flattenManagedServiceCleanupFailures(
                results.flatMap((result) => result.status === 'rejected'
                    ? [result.reason]
                    : []),
            );
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    'Failed to retire managed services for the plugin occurrenceId',
                );
            }
        },
        async retireProjectServices() {
            projectRetirementStarted = true;
            const results = await Promise.allSettled(projectEntries().map(retireEntry));
            const failures = flattenManagedServiceCleanupFailures(results.flatMap(result => (
                result.status === 'rejected' ? [result.reason] : []
            )));
            if (failures.length > 0) {
                throw new AggregateError(failures, 'Failed to retire Project service custody');
            }
        },
        configureHostBindings(bindings) {
            input = Object.freeze({ ...input, ...bindings });
        },
        async retireSharedProviderServices(pluginIds) {
            if (!pluginIds) sharedProviderRetirementStarted = true;
            const entries = [...semanticEntries.values()].filter(entry => (
                (isManagedServiceSemanticEntry(entry) ? entry.sharedConsumers !== undefined : entry.sharedProvider === true)
                && (!pluginIds || (entry.pluginId !== undefined && pluginIds.includes(entry.pluginId)))
            ));
            const results = await Promise.allSettled(entries.map(retireSemanticEntry));
            const failures = flattenManagedServiceCleanupFailures(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
            if (failures.length > 0) throw new AggregateError(failures, 'Failed to retire shared Provider custody');
        },
        async dispose(options?: Readonly<{ preserveProjectServices?: boolean; preserveSharedProviderServices?: boolean }>) {
            permanentRetirementStarted = true;
            if (!options?.preserveProjectServices) projectRetirementStarted = true;
            if (!options?.preserveSharedProviderServices) sharedProviderRetirementStarted = true;
            while (true) {
                // Physical service custody is the leaf authority. Retire it
                // before its explicit-start claim so two semantic entries do
                // not concurrently join and then erase the same failed
                // cleanup attempt.
                const entries = [...semanticEntries.values()].filter(entry => (
                    (!options?.preserveProjectServices || !isProjectManagedServiceSemanticEntry(entry))
                    && (!options?.preserveSharedProviderServices || !(isManagedServiceSemanticEntry(entry) ? entry.sharedConsumers !== undefined : entry.sharedProvider === true))
                ));
                if (entries.length === 0) break;
                const physical = entries.filter(
                    isManagedServiceSemanticEntry,
                );
                const retiring = physical.length > 0
                    ? physical
                    : entries;
                const results = await Promise.allSettled(
                    retiring.map(async (entry) => {
                        await retireSemanticEntry(entry);
                        removeSemanticEntry(entry);
                    }),
                );
                const failures = flattenManagedServiceCleanupFailures(
                    results.flatMap((result) => result.status === 'rejected'
                        ? [result.reason]
                        : []),
                );
                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        'Failed to permanently retire managed services',
                    );
                }
            }
        },
        bindScope,
    });
}
