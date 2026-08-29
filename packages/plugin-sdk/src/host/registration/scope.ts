import {
    COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1,
    type ComposerAttachmentRuntimeRegistrationFieldV1,
} from '@happier-dev/protocol/plugins/contributions/composer-attachments';
import type {
    ActionHandler,
    PluginClientActionHandler,
} from '../../actions/service.js';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    ComposerAttachmentRuntime,
    ComposerReferenceRuntime,
    HookHandler,
    PluginApi,
    PluginClientApi,
    PluginMcpDiscoveryHandler,
    PluginMcpServerRuntime,
    PluginNotificationSender,
    PluginRequestInterceptor,
    BackendRuntime,
    HostingProviderRuntime,
} from '../../activation.js';
import {
    PluginContributionLocalIdSchema,
    type PromptAssetTypeDescriptor,
} from '@happier-dev/protocol/plugins/manifest';
import type {
    PluginConnectedAccountDescriptorContributionV2,
} from '@happier-dev/protocol';
import type {
    VoiceProviderContribution,
} from '@happier-dev/protocol/plugins/contributions/voice';
import {
    validateAgentExternalSessionHooksContribution,
    type AgentExternalSessionHooksContribution,
} from '../../externalSessionHooks.js';
import {
    validateAgentExternalSessionTakeoverContribution,
    type AgentExternalSessionTakeoverContribution,
} from '../../sessions/externalSessionTakeover.js';
import type {
    AgentCliAuthContributionV1,
    AgentCliSessionCommandDeclarationV1,
    AgentConnectedAccountEnvironmentUseV1,
    AgentConnectedAccountFileEnvironmentUseV1,
    AgentConnectedAccountContinuityV1,
    AgentConnectedAccountLaunchContributionV1,
    AgentConnectedAccountSwitchContinuityV1,
    AgentConnectedAccountSwitchTransitionV1,
    AgentConnectedAccountStateSharingDescriptorV1,
    AgentExperimentalVendorResumeSupportContributionV1,
    AgentPreflightSessionControlsCommandV1,
    AgentPreflightSessionControlsContributionV1,
    AgentPreflightSessionControlsModelsV1,
    AgentTerminalPromptSubmitVerificationPolicyV1,
    AgentProviderBindingAdapter,
    AgentDaemonSpawnHooks,
    AgentProviderCliAttachDeclarationV1,
    AgentRuntimeFactory,
    AgentRuntimeRegistrationOptions,
    AgentSessionStartupContributionV1,
    AgentSessionRunnerFactoryLocatorV1,
} from '../../agentRuntime/index.js';
import {
    ConnectedAccountRequestAuthUsesV1Schema,
} from '@happier-dev/protocol/connect/connected-account-request-auth';
import type {
    ConnectedAccountRequestAuthUse,
} from '../../connectedAccounts.js';
import type { BackgroundServiceRunner } from '../../backgroundServices.js';
import type { JsonValue } from '../../identity.js';
import type { PromptAssetAdapter } from '../../resources.js';
import type { PluginDynamicResourceRuntime } from '../../services/resources.js';
import type { PluginConnectedAccountRuntime } from '../../services/index.js';
import type {
    ManagedProviderRuntime,
    ProviderCatalogParser,
} from '../../managed-services/contract.js';
import type { VoiceProvidersRegistrationApi } from '../../voice/projections.js';
import {
    snapshotManagedProviderRuntime,
    snapshotPromptAssetDescriptor,
    snapshotStaticRegistrationData,
    snapshotStaticRegistrationValue,
} from './staticRegistrationSnapshots.js';
import { raceWithTimeout } from '../../async.js';
import { captureStaticRegistrationMethod } from '../../registration/staticCapture.js';
import {
    type PluginAgentRuntimeRegistration,
    type PluginRegistrationFamily,
    type PluginRegistrationValueByFamily,
    type PluginRuntimeRegistration,
} from '../../registration/valueByFamily.js';

type PluginRegistrationRequiredField =
    | 'factory'
    | 'sessionRunnerFactory'
    | 'cliAuth'
    | 'externalSessions'
    | ComposerAttachmentRuntimeRegistrationFieldV1;

export type PluginRegistrationRight = Readonly<{
    family: string;
    localId: string;
    target:
        | Readonly<{ realm: 'daemon' }>
        | Readonly<{
            realm: 'client';
            artifactId: string;
            modulePath: string;
            exportName: string;
            platforms: readonly ('web' | 'ios' | 'android')[];
        }>;
    requiredFields?: readonly PluginRegistrationRequiredField[];
    promptAssetDescriptor?: PromptAssetTypeDescriptor;
    voiceProviderDeclaration?: VoiceProviderContribution;
    connectedAccountDescriptorDeclaration?: PluginConnectedAccountDescriptorContributionV2;
    /**
     * The complete arm composite the Provider contribution declares. A Provider
     * may declare a managed runtime, contributed catalog formats, or both, and
     * activation publishes only the exact declared set.
     */
    providerArms?: Readonly<{
        managedRuntime: boolean;
        catalogParserIds: readonly string[];
    }>;
}>;

export type PluginRegistrationScopeTarget =
    | Readonly<{ realm: 'daemon' }>
    | Readonly<{
        realm: 'client';
        artifactId: string;
        modulePath: string;
        exportName: string;
        platform: 'web' | 'ios' | 'android';
    }>;

export type { PluginAgentRuntimeRegistration, PluginRuntimeRegistration };

type PluginRuntimeRegistrationFor<TFamily extends PluginRegistrationFamily> = Readonly<{
    family: TFamily;
    localId: string;
    value: PluginRegistrationValueByFamily[TFamily];
}>;

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

type StagedAgentRuntimeRegistration = Readonly<{
    factory?: AgentRuntimeFactory;
    options?: AgentRuntimeRegistrationOptions;
    cliAuth?: AgentCliAuthContributionV1;
    externalSessions?: AgentExternalSessionsContribution;
    externalSessionHooks?: AgentExternalSessionHooksContribution;
    externalSessionObservation?: AgentExternalSessionObservationContribution;
    externalSessionTakeover?: AgentExternalSessionTakeoverContribution;
}>;

type StagedProviderRuntimeRegistration = Readonly<{
    managedRuntime?: ManagedProviderRuntime;
    catalogParsers?: Readonly<Record<string, ProviderCatalogParser>>;
}>;

type StagedPluginRuntimeRegistration =
    | Exclude<PluginRuntimeRegistration, Readonly<{ family: 'agents' }>>
    | Readonly<{
        family: 'agents';
        localId: string;
        value: StagedAgentRuntimeRegistration;
    }>;

type PluginRegistrationScopeParams = Readonly<{
    pluginId: string;
    target: PluginRegistrationScopeTarget;
    rights: readonly PluginRegistrationRight[];
    assertAvailable?(): void;
    onFailure?(message: string): void;
    /**
     * Host-owned bound for ONE independent registration-cleanup attempt
     * (captured MCP runtime disposal). Cleanup policy belongs to the host;
     * this value never widens or reorders the intentional reverse-order
     * dependency between captured cleanups. When omitted, a finite default
     * still guarantees every cleanup is attempted.
     */
    cleanupTimeoutMs?: number;
}>;

type PluginRegistrationScope<TApi extends PluginApi | PluginClientApi> = Readonly<{
    api: TApi;
    commit(): readonly PluginRuntimeRegistration[];
    registrations(): readonly PluginRuntimeRegistration[];
    dispose(): Promise<void>;
}>;

type PluginDaemonRegistrationScopeTarget = Extract<
    PluginRegistrationScopeTarget,
    Readonly<{ realm: 'daemon' }>
>;

type PluginClientRegistrationScopeTarget = Extract<
    PluginRegistrationScopeTarget,
    Readonly<{ realm: 'client' }>
>;

type RegistrationState = 'staging' | 'committing' | 'committed' | 'disposed' | 'failed';

const REGISTRATION_FAMILY = Object.freeze({
    actions: 'actions',
    agents: 'agents',
    hooks: 'hooks',
    events: 'events',
    notifications: 'notificationChannels',
    connectedAccounts: 'connectedAccountDescriptors',
    providers: 'providers',
    scmHostingProviders: 'scmHostingProviders',
    scmBackends: 'scmBackends',
    mcpServers: 'mcp.servers',
    mcpDiscoverySources: 'mcp.discoverySources',
    interceptors: 'requestInterceptors',
    voiceProviders: 'voiceProviders',
    backgroundServices: 'backgroundServices',
    promptAssets: 'promptAssets',
    dynamicResources: 'resources',
    composerReferences: 'composerReferences',
    composerAttachments: 'composerAttachments',
} as const);

function registrationKey(family: string, localId: string): string {
    return `${family}\u0000${localId}`;
}

const DEFAULT_REGISTRATION_CLEANUP_TIMEOUT_MS = 5_000;

function normalizeRegistrationCleanupTimeoutMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return DEFAULT_REGISTRATION_CLEANUP_TIMEOUT_MS;
    }
    return Math.trunc(value);
}

function isStructurallyEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => isStructurallyEqual(value, right[index]));
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index]
            && isStructurallyEqual(
                (left as Readonly<Record<string, unknown>>)[key],
                (right as Readonly<Record<string, unknown>>)[key],
            ));
}

/**
 * Captures the staged Provider composite. The managed runtime keeps its exact
 * static capture, and each contributed catalog format is captured as a direct
 * callable so it cannot be swapped after commit.
 */
function snapshotProviderRuntimeRegistration(
    staged: Readonly<{
        managedRuntime?: ManagedProviderRuntime;
        catalogParsers?: Readonly<Record<string, ProviderCatalogParser>>;
    }>,
): PluginRegistrationValueByFamily['providers'] {
    const catalogParsers = Object.entries(staged.catalogParsers ?? {});
    for (const [format, parse] of catalogParsers) {
        if (typeof parse !== 'function') {
            throw new TypeError(`Provider catalog format '${format}' parser must be a function`);
        }
    }
    return Object.freeze({
        ...(staged.managedRuntime === undefined
            ? {}
            : { managedRuntime: snapshotManagedProviderRuntime(staged.managedRuntime) }),
        ...(catalogParsers.length === 0
            ? {}
            : { catalogParsers: Object.freeze(Object.fromEntries(catalogParsers)) }),
    });
}

function freezeRegistration<TFamily extends PluginRegistrationFamily>(
    family: TFamily,
    localId: string,
    value: PluginRegistrationValueByFamily[TFamily],
): PluginRuntimeRegistrationFor<TFamily> {
    return Object.freeze({ family, localId, value });
}

const AGENT_EXTERNAL_SESSIONS_KEYS = Object.freeze([
    'resolveSource',
    'listCandidates',
    'resolveLinkIdentity',
    'resolveLinkedIdentity',
    'pageTranscript',
    'readAfterTranscript',
] as const);
/**
 * Declarations a contribution may omit. They are snapshotted with the same
 * static capture as the required operations when present, so an optional
 * declaration cannot be swapped after commit either.
 */
const AGENT_EXTERNAL_SESSIONS_OPTIONAL_KEYS = Object.freeze([
    'resolveManagedEndpointService',
] as const);
const AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS = Object.freeze([
    'describeResource',
    'observeResource',
    'reconcileResource',
] as const);
function readAgentRegistrationObject(
    value: unknown,
    subject: string,
): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function bindAgentRegistrationCallback<T>(
    receiver: object,
    value: unknown,
    subject: string,
): T {
    if (typeof value !== 'function') {
        throw new TypeError(`${subject} must be a function`);
    }
    return value.bind(receiver) as T;
}

/**
 * The one callable-admission rule shared by the External Sessions
 * contribution snapshots (main contribution and observation). Plugin code is
 * trusted executable code, so structural receivers stay allowed: inert state,
 * class/prototype helpers, symbols, non-enumerable members, and accessors are
 * ignored. Only an unknown OWN ENUMERABLE data-property function is a
 * misspelled or retired declared operation and is rejected through an
 * attributable diagnostic. Unknown accessors are never invoked to classify
 * them, and declared operations keep their ordinary named reads with the
 * original receiver.
 */
function rejectUnknownEnumerableCallableOperations(
    receiver: Readonly<Record<string, unknown>>,
    approvedCallbacks: ReadonlySet<string>,
    subject: string,
): void {
    for (const key of Object.getOwnPropertyNames(receiver)) {
        if (approvedCallbacks.has(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(receiver, key);
        if (!descriptor?.enumerable) continue;
        if (descriptor.get !== undefined || descriptor.set !== undefined) continue;
        if (typeof descriptor.value !== 'function') continue;
        throw new TypeError(`${subject}.${key} is not an approved callback`);
    }
}

function snapshotAgentProviderBindingAdapter(
    value: AgentProviderBindingAdapter,
): AgentProviderBindingAdapter {
    const receiver = readAgentRegistrationObject(value, 'Agent provider binding');
    const v = receiver.v;
    const adapterVersion = receiver.adapterVersion;
    if (v !== 1
        || !Number.isSafeInteger(adapterVersion)
        || (adapterVersion as number) < 1) {
        throw new TypeError('Agent provider binding has an invalid version');
    }
    return Object.freeze({
        v: 1,
        adapterVersion: adapterVersion as number,
        prepare: bindAgentRegistrationCallback<AgentProviderBindingAdapter['prepare']>(
            receiver,
            receiver.prepare,
            'Agent provider binding.prepare',
        ),
        materialize: bindAgentRegistrationCallback<AgentProviderBindingAdapter['materialize']>(
            receiver,
            receiver.materialize,
            'Agent provider binding.materialize',
        ),
    });
}

function snapshotAgentDaemonSpawnHooks(
    value: AgentDaemonSpawnHooks,
): AgentDaemonSpawnHooks {
    const receiver = readAgentRegistrationObject(value, 'Agent daemon spawn hooks');
    const resolveRuntimePrerequisites = receiver.resolveRuntimePrerequisites === undefined
        ? undefined
        : bindAgentRegistrationCallback<
        NonNullable<AgentDaemonSpawnHooks['resolveRuntimePrerequisites']>
    >(
        receiver,
        receiver.resolveRuntimePrerequisites,
        'Agent daemon spawn hooks.resolveRuntimePrerequisites',
    );
    const augmentEnv = receiver.augmentEnv === undefined
        ? undefined
        : bindAgentRegistrationCallback<
        NonNullable<AgentDaemonSpawnHooks['augmentEnv']>
    >(
        receiver,
        receiver.augmentEnv,
        'Agent daemon spawn hooks.augmentEnv',
    );
    if (!resolveRuntimePrerequisites && !augmentEnv) {
        throw new TypeError('Agent daemon spawn hooks must define at least one hook');
    }
    return Object.freeze({
        ...(resolveRuntimePrerequisites ? { resolveRuntimePrerequisites } : {}),
        ...(augmentEnv ? { augmentEnv } : {}),
    });
}

function snapshotAgentProviderCliAttachDeclaration(
    value: AgentProviderCliAttachDeclarationV1,
): AgentProviderCliAttachDeclarationV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent provider CLI attach declaration');
    return Object.freeze({
        resolveTarget: bindAgentRegistrationCallback<
            AgentProviderCliAttachDeclarationV1['resolveTarget']
        >(
            receiver,
            receiver.resolveTarget,
            'Agent provider CLI attach declaration.resolveTarget',
        ),
        createArgs: bindAgentRegistrationCallback<
            AgentProviderCliAttachDeclarationV1['createArgs']
        >(
            receiver,
            receiver.createArgs,
            'Agent provider CLI attach declaration.createArgs',
        ),
        buildHealthUrl: bindAgentRegistrationCallback<
            AgentProviderCliAttachDeclarationV1['buildHealthUrl']
        >(
            receiver,
            receiver.buildHealthUrl,
            'Agent provider CLI attach declaration.buildHealthUrl',
        ),
    });
}

function snapshotAgentCliSessionCommandString(
    value: unknown,
    subject: string,
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${subject} must be a non-empty string`);
    }
    return value;
}

function snapshotAgentCliSessionCommandStringArray(
    value: unknown,
    subject: string,
): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        throw new TypeError(`${subject} must be an array of non-empty strings`);
    }
    return Object.freeze([...value]);
}

function snapshotAgentCliSessionCommandStringArrayArray(
    value: unknown,
    subject: string,
): readonly (readonly string[])[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${subject} must be an array of argument arrays`);
    }
    return Object.freeze(value.map((entry, index) => (
        snapshotAgentCliSessionCommandStringArray(entry, `${subject}[${index}]`)
    )));
}

function snapshotAgentCliSessionCommandDeclaration(
    value: AgentCliSessionCommandDeclarationV1,
): AgentCliSessionCommandDeclarationV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent CLI session-command declaration');
    const implicitResumeDelegation = receiver.implicitResumeDelegation;
    const snapshot: {
        sessionRuntimeId?: string;
        deprecatedAliasAgentId?: string;
        accountSettingsAgentId?: string;
        implicitResumeDelegation?: Readonly<{ resumeFlags: readonly string[] }>;
        directoryFlags?: readonly string[];
        forwardModelFlag?: boolean;
        forwardResumeFlag?: boolean;
        yoloAgentArgs?: readonly string[];
        versionFlags?: readonly string[];
        infoCommandPrefixes?: readonly (readonly string[])[];
        buildSessionOptions?: AgentCliSessionCommandDeclarationV1['buildSessionOptions'];
    } = {};
    if (receiver.sessionRuntimeId !== undefined) {
        snapshot.sessionRuntimeId = snapshotAgentCliSessionCommandString(
            receiver.sessionRuntimeId,
            'Agent CLI session-command declaration.sessionRuntimeId',
        );
    }
    if (receiver.deprecatedAliasAgentId !== undefined) {
        snapshot.deprecatedAliasAgentId = snapshotAgentCliSessionCommandString(
            receiver.deprecatedAliasAgentId,
            'Agent CLI session-command declaration.deprecatedAliasAgentId',
        );
    }
    if (receiver.accountSettingsAgentId !== undefined) {
        snapshot.accountSettingsAgentId = snapshotAgentCliSessionCommandString(
            receiver.accountSettingsAgentId,
            'Agent CLI session-command declaration.accountSettingsAgentId',
        );
    }
    if (implicitResumeDelegation !== undefined) {
        const resume = readAgentRegistrationObject(
            implicitResumeDelegation,
            'Agent CLI session-command declaration.implicitResumeDelegation',
        );
        snapshot.implicitResumeDelegation = Object.freeze({
            resumeFlags: snapshotAgentCliSessionCommandStringArray(
                resume.resumeFlags,
                'Agent CLI session-command declaration.implicitResumeDelegation.resumeFlags',
            ),
        });
    }
    if (receiver.directoryFlags !== undefined) {
        snapshot.directoryFlags = snapshotAgentCliSessionCommandStringArray(
            receiver.directoryFlags,
            'Agent CLI session-command declaration.directoryFlags',
        );
    }
    if (receiver.forwardModelFlag !== undefined) {
        if (typeof receiver.forwardModelFlag !== 'boolean') {
            throw new TypeError('Agent CLI session-command declaration.forwardModelFlag must be boolean');
        }
        snapshot.forwardModelFlag = receiver.forwardModelFlag;
    }
    if (receiver.forwardResumeFlag !== undefined) {
        if (typeof receiver.forwardResumeFlag !== 'boolean') {
            throw new TypeError('Agent CLI session-command declaration.forwardResumeFlag must be boolean');
        }
        snapshot.forwardResumeFlag = receiver.forwardResumeFlag;
    }
    if (receiver.yoloAgentArgs !== undefined) {
        snapshot.yoloAgentArgs = snapshotAgentCliSessionCommandStringArray(
            receiver.yoloAgentArgs,
            'Agent CLI session-command declaration.yoloAgentArgs',
        );
    }
    if (receiver.versionFlags !== undefined) {
        snapshot.versionFlags = snapshotAgentCliSessionCommandStringArray(
            receiver.versionFlags,
            'Agent CLI session-command declaration.versionFlags',
        );
    }
    if (receiver.infoCommandPrefixes !== undefined) {
        snapshot.infoCommandPrefixes = snapshotAgentCliSessionCommandStringArrayArray(
            receiver.infoCommandPrefixes,
            'Agent CLI session-command declaration.infoCommandPrefixes',
        );
    }
    if (receiver.buildSessionOptions !== undefined) {
        snapshot.buildSessionOptions = bindAgentRegistrationCallback<
            NonNullable<AgentCliSessionCommandDeclarationV1['buildSessionOptions']>
        >(
            receiver,
            receiver.buildSessionOptions,
            'Agent CLI session-command declaration.buildSessionOptions',
        );
    }
    return Object.freeze(snapshot);
}

function snapshotAgentCliAuthContribution(
    value: AgentCliAuthContributionV1,
): AgentCliAuthContributionV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent CLI auth contribution');
    return Object.freeze({
        detectAuthStatus: bindAgentRegistrationCallback<
            AgentCliAuthContributionV1['detectAuthStatus']
        >(
            receiver,
            receiver.detectAuthStatus,
            'Agent CLI auth contribution.detectAuthStatus',
        ),
    });
}

function snapshotAgentConnectedAccountStateSharingDescriptor(
    value: AgentConnectedAccountStateSharingDescriptorV1,
): AgentConnectedAccountStateSharingDescriptorV1 {
    const snapshot = snapshotStaticRegistrationData(
        value,
        'Agent connected-account launch state-sharing descriptor',
    ) as AgentConnectedAccountStateSharingDescriptorV1;
    if (snapshot.nativeHome === undefined) return snapshot;
    const { environmentKey, defaultRelativePath } = snapshot.nativeHome;
    if (typeof environmentKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentKey)) {
        throw new TypeError('Agent connected-account launch state-sharing descriptor.nativeHome.environmentKey must be a canonical environment key');
    }
    if (
        typeof defaultRelativePath !== 'string'
        || defaultRelativePath.length === 0
        || defaultRelativePath !== defaultRelativePath.trim()
        || defaultRelativePath.includes('\\')
        || defaultRelativePath.startsWith('/')
        || /^[A-Za-z]:/u.test(defaultRelativePath)
        || defaultRelativePath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
        throw new TypeError('Agent connected-account launch state-sharing descriptor.nativeHome.defaultRelativePath must be a safe canonical relative path');
    }
    return snapshot;
}

function snapshotAgentConnectedAccountLaunchUses<T extends 'fileEnvironmentUses' | 'environmentUses'>(
    value: unknown,
    field: T,
): T extends 'fileEnvironmentUses'
    ? readonly AgentConnectedAccountFileEnvironmentUseV1[]
    : readonly AgentConnectedAccountEnvironmentUseV1[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`Agent connected-account launch ${field} must be a non-empty array`);
    }
    return Object.freeze(value.map((entry, index) => {
        const receiver = readAgentRegistrationObject(entry, `Agent connected-account launch ${field}[${index}]`);
        const purpose = receiver.purpose;
        const environmentKey = receiver.environmentKey;
        if (typeof purpose !== 'string' || purpose.length === 0) {
            throw new TypeError(`Agent connected-account launch ${field}[${index}].purpose must be a non-empty string`);
        }
        if (typeof environmentKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentKey)) {
            throw new TypeError(`Agent connected-account launch ${field}[${index}].environmentKey must be a canonical environment key`);
        }
        if (field === 'fileEnvironmentUses') {
            const fileId = receiver.fileId;
            if (typeof fileId !== 'string' || fileId.length === 0) {
                throw new TypeError(`Agent connected-account launch ${field}[${index}].fileId must be a non-empty string`);
            }
            return Object.freeze({ purpose, fileId, environmentKey });
        }
        return Object.freeze({ purpose, environmentKey });
    })) as never;
}

function snapshotAgentConnectedAccountLaunchContribution(
    value: AgentConnectedAccountLaunchContributionV1,
): AgentConnectedAccountLaunchContributionV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent connected-account launch contribution');
    const requestAuthUses = receiver.requestAuthUses === undefined
        ? undefined
        : snapshotStaticRegistrationData(
            ConnectedAccountRequestAuthUsesV1Schema.parse(receiver.requestAuthUses),
            'Agent connected-account launch request-auth uses',
        ) as readonly ConnectedAccountRequestAuthUse[];
    const fileEnvironmentUses = receiver.fileEnvironmentUses === undefined
        ? undefined
        : snapshotAgentConnectedAccountLaunchUses(receiver.fileEnvironmentUses, 'fileEnvironmentUses');
    const environmentUses = receiver.environmentUses === undefined
        ? undefined
        : snapshotAgentConnectedAccountLaunchUses(receiver.environmentUses, 'environmentUses');
    const switchContinuity = receiver.switchContinuity === undefined
        ? undefined
        : snapshotAgentConnectedAccountSwitchContinuity(receiver.switchContinuity);
    const stateSharingDescriptor = receiver.stateSharingDescriptor === undefined
        ? undefined
        : snapshotAgentConnectedAccountStateSharingDescriptor(
            receiver.stateSharingDescriptor as AgentConnectedAccountStateSharingDescriptorV1,
        );
    const continuity = receiver.continuity === undefined
        ? undefined
        : (() => {
            const source = readAgentRegistrationObject(
                receiver.continuity,
                'Agent connected-account launch continuity',
            );
            const nativeAuthCodec = source.nativeAuthCodec;
            let capturedNativeAuthCodec: AgentConnectedAccountContinuityV1['nativeAuthCodec'];
            if (nativeAuthCodec !== undefined) {
                const codec = readAgentRegistrationObject(
                    nativeAuthCodec,
                    'Agent connected-account launch continuity.nativeAuthCodec',
                );
                const materialize = codec.materialize;
                if (typeof materialize !== 'function') {
                    throw new TypeError('Agent connected-account launch continuity.nativeAuthCodec.materialize must be a function');
                }
                const inspect = codec.inspect;
                if (typeof inspect !== 'function') {
                    throw new TypeError('Agent connected-account launch continuity.nativeAuthCodec.inspect must be a function');
                }
                capturedNativeAuthCodec = Object.freeze({
                    materialize: bindAgentRegistrationCallback<NonNullable<AgentConnectedAccountContinuityV1['nativeAuthCodec']>['materialize']>(
                        codec,
                        materialize,
                        'Agent connected-account launch continuity.nativeAuthCodec.materialize',
                    ),
                    inspect: bindAgentRegistrationCallback<NonNullable<AgentConnectedAccountContinuityV1['nativeAuthCodec']>['inspect']>(
                        codec,
                        inspect,
                        'Agent connected-account launch continuity.nativeAuthCodec.inspect',
                    ),
                });
            }
            const runtimeAuthAdapter = source.runtimeAuthAdapter;
            if (runtimeAuthAdapter !== undefined) {
                const adapter = readAgentRegistrationObject(
                    runtimeAuthAdapter,
                    'Agent connected-account launch continuity.runtimeAuthAdapter',
                );
                for (const method of [
                    'classifyRuntimeAuthFailure',
                    'materializeActiveProfile',
                    'canHotApply',
                    'hotApply',
                    'probeQuota',
                    'refreshActiveProfile',
                ] as const) {
                    if (typeof adapter[method] !== 'function') {
                        throw new TypeError(`Agent connected-account launch continuity.runtimeAuthAdapter.${method} must be a function`);
                    }
                }
            }
            for (const callback of ['verifyResumeReachable'] as const) {
                if (source[callback] !== undefined && typeof source[callback] !== 'function') {
                    throw new TypeError(`Agent connected-account launch continuity.${callback} must be a function`);
                }
            }
            if (
                nativeAuthCodec === undefined
                &&
                runtimeAuthAdapter === undefined
                && source.verifyResumeReachable === undefined
            ) {
                throw new TypeError('Agent connected-account launch continuity must declare at least one callback');
            }
            return Object.freeze({
                ...(capturedNativeAuthCodec === undefined ? {} : { nativeAuthCodec: capturedNativeAuthCodec }),
                ...(runtimeAuthAdapter === undefined ? {} : { runtimeAuthAdapter }),
                ...(source.verifyResumeReachable === undefined
                    ? {}
                    : { verifyResumeReachable: source.verifyResumeReachable }),
            });
        })() as AgentConnectedAccountContinuityV1;
    if (requestAuthUses === undefined && fileEnvironmentUses === undefined && environmentUses === undefined && switchContinuity === undefined && stateSharingDescriptor === undefined && continuity === undefined) {
        throw new TypeError('Agent connected-account launch contribution must declare at least one launch fact');
    }
    return Object.freeze({
        ...(requestAuthUses === undefined ? {} : { requestAuthUses }),
        ...(fileEnvironmentUses === undefined ? {} : { fileEnvironmentUses }),
        ...(environmentUses === undefined ? {} : { environmentUses }),
        ...(switchContinuity === undefined ? {} : { switchContinuity }),
        ...(stateSharingDescriptor === undefined ? {} : { stateSharingDescriptor }),
        ...(continuity === undefined ? {} : { continuity }),
    });
}

const AGENT_CONNECTED_ACCOUNT_SWITCH_TRANSITIONS = new Set<AgentConnectedAccountSwitchTransitionV1>([
    'native_to_connected',
    'connected_to_native',
    'connected_to_connected',
    'same_connected_group',
]);

function snapshotAgentConnectedAccountSwitchContinuity(
    value: unknown,
): AgentConnectedAccountSwitchContinuityV1 {
    const receiver = readAgentRegistrationObject(
        value,
        'Agent connected-account launch switch continuity',
    );
    const snapshotStrings = (candidate: unknown, subject: string): readonly string[] => {
        if (
            !Array.isArray(candidate)
            || candidate.length === 0
            || candidate.some((entry) => typeof entry !== 'string' || entry.length === 0)
        ) {
            throw new TypeError(`${subject} must be a non-empty array of non-empty strings`);
        }
        return Object.freeze([...candidate]);
    };
    const snapshotTransitions = (
        candidate: unknown,
        subject: string,
    ): readonly AgentConnectedAccountSwitchTransitionV1[] => {
        const values = snapshotStrings(candidate, subject);
        if (values.some((entry) => !AGENT_CONNECTED_ACCOUNT_SWITCH_TRANSITIONS.has(
            entry as AgentConnectedAccountSwitchTransitionV1,
        ))) {
            throw new TypeError(`${subject} contains an unsupported transition`);
        }
        return values as readonly AgentConnectedAccountSwitchTransitionV1[];
    };
    const continuityMode = receiver.continuityMode;
    if (
        continuityMode !== 'hot_apply'
        && continuityMode !== 'restart_same_home'
        && continuityMode !== 'restart_shared_state_required'
    ) {
        throw new TypeError('Agent connected-account launch switch continuity.continuityMode is unsupported');
    }
    const supportedTransitions = receiver.supportedTransitions === undefined
        ? undefined
        : snapshotTransitions(
            receiver.supportedTransitions,
            'Agent connected-account launch switch continuity.supportedTransitions',
        );
    const providerStateSharingRequired = receiver.providerStateSharingRequired === undefined
        ? undefined
        : (() => {
            const sharing = readAgentRegistrationObject(
                receiver.providerStateSharingRequired,
                'Agent connected-account launch switch continuity.providerStateSharingRequired',
            );
            return Object.freeze({
                ...(sharing.serviceIds === undefined
                    ? {}
                    : {
                        serviceIds: snapshotStrings(
                            sharing.serviceIds,
                            'Agent connected-account launch switch continuity.providerStateSharingRequired.serviceIds',
                        ),
                    }),
                supportedTransitions: snapshotTransitions(
                    sharing.supportedTransitions,
                    'Agent connected-account launch switch continuity.providerStateSharingRequired.supportedTransitions',
                ),
            });
        })();
    return Object.freeze({
        continuityMode,
        ...(supportedTransitions === undefined ? {} : { supportedTransitions }),
        ...(providerStateSharingRequired === undefined ? {} : { providerStateSharingRequired }),
    });
}

function snapshotAgentPreflightSessionControlsString(
    value: unknown,
    subject: string,
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${subject} must be a non-empty string`);
    }
    return value;
}

function snapshotAgentPreflightSessionControlsArgs(
    value: unknown,
    subject: string,
): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        throw new TypeError(`${subject} must be an array of non-empty strings`);
    }
    return Object.freeze([...value]);
}

function snapshotAgentPreflightSessionControlsEnvironmentKeys(
    value: unknown,
    subject: string,
): readonly string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`${subject} must be a non-empty array of exact environment names`);
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry)) {
            throw new TypeError(`${subject} must contain only exact environment names`);
        }
        if (seen.has(entry)) continue;
        seen.add(entry);
        keys.push(entry);
    }
    return Object.freeze(keys);
}

function snapshotAgentPreflightSessionControlsCommand(
    value: AgentPreflightSessionControlsCommandV1,
    subject: string,
): AgentPreflightSessionControlsCommandV1 {
    const receiver = readAgentRegistrationObject(value, subject);
    if (receiver.environmentKeys !== undefined && receiver.environmentExcludeKeys !== undefined) {
        throw new TypeError(`${subject} cannot set both environmentKeys and environmentExcludeKeys`);
    }
    if (receiver.ci !== undefined && receiver.ci !== 'omit') {
        throw new TypeError(`${subject}.ci must be 'omit' when present`);
    }
    return Object.freeze({
        toolId: snapshotAgentPreflightSessionControlsString(receiver.toolId, `${subject}.toolId`),
        args: snapshotAgentPreflightSessionControlsArgs(receiver.args, `${subject}.args`),
        ...(receiver.environmentKeys === undefined
            ? {}
            : {
                environmentKeys: snapshotAgentPreflightSessionControlsEnvironmentKeys(
                    receiver.environmentKeys,
                    `${subject}.environmentKeys`,
                ),
            }),
        ...(receiver.environmentExcludeKeys === undefined
            ? {}
            : {
                environmentExcludeKeys: snapshotAgentPreflightSessionControlsEnvironmentKeys(
                    receiver.environmentExcludeKeys,
                    `${subject}.environmentExcludeKeys`,
                ),
            }),
        ...(receiver.ci === 'omit' ? { ci: 'omit' as const } : {}),
    });
}

function snapshotAgentPreflightSessionControlsModels(
    value: AgentPreflightSessionControlsModelsV1,
): AgentPreflightSessionControlsModelsV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent preflight models declaration');
    const fallback = receiver.fallback === undefined
        ? undefined
        : readAgentRegistrationObject(
            receiver.fallback,
            'Agent preflight models declaration.fallback',
        );
    return Object.freeze({
        command: snapshotAgentPreflightSessionControlsCommand(
            receiver.command as AgentPreflightSessionControlsCommandV1,
            'Agent preflight models declaration.command',
        ),
        ...(receiver.parseOutput === undefined
            ? {}
            : {
                parseOutput: bindAgentRegistrationCallback<
                    NonNullable<AgentPreflightSessionControlsModelsV1['parseOutput']>
                >(
                    receiver,
                    receiver.parseOutput,
                    'Agent preflight models declaration.parseOutput',
                ),
            }),
        ...(fallback === undefined
            ? {}
            : {
                fallback: Object.freeze({
                    command: snapshotAgentPreflightSessionControlsCommand(
                        fallback.command as AgentPreflightSessionControlsCommandV1,
                        'Agent preflight models declaration.fallback.command',
                    ),
                    ...(fallback.parseOutput === undefined
                        ? {}
                        : {
                            parseOutput: bindAgentRegistrationCallback<
                                NonNullable<NonNullable<
                                    AgentPreflightSessionControlsModelsV1['fallback']
                                >['parseOutput']>
                            >(
                                fallback,
                                fallback.parseOutput,
                                'Agent preflight models declaration.fallback.parseOutput',
                            ),
                        }),
                }),
            }),
    });
}

function snapshotAgentPreflightSessionControlsContribution(
    value: AgentPreflightSessionControlsContributionV1,
): AgentPreflightSessionControlsContributionV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent preflight Session controls contribution');
    if (receiver.models !== undefined && receiver.probeModels !== undefined) {
        throw new TypeError('Agent preflight Session controls contribution cannot declare both models and probeModels');
    }
    const snapshot: {
        resolveProbeVariant?: AgentPreflightSessionControlsContributionV1['resolveProbeVariant'];
        models?: AgentPreflightSessionControlsModelsV1;
        jsonRpcCommands?: readonly AgentPreflightSessionControlsCommandV1[];
        probeModels?: AgentPreflightSessionControlsContributionV1['probeModels'];
        probeModes?: AgentPreflightSessionControlsContributionV1['probeModes'];
        probeConfigOptions?: AgentPreflightSessionControlsContributionV1['probeConfigOptions'];
        probePassiveRealtimeSetup?: AgentPreflightSessionControlsContributionV1['probePassiveRealtimeSetup'];
    } = {};
    if (receiver.resolveProbeVariant !== undefined) {
        snapshot.resolveProbeVariant = bindAgentRegistrationCallback<
            NonNullable<AgentPreflightSessionControlsContributionV1['resolveProbeVariant']>
        >(
            receiver,
            receiver.resolveProbeVariant,
            'Agent preflight Session controls contribution.resolveProbeVariant',
        );
    }
    if (receiver.models !== undefined) {
        snapshot.models = snapshotAgentPreflightSessionControlsModels(
            receiver.models as AgentPreflightSessionControlsModelsV1,
        );
    }
    if (receiver.jsonRpcCommands !== undefined) {
        if (!Array.isArray(receiver.jsonRpcCommands) || receiver.jsonRpcCommands.length === 0) {
            throw new TypeError('Agent preflight Session controls contribution.jsonRpcCommands must be a non-empty array');
        }
        snapshot.jsonRpcCommands = Object.freeze(receiver.jsonRpcCommands.map((command, index) => (
            snapshotAgentPreflightSessionControlsCommand(
                command as AgentPreflightSessionControlsCommandV1,
                `Agent preflight Session controls contribution.jsonRpcCommands[${index}]`,
            )
        )));
    }
    for (const key of [
        'probeModels',
        'probeModes',
        'probeConfigOptions',
        'probePassiveRealtimeSetup',
    ] as const) {
        if (receiver[key] === undefined) continue;
        snapshot[key] = bindAgentRegistrationCallback(
            receiver,
            receiver[key],
            `Agent preflight Session controls contribution.${key}`,
        ) as never;
    }
    if (Object.keys(snapshot).length === 0) {
        throw new TypeError('Agent preflight Session controls contribution cannot be empty');
    }
    return Object.freeze(snapshot);
}

function snapshotAgentTerminalPromptSubmitVerificationPolicy(
    value: AgentTerminalPromptSubmitVerificationPolicyV1,
): AgentTerminalPromptSubmitVerificationPolicyV1 {
    const receiver = readAgentRegistrationObject(
        value,
        'Agent terminal prompt-submit verification policy',
    );
    return Object.freeze({
        shouldVerifyAfterSubmit: bindAgentRegistrationCallback<
            AgentTerminalPromptSubmitVerificationPolicyV1['shouldVerifyAfterSubmit']
        >(
            receiver,
            receiver.shouldVerifyAfterSubmit,
            'Agent terminal prompt-submit verification policy.shouldVerifyAfterSubmit',
        ),
        ...(receiver.verifyBeforeSubmitStaging === undefined
            ? {}
            : {
                verifyBeforeSubmitStaging: bindAgentRegistrationCallback<
                    NonNullable<AgentTerminalPromptSubmitVerificationPolicyV1['verifyBeforeSubmitStaging']>
                >(
                    receiver,
                    receiver.verifyBeforeSubmitStaging,
                    'Agent terminal prompt-submit verification policy.verifyBeforeSubmitStaging',
                ),
            }),
        verifyAfterSubmit: bindAgentRegistrationCallback<
            AgentTerminalPromptSubmitVerificationPolicyV1['verifyAfterSubmit']
        >(
            receiver,
            receiver.verifyAfterSubmit,
            'Agent terminal prompt-submit verification policy.verifyAfterSubmit',
        ),
    });
}

function snapshotAgentSessionStartupContribution(
    value: AgentSessionStartupContributionV1,
): AgentSessionStartupContributionV1 {
    const receiver = readAgentRegistrationObject(value, 'Agent Session startup contribution');
    return Object.freeze({
        shouldUseDeferredBootstrap: bindAgentRegistrationCallback<
            AgentSessionStartupContributionV1['shouldUseDeferredBootstrap']
        >(
            receiver,
            receiver.shouldUseDeferredBootstrap,
            'Agent Session startup contribution.shouldUseDeferredBootstrap',
        ),
    });
}

function snapshotAgentExperimentalVendorResumeSupportContribution(
    value: AgentExperimentalVendorResumeSupportContributionV1,
): AgentExperimentalVendorResumeSupportContributionV1 {
    const receiver = readAgentRegistrationObject(
        value,
        'Agent experimental vendor-resume support contribution',
    );
    return Object.freeze({
        supportsVendorResume: bindAgentRegistrationCallback<
            AgentExperimentalVendorResumeSupportContributionV1['supportsVendorResume']
        >(
            receiver,
            receiver.supportsVendorResume,
            'Agent experimental vendor-resume support contribution.supportsVendorResume',
        ),
    });
}

function snapshotAgentRuntimeRegistrationOptions(
    options: AgentRuntimeRegistrationOptions | undefined,
): AgentRuntimeRegistrationOptions {
    if (options === undefined) return Object.freeze({});
    const source = readAgentRegistrationObject(options, 'Agent runtime registration options');
    const providerBinding = source.providerBinding;
    const sessionRunnerFactory = source.sessionRunnerFactory;
    const daemonSpawnHooks = source.daemonSpawnHooks;
    const providerCliAttach = source.providerCliAttach;
    const cliSessionCommand = source.cliSessionCommand;
    const cliAuth = source.cliAuth;
    const connectedAccountLaunch = source.connectedAccountLaunch;
    const preflightSessionControls = source.preflightSessionControls;
    const terminalPromptSubmitVerification = source.terminalPromptSubmitVerification;
    const sessionStartup = source.sessionStartup;
    const vendorResumeSupport = source.vendorResumeSupport;
    const snapshot: {
        providerBinding?: AgentProviderBindingAdapter;
        sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1;
        daemonSpawnHooks?: AgentDaemonSpawnHooks;
        providerCliAttach?: AgentProviderCliAttachDeclarationV1;
        cliSessionCommand?: AgentCliSessionCommandDeclarationV1;
        cliAuth?: AgentCliAuthContributionV1;
        connectedAccountLaunch?: AgentConnectedAccountLaunchContributionV1;
        preflightSessionControls?: AgentPreflightSessionControlsContributionV1;
        terminalPromptSubmitVerification?: AgentTerminalPromptSubmitVerificationPolicyV1;
        sessionStartup?: AgentSessionStartupContributionV1;
        vendorResumeSupport?: AgentExperimentalVendorResumeSupportContributionV1;
    } = {};
    if (providerBinding !== undefined) {
        snapshot.providerBinding = snapshotAgentProviderBindingAdapter(
            providerBinding as AgentProviderBindingAdapter,
        );
    }
    if (sessionRunnerFactory !== undefined) {
        const locator = readAgentRegistrationObject(
            sessionRunnerFactory,
            'Agent session runner factory locator',
        );
        const module = locator.module;
        const exportName = locator.export;
        const runtimeApiVersion = locator.runtimeApiVersion;
        const externalSessionsExport = locator.externalSessionsExport;
        if (
            typeof module !== 'string'
            || !/^\.[/][A-Za-z0-9._/-]+$/u.test(module)
            || module.includes('\\')
            || module.slice(2).split('/').some((segment) => (
                segment === '..' || segment === '.' || segment === ''
            ))
            || typeof exportName !== 'string'
            || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exportName)
            || runtimeApiVersion !== 1
            || (externalSessionsExport !== undefined && (
                typeof externalSessionsExport !== 'string'
                || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(externalSessionsExport)
            ))
        ) {
            throw new TypeError('Agent session runner factory locator is invalid');
        }
        snapshot.sessionRunnerFactory = Object.freeze({
            module,
            export: exportName,
            runtimeApiVersion: 1,
            ...(externalSessionsExport !== undefined
                ? { externalSessionsExport: externalSessionsExport as string }
                : {}),
        });
    }
    if (daemonSpawnHooks !== undefined) {
        snapshot.daemonSpawnHooks = snapshotAgentDaemonSpawnHooks(
            daemonSpawnHooks as AgentDaemonSpawnHooks,
        );
    }
    if (providerCliAttach !== undefined) {
        snapshot.providerCliAttach = snapshotAgentProviderCliAttachDeclaration(
            providerCliAttach as AgentProviderCliAttachDeclarationV1,
        );
    }
    if (cliSessionCommand !== undefined) {
        snapshot.cliSessionCommand = snapshotAgentCliSessionCommandDeclaration(
            cliSessionCommand as AgentCliSessionCommandDeclarationV1,
        );
    }
    if (cliAuth !== undefined) {
        snapshot.cliAuth = snapshotAgentCliAuthContribution(
            cliAuth as AgentCliAuthContributionV1,
        );
    }
    if (connectedAccountLaunch !== undefined) {
        snapshot.connectedAccountLaunch = snapshotAgentConnectedAccountLaunchContribution(
            connectedAccountLaunch as AgentConnectedAccountLaunchContributionV1,
        );
    }
    if (preflightSessionControls !== undefined) {
        snapshot.preflightSessionControls = snapshotAgentPreflightSessionControlsContribution(
            preflightSessionControls as AgentPreflightSessionControlsContributionV1,
        );
    }
    if (terminalPromptSubmitVerification !== undefined) {
        snapshot.terminalPromptSubmitVerification = snapshotAgentTerminalPromptSubmitVerificationPolicy(
            terminalPromptSubmitVerification as AgentTerminalPromptSubmitVerificationPolicyV1,
        );
    }
    if (sessionStartup !== undefined) {
        snapshot.sessionStartup = snapshotAgentSessionStartupContribution(
            sessionStartup as AgentSessionStartupContributionV1,
        );
    }
    if (vendorResumeSupport !== undefined) {
        snapshot.vendorResumeSupport = snapshotAgentExperimentalVendorResumeSupportContribution(
            vendorResumeSupport as AgentExperimentalVendorResumeSupportContributionV1,
        );
    }
    return Object.freeze(snapshot);
}

function snapshotAgentExternalSessionsContribution(
    contribution: AgentExternalSessionsContribution,
): AgentExternalSessionsContribution {
    const receiver = readAgentRegistrationObject(
        contribution,
        'Agent External Sessions contribution',
    );
    // Unknown enumerable callbacks are rejected through an attributable
    // diagnostic; unrelated non-function extension data is ignored, never
    // invoked, and never snapshotted: the snapshot below copies only the
    // declared operations.
    rejectUnknownEnumerableCallableOperations(
        receiver,
        new Set<string>([
            ...AGENT_EXTERNAL_SESSIONS_KEYS,
            ...AGENT_EXTERNAL_SESSIONS_OPTIONAL_KEYS,
        ]),
        'Agent External Sessions contribution',
    );
    const snapshot: Record<string, unknown> = {};
    for (const key of AGENT_EXTERNAL_SESSIONS_KEYS) {
        snapshot[key] = bindAgentRegistrationCallback(
            receiver,
            receiver[key],
            `Agent External Sessions contribution.${key}`,
        );
    }
    for (const key of AGENT_EXTERNAL_SESSIONS_OPTIONAL_KEYS) {
        const operation = receiver[key] === undefined
            ? undefined
            : bindAgentRegistrationCallback(
            receiver,
            receiver[key],
            `Agent External Sessions contribution.${key}`,
        );
        if (operation !== undefined) snapshot[key] = operation;
    }
    return Object.freeze(snapshot) as AgentExternalSessionsContribution;
}

function snapshotAgentExternalSessionObservationContribution(
    contribution: AgentExternalSessionObservationContribution,
): AgentExternalSessionObservationContribution {
    const receiver = readAgentRegistrationObject(
        contribution,
        'Agent External Session observation',
    );
    rejectUnknownEnumerableCallableOperations(
        receiver,
        new Set<string>(AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS),
        'Agent External Session observation',
    );
    const snapshot: Record<string, unknown> = {};
    for (const key of AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS) {
        snapshot[key] = bindAgentRegistrationCallback(
            receiver,
            receiver[key],
            `Agent External Session observation.${key}`,
        );
    }
    return Object.freeze(snapshot) as AgentExternalSessionObservationContribution;
}

function snapshotAgentExternalSessionHooksContribution(
    contribution: AgentExternalSessionHooksContribution,
): AgentExternalSessionHooksContribution {
    return validateAgentExternalSessionHooksContribution(contribution);
}

function snapshotAgentExternalSessionTakeoverContribution(
    contribution: AgentExternalSessionTakeoverContribution,
): AgentExternalSessionTakeoverContribution {
    return validateAgentExternalSessionTakeoverContribution(contribution);
}

function snapshotAgentRuntimeRegistration(
    staged: StagedAgentRuntimeRegistration,
): PluginAgentRuntimeRegistration {
    const options = snapshotAgentRuntimeRegistrationOptions(staged.options);
    const cliAuth = staged.cliAuth === undefined
        ? options.cliAuth
        : snapshotAgentCliAuthContribution(staged.cliAuth);
    if (staged.factory !== undefined && typeof staged.factory !== 'function') {
        throw new TypeError('Agent runtime factory must be a function');
    }
    return Object.freeze({
        ...(staged.factory !== undefined ? { factory: staged.factory } : {}),
        ...(options.providerBinding !== undefined ? { providerBinding: options.providerBinding } : {}),
        ...(options.sessionRunnerFactory !== undefined
            ? { sessionRunnerFactory: options.sessionRunnerFactory }
            : {}),
        ...(options.daemonSpawnHooks !== undefined
            ? { daemonSpawnHooks: options.daemonSpawnHooks }
            : {}),
        ...(options.providerCliAttach !== undefined
            ? { providerCliAttach: options.providerCliAttach }
            : {}),
        ...(options.cliSessionCommand !== undefined
            ? { cliSessionCommand: options.cliSessionCommand }
            : {}),
        ...(cliAuth !== undefined ? { cliAuth } : {}),
        ...(options.connectedAccountLaunch !== undefined
            ? { connectedAccountLaunch: options.connectedAccountLaunch }
            : {}),
        ...(options.preflightSessionControls !== undefined
            ? { preflightSessionControls: options.preflightSessionControls }
            : {}),
        ...(options.terminalPromptSubmitVerification !== undefined
            ? { terminalPromptSubmitVerification: options.terminalPromptSubmitVerification }
            : {}),
        ...(options.sessionStartup !== undefined
            ? { sessionStartup: options.sessionStartup }
            : {}),
        ...(options.vendorResumeSupport !== undefined
            ? { vendorResumeSupport: options.vendorResumeSupport }
            : {}),
        ...(staged.externalSessions !== undefined
            ? { externalSessions: snapshotAgentExternalSessionsContribution(staged.externalSessions) }
            : {}),
        ...(staged.externalSessionHooks !== undefined
            ? { externalSessionHooks: snapshotAgentExternalSessionHooksContribution(staged.externalSessionHooks) }
            : {}),
        ...(staged.externalSessionObservation !== undefined
            ? {
                externalSessionObservation: snapshotAgentExternalSessionObservationContribution(
                    staged.externalSessionObservation,
                ),
            }
            : {}),
        ...(staged.externalSessionTakeover !== undefined
            ? {
                externalSessionTakeover: snapshotAgentExternalSessionTakeoverContribution(
                    staged.externalSessionTakeover,
                ),
            }
            : {}),
    });
}

function voiceRegistrationCorrespondenceError(
    right: PluginRegistrationRight,
    runtime: RegisteredVoiceProviderRuntime,
): string | null {
    const declaration = right.voiceProviderDeclaration;
    if (declaration === undefined) {
        return `Voice contribution '${right.localId}' is missing its normalized declaration`;
    }
    if (declaration.id !== right.localId) {
        return `Voice contribution '${right.localId}' does not match declaration '${declaration.id}'`;
    }
    if (declaration.kind === 'speech') {
        if (runtime.kind !== 'speech') {
            return `Voice contribution '${right.localId}' declares kind 'speech' but registered kind '${runtime.kind}'`;
        }
        if (right.target.realm !== 'daemon') {
            return `Voice speech contribution '${right.localId}' is assigned to the wrong realm`;
        }
        const transcribe = runtime.transcribe;
        if (transcribe !== undefined && typeof transcribe !== 'function') {
            return `Voice speech contribution '${right.localId}' registered an invalid transcribe operation`;
        }
        const synthesize = runtime.synthesize;
        if (synthesize !== undefined && typeof synthesize !== 'function') {
            return `Voice speech contribution '${right.localId}' registered an invalid synthesize operation`;
        }
        const declaresTranscribe = declaration.roles.some((role) => (
            role === 'dictation_stt' || role === 'conversation_stt'
        ));
        if (declaresTranscribe !== (typeof transcribe === 'function')) {
            return `Voice speech contribution '${right.localId}' has mismatched STT role and transcribe operation`;
        }
        const declaresSynthesize = declaration.roles.includes('conversation_tts');
        if (declaresSynthesize !== (typeof synthesize === 'function')) {
            return `Voice speech contribution '${right.localId}' has mismatched TTS role and synthesize operation`;
        }
        const catalog = runtime.catalog;
        if (catalog !== undefined
            && (typeof catalog !== 'object'
                || catalog === null
                || typeof catalog.list !== 'function')) {
            return `Voice speech contribution '${right.localId}' registered an invalid catalog operation`;
        }
        const declaresCatalog = (declaration.catalogs?.length ?? 0) > 0;
        if (declaresCatalog !== (catalog !== undefined)) {
            return `Voice speech contribution '${right.localId}' has mismatched catalog declaration and list operation`;
        }
    } else {
        if (runtime.kind !== 'conversation') {
            return `Voice contribution '${right.localId}' declares kind 'conversation' but registered kind '${runtime.kind}'`;
        }
        if (right.target.realm !== 'client'
            || right.target.artifactId !== declaration.client.artifactId
            || right.target.modulePath !== declaration.client.modulePath
            || right.target.exportName !== declaration.client.exportName
            || right.target.platforms.length !== declaration.platforms.length
            || right.target.platforms.some((platform, index) => (
                platform !== declaration.platforms[index]
            ))) {
            return `Voice conversation contribution '${right.localId}' is assigned to the wrong client realm`;
        }
        if ('transcribe' in runtime || 'synthesize' in runtime || 'catalog' in runtime) {
            return `Voice conversation contribution '${right.localId}' registered an undeclared speech operation`;
        }
    }
    const settingsActions = runtime.settingsActions;
    if (settingsActions !== undefined
        && (typeof settingsActions !== 'object'
            || settingsActions === null
            || typeof settingsActions.execute !== 'function')) {
        return `Voice contribution '${right.localId}' registered an invalid settings-action operation`;
    }
    const declaresSettingsActions = (declaration.settings?.actions?.length ?? 0) > 0;
    if (declaresSettingsActions !== (settingsActions !== undefined)) {
        return `Voice contribution '${right.localId}' has mismatched settings-action declaration and execute operation`;
    }
    return null;
}

function connectedAccountRegistrationCorrespondenceError(
    right: PluginRegistrationRight,
    runtime: PluginConnectedAccountRuntime,
): string | null {
    const declaration = right.connectedAccountDescriptorDeclaration;
    if (declaration === undefined) {
        return `Connected Account contribution '${right.localId}' is missing its normalized declaration`;
    }
    if (declaration.id !== right.localId) {
        return `Connected Account contribution '${right.localId}' does not match declaration '${declaration.id}'`;
    }
    const declaredModesById = new Map(
        declaration.authentication.modes.map((mode) => [mode.id, mode] as const),
    );
    const registeredModes = Object.entries(runtime.authentication.modes);
    if (
        registeredModes.length !== declaredModesById.size
        || registeredModes.some(([modeId, registeredMode]) => (
            declaredModesById.get(modeId)?.kind !== registeredMode.kind
        ))
    ) {
        return `Connected Account contribution '${right.localId}' authentication modes do not match its declaration`;
    }
    if (registeredModes.some(([modeId, registeredMode]) => {
        const declaredMode = declaredModesById.get(modeId);
        const requiresProviderReconciliation =
            declaredMode?.outcomeReconciliation === 'providerCheck';
        return requiresProviderReconciliation !== (typeof registeredMode.reconcile === 'function');
    })) {
        return `Connected Account contribution '${right.localId}' reconciliation reachability does not match its declaration`;
    }
    return null;
}

/**
 * Daemon-independent registration contract shared by the production host and
 * the SDK testkit. It validates and snapshots author registrations, but cannot
 * install a plugin or publish daemon currentness.
 */
export function createPluginRegistrationScope(
    params: PluginRegistrationScopeParams & Readonly<{ target: PluginClientRegistrationScopeTarget }>,
): PluginRegistrationScope<PluginClientApi>;
export function createPluginRegistrationScope(
    params: PluginRegistrationScopeParams & Readonly<{ target: PluginDaemonRegistrationScopeTarget }>,
): PluginRegistrationScope<PluginApi>;
export function createPluginRegistrationScope(
    params: PluginRegistrationScopeParams,
): PluginRegistrationScope<PluginApi | PluginClientApi> {
    const rightsByKey = new Map<string, PluginRegistrationRight>();
    for (const right of params.rights) {
        if (!Object.values(REGISTRATION_FAMILY).includes(right.family as never)) {
            throw new Error(`Unknown contribution registration family '${right.family}'`);
        }
        if (!PluginContributionLocalIdSchema.safeParse(right.localId).success) {
            throw new Error(`Invalid contribution registration local id '${right.localId}'`);
        }
        const targetMatches = params.target.realm === 'daemon'
            ? right.target.realm === 'daemon'
            : right.target.realm === 'client'
                && right.target.artifactId === params.target.artifactId
                && right.target.modulePath === params.target.modulePath
                && right.target.exportName === params.target.exportName
                && right.target.platforms.includes(params.target.platform);
        if (!targetMatches) {
            throw new Error(
                `Contribution registration right '${right.family}/${right.localId}' does not belong to the ${params.target.realm} registration realm`,
            );
        }
        const key = registrationKey(right.family, right.localId);
        if (rightsByKey.has(key)) {
            throw new Error(`Duplicate contribution registration right '${right.family}/${right.localId}'`);
        }
        rightsByKey.set(key, Object.freeze({
            ...right,
            target: right.target.realm === 'daemon'
                ? Object.freeze({ realm: 'daemon' as const })
                : Object.freeze({
                    ...right.target,
                    platforms: Object.freeze([...right.target.platforms]),
                }),
            ...(right.requiredFields
                ? { requiredFields: Object.freeze([...right.requiredFields]) }
                : {}),
            ...(right.promptAssetDescriptor
                ? { promptAssetDescriptor: snapshotPromptAssetDescriptor(right.promptAssetDescriptor) }
                : {}),
            ...(right.providerArms
                ? {
                    providerArms: Object.freeze({
                        managedRuntime: right.providerArms.managedRuntime === true,
                        catalogParserIds: Object.freeze([...right.providerArms.catalogParserIds].sort()),
                    }),
                }
                : {}),
        }));
    }

    const stagedByKey = new Map<string, StagedPluginRuntimeRegistration>();
    const ownedMcpServerCleanups: Array<Readonly<{
        localId: string;
        dispose: PluginMcpServerRuntime['dispose'] | null;
    }>> = [];
    let published: readonly PluginRuntimeRegistration[] = Object.freeze([]);
    let state: RegistrationState = 'staging';
    let disposalPromise: Promise<void> | null = null;

    function fail(message: string): never {
        state = 'failed';
        stagedByKey.clear();
        params.onFailure?.(message);
        throw new Error(message);
    }

    function assertRegistrationOpen(): void {
        try {
            params.assertAvailable?.();
        } catch (error) {
            fail(error instanceof Error ? error.message : `Plugin '${params.pluginId}' registration is unavailable`);
        }
        if (state !== 'staging') {
            fail(`Plugin '${params.pluginId}' activation registration is ${state}`);
        }
    }

    function assertCommitActive(): void {
        if (state !== 'committing') {
            fail(`Plugin '${params.pluginId}' activation registration became ${state} during commit`);
        }
    }

    function assertRegistrationLocalId(localId: unknown): asserts localId is string {
        if (!PluginContributionLocalIdSchema.safeParse(localId).success) {
            fail(`Plugin '${params.pluginId}' registered an invalid contribution local id`);
        }
    }

    function assertVoiceRegistrationCorrespondence(
        right: PluginRegistrationRight,
        runtime: RegisteredVoiceProviderRuntime,
    ): void {
        let mismatch: string | null;
        try {
            mismatch = voiceRegistrationCorrespondenceError(right, runtime);
        } catch {
            mismatch = `Voice contribution '${right.localId}' registration correspondence is invalid`;
        }
        if (mismatch !== null) {
            fail(`Plugin '${params.pluginId}' ${mismatch}`);
        }
    }

    function assertComposerAttachmentRegistrationCorrespondence(
        right: PluginRegistrationRight,
        runtime: ComposerAttachmentRuntime,
    ): void {
        const requiredFields = right.requiredFields;
        if (requiredFields === undefined || requiredFields.length === 0) {
            fail(`Plugin '${params.pluginId}' Composer attachment '${right.localId}' has no declared runtime callbacks`);
        }
        if (new Set(requiredFields).size !== requiredFields.length
            || requiredFields.some((field) => !COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1.includes(
                field as ComposerAttachmentRuntimeRegistrationFieldV1,
            ))) {
            fail(`Plugin '${params.pluginId}' Composer attachment '${right.localId}' has invalid declared runtime callbacks`);
        }
        const declaredFields = requiredFields as readonly ComposerAttachmentRuntimeRegistrationFieldV1[];
        const registeredFields = COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1.filter(
            (field) => runtime[field] !== undefined,
        );
        if (registeredFields.length !== declaredFields.length
            || registeredFields.some((field) => !declaredFields.includes(field))) {
            fail(`Plugin '${params.pluginId}' Composer attachment '${right.localId}' runtime callbacks do not match its declaration`);
        }
    }

    function assertConnectedAccountRegistrationCorrespondence(
        right: PluginRegistrationRight,
        runtime: PluginConnectedAccountRuntime,
    ): void {
        let mismatch: string | null;
        try {
            mismatch = connectedAccountRegistrationCorrespondenceError(right, runtime);
        } catch {
            mismatch = `Connected Account contribution '${right.localId}' registration correspondence is invalid`;
        }
        if (mismatch !== null) {
            fail(`Plugin '${params.pluginId}' ${mismatch}`);
        }
    }

    function register<TFamily extends PluginRegistrationFamily>(
        family: TFamily,
        localId: string,
        value: PluginRegistrationValueByFamily[TFamily],
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(family, localId);
        const right = rightsByKey.get(key);
        if (!right) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution '${family}/${localId}'`);
        }
        if (stagedByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' registered duplicate contribution '${family}/${localId}'`);
        }
        const registration = freezeRegistration(family, localId, value);
        stagedByKey.set(key, registration as PluginRuntimeRegistration);
        if (family === REGISTRATION_FAMILY.mcpServers) {
            // A staged MCP runtime may already own resources even if activation
            // aborts before commit. This rollback-only fact is never published;
            // commit replaces it with the exact captured façade it publishes.
            let rollbackCleanup: PluginMcpServerRuntime['dispose'] | null = null;
            try {
                rollbackCleanup = captureStaticRegistrationMethod<PluginMcpServerRuntime['dispose']>(
                    value as PluginMcpServerRuntime,
                    'dispose',
                    'MCP server runtime.dispose rollback cleanup',
                    false,
                ) ?? null;
            } catch {
                // The exhaustive commit capture reports the malformed runtime.
            }
            ownedMcpServerCleanups.push({ localId, dispose: rollbackCleanup });
        }
    }

    function registerVoiceProvider(localId: string, runtime: RegisteredVoiceProviderRuntime): void {
        register(REGISTRATION_FAMILY.voiceProviders, localId, runtime);
    }

    function registerProviderFields(
        localId: string,
        fields: StagedProviderRuntimeRegistration,
        duplicateLabel: string,
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(REGISTRATION_FAMILY.providers, localId);
        if (!rightsByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution 'providers/${localId}'`);
        }
        const existing = stagedByKey.get(key);
        if (existing && existing.family !== REGISTRATION_FAMILY.providers) {
            fail(`Plugin '${params.pluginId}' registered conflicting contribution 'providers/${localId}'`);
        }
        const current = existing?.value as StagedProviderRuntimeRegistration | undefined;
        if (fields.managedRuntime !== undefined && current?.managedRuntime !== undefined) {
            fail(`Plugin '${params.pluginId}' registered duplicate ${duplicateLabel} for Provider '${localId}'`);
        }
        const catalogParsers = {
            ...(current?.catalogParsers ?? {}),
        };
        for (const [format, parse] of Object.entries(fields.catalogParsers ?? {})) {
            if (Object.hasOwn(catalogParsers, format)) {
                fail(`Plugin '${params.pluginId}' registered duplicate catalog format '${format}' for Provider '${localId}'`);
            }
            catalogParsers[format] = parse;
        }
        stagedByKey.set(key, Object.freeze({
            family: REGISTRATION_FAMILY.providers,
            localId,
            value: Object.freeze({
                ...(fields.managedRuntime !== undefined
                    ? { managedRuntime: fields.managedRuntime }
                    : current?.managedRuntime !== undefined
                        ? { managedRuntime: current.managedRuntime }
                        : {}),
                ...(Object.keys(catalogParsers).length > 0
                    ? { catalogParsers: Object.freeze(catalogParsers) }
                    : {}),
            }),
        }));
    }

    function registerAgentFields(
        localId: string,
        fields: StagedAgentRuntimeRegistration,
        duplicateLabel: string,
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(REGISTRATION_FAMILY.agents, localId);
        if (!rightsByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution 'agents/${localId}'`);
        }
        const existing = stagedByKey.get(key);
        if (existing && existing.family !== REGISTRATION_FAMILY.agents) {
            fail(`Plugin '${params.pluginId}' registered conflicting contribution 'agents/${localId}'`);
        }
        const current = existing?.value as StagedAgentRuntimeRegistration | undefined;
        const fieldsDeclareCliAuth = fields.cliAuth !== undefined || fields.options?.cliAuth !== undefined;
        const currentDeclaresCliAuth = current?.cliAuth !== undefined || current?.options?.cliAuth !== undefined;
        if ((fields.factory !== undefined && current?.factory !== undefined)
            || (fields.options !== undefined && current?.options !== undefined)
            || (fieldsDeclareCliAuth && currentDeclaresCliAuth)
            || (fields.externalSessions !== undefined && current?.externalSessions !== undefined)
            || (fields.externalSessionHooks !== undefined
                && current?.externalSessionHooks !== undefined)
            || (fields.externalSessionObservation !== undefined
                && current?.externalSessionObservation !== undefined)
            || (fields.externalSessionTakeover !== undefined
                && current?.externalSessionTakeover !== undefined)) {
            fail(`Plugin '${params.pluginId}' registered duplicate ${duplicateLabel} for Agent '${localId}'`);
        }
        const value = Object.freeze({
            ...(current?.factory !== undefined ? { factory: current.factory } : {}),
            ...(current?.options !== undefined ? { options: current.options } : {}),
            ...(current?.cliAuth !== undefined ? { cliAuth: current.cliAuth } : {}),
            ...(current?.externalSessions !== undefined
                ? { externalSessions: current.externalSessions }
                : {}),
            ...(current?.externalSessionHooks !== undefined
                ? { externalSessionHooks: current.externalSessionHooks }
                : {}),
            ...(current?.externalSessionObservation !== undefined
                ? { externalSessionObservation: current.externalSessionObservation }
                : {}),
            ...(current?.externalSessionTakeover !== undefined
                ? { externalSessionTakeover: current.externalSessionTakeover }
                : {}),
            ...fields,
        });
        stagedByKey.set(key, Object.freeze({
            family: REGISTRATION_FAMILY.agents,
            localId,
            value,
        }));
    }

    const daemonActions: PluginApi['actions'] = Object.freeze({
        register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(
            id: string,
            handler: ActionHandler<I, O>,
        ) {
            return register(REGISTRATION_FAMILY.actions, id, handler);
        },
    });
    const clientActions: PluginClientApi['actions'] = Object.freeze({
        register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(
            id: string,
            handler: PluginClientActionHandler<I, O>,
        ) {
            return register(REGISTRATION_FAMILY.actions, id, handler);
        },
    });
    const hooks: PluginApi['hooks'] = Object.freeze({
        register(id, handler) { return register(REGISTRATION_FAMILY.hooks, id, handler); },
    });
    const events: PluginApi['events'] = Object.freeze({
        register(id, handler) {
            return register(
                REGISTRATION_FAMILY.events,
                id,
                handler as PluginRegistrationValueByFamily['events'],
            );
        },
    });
    const voiceProviders: PluginClientApi['voiceProviders'] = Object.freeze({
        register: (id: string, runtime: RegisteredVoiceProviderRuntime) =>
            registerVoiceProvider(id, runtime),
    });
    const daemonApi: PluginApi = Object.freeze({
        actions: daemonActions,
        hooks,
        events,
        agents: Object.freeze({
            register: (id: string, factory: AgentRuntimeFactory, options?: AgentRuntimeRegistrationOptions) => {
                return registerAgentFields(id, Object.freeze({
                    factory,
                    ...(options !== undefined ? { options } : {}),
                }), 'Agent runtime');
            },
            registerCliAuth: (id: string, contribution: AgentCliAuthContributionV1) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ cliAuth: contribution }),
                    'Agent CLI auth contribution',
                );
            },
            registerExternalSessions: (id: string, contribution: AgentExternalSessionsContribution) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessions: contribution }),
                    'Agent External Sessions contribution',
                );
            },
            registerExternalSessionHooks: (
                id: string,
                contribution: AgentExternalSessionHooksContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(registrationKey(REGISTRATION_FAMILY.agents, id));
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session hooks without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionHooks: contribution }),
                    'Agent External Session hooks',
                );
            },
            registerExternalSessionObservation: (
                id: string,
                contribution: AgentExternalSessionObservationContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(registrationKey(REGISTRATION_FAMILY.agents, id));
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session observation without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionObservation: contribution }),
                    'Agent External Session observation',
                );
            },
            registerExternalSessionTakeover: (
                id: string,
                contribution: AgentExternalSessionTakeoverContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(
                    registrationKey(REGISTRATION_FAMILY.agents, id),
                );
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session takeover without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionTakeover: contribution }),
                    'Agent External Session takeover',
                );
            },
        }),
        notifications: Object.freeze({
            registerChannel: (id: string, sender: PluginNotificationSender) =>
                register(REGISTRATION_FAMILY.notifications, id, sender),
        }),
        connectedAccounts: Object.freeze({
            register: (id: string, runtime: PluginConnectedAccountRuntime) =>
                register(REGISTRATION_FAMILY.connectedAccounts, id, runtime),
        }),
        providers: Object.freeze({
            register: (id: string, runtime: ManagedProviderRuntime) =>
                registerProviderFields(
                    id,
                    Object.freeze({ managedRuntime: runtime }),
                    'managed Provider runtime',
                ),
            registerCatalogParser: (
                id: string,
                format: string,
                parse: ProviderCatalogParser,
            ) => {
                assertRegistrationLocalId(format);
                return registerProviderFields(
                    id,
                    Object.freeze({ catalogParsers: Object.freeze({ [format]: parse }) }),
                    'Provider catalog format',
                );
            },
        }),
        scm: Object.freeze({
            registerHostingProvider: (id: string, runtime: HostingProviderRuntime) =>
                register(REGISTRATION_FAMILY.scmHostingProviders, id, runtime),
            registerBackend: (id: string, runtime: BackendRuntime) =>
                register(REGISTRATION_FAMILY.scmBackends, id, runtime),
        }),
        mcp: Object.freeze({
            registerServer: (id: string, runtime: PluginMcpServerRuntime) =>
                register(REGISTRATION_FAMILY.mcpServers, id, runtime),
            registerDiscoverySource: (
                id: string,
                discover: PluginMcpDiscoveryHandler,
            ) => register(REGISTRATION_FAMILY.mcpDiscoverySources, id, discover),
        }),
        interceptors: Object.freeze({
            register: (id: string, interceptor: PluginRequestInterceptor) =>
                register(REGISTRATION_FAMILY.interceptors, id, interceptor),
        }),
        voiceProviders,
        composerReferences: Object.freeze({
            register: (id: string, runtime: ComposerReferenceRuntime) =>
                register(REGISTRATION_FAMILY.composerReferences, id, runtime),
        }),
        composerAttachments: Object.freeze({
            register: (id: string, runtime: ComposerAttachmentRuntime) =>
                register(REGISTRATION_FAMILY.composerAttachments, id, runtime),
        }),
        resources: Object.freeze({
            registerPromptAssetAdapter: (id: string, adapter: PromptAssetAdapter) =>
                register(REGISTRATION_FAMILY.promptAssets, id, adapter),
            registerDynamicResource: (id: string, runtime: PluginDynamicResourceRuntime) =>
                register(REGISTRATION_FAMILY.dynamicResources, id, runtime),
        }),
        backgroundServices: Object.freeze({
            register: (id: string, runner: BackgroundServiceRunner) =>
                register(REGISTRATION_FAMILY.backgroundServices, id, runner),
        }),
    });
    const clientApi: PluginClientApi = Object.freeze({
        actions: clientActions,
        voiceProviders,
    });
    const api: PluginApi | PluginClientApi = params.target.realm === 'client'
        ? clientApi
        : daemonApi;

    return Object.freeze({
        api,
        commit() {
            assertRegistrationOpen();
            const missing = [...rightsByKey.keys()].filter((key) => !stagedByKey.has(key));
            if (missing.length > 0) {
                const right = rightsByKey.get(missing[0]!)!;
                fail(`Plugin '${params.pluginId}' activation is missing registration '${right.family}/${right.localId}'`);
            }
            state = 'committing';
            const capturedByKey = new Map<string, PluginRuntimeRegistration>();
            let mcpCleanupIndex = 0;
            for (const staged of stagedByKey.values()) {
                let capturedValue: PluginRegistrationValueByFamily[PluginRegistrationFamily];
                try {
                    if (staged.family === REGISTRATION_FAMILY.agents) {
                        capturedValue = snapshotAgentRuntimeRegistration(staged.value);
                    } else if (staged.family === REGISTRATION_FAMILY.providers) {
                        capturedValue = snapshotProviderRuntimeRegistration(staged.value);
                    } else {
                        capturedValue = snapshotStaticRegistrationValue(
                            staged.family,
                            staged.value as never,
                        );
                    }
                } catch {
                    fail(
                        `Plugin '${params.pluginId}' registered an invalid '${staged.family}/${staged.localId}' runtime`,
                    );
                }
                if (staged.family === REGISTRATION_FAMILY.agents) {
                    // Semantic coherence is attributable, not masked: resume
                    // reachability without a host-owned state-sharing
                    // descriptor is a declared-contract conflict, not a
                    // structural snapshot failure.
                    const launch = (
                        capturedValue as {
                            connectedAccountLaunch?: {
                                continuity?: { verifyResumeReachable?: unknown };
                                stateSharingDescriptor?: {
                                    state?: { supported?: boolean; entries?: readonly unknown[] };
                                };
                            };
                        }
                    ).connectedAccountLaunch;
                    const launchState = launch?.stateSharingDescriptor?.state;
                    const hasSupportedStateSharing = (
                        launchState?.supported === true
                        && (launchState.entries?.length ?? 0) > 0
                    );
                    if (
                        launch?.continuity?.verifyResumeReachable !== undefined
                        && !hasSupportedStateSharing
                    ) {
                        fail('Agent connected-account launch continuity.verifyResumeReachable requires a supported stateSharingDescriptor with declared state entries');
                    }
                }
                assertCommitActive();
                if (staged.family === REGISTRATION_FAMILY.mcpServers) {
                    ownedMcpServerCleanups[mcpCleanupIndex] = {
                        localId: staged.localId,
                        dispose: (capturedValue as PluginMcpServerRuntime).dispose,
                    };
                    mcpCleanupIndex += 1;
                }
                if (staged.family === REGISTRATION_FAMILY.voiceProviders) {
                    const capturedVoice = capturedValue as RegisteredVoiceProviderRuntime;
                    const expectedKind = params.target.realm === 'daemon' ? 'speech' : 'conversation';
                    if (capturedVoice.kind !== expectedKind) {
                        fail(
                            `Plugin '${params.pluginId}' registered a Voice ${capturedVoice.kind} runtime in the wrong ${params.target.realm} realm`,
                        );
                    }
                    const right = rightsByKey.get(registrationKey(staged.family, staged.localId))!;
                    assertVoiceRegistrationCorrespondence(right, capturedVoice);
                }
                if (staged.family === REGISTRATION_FAMILY.composerAttachments) {
                    const right = rightsByKey.get(registrationKey(staged.family, staged.localId))!;
                    assertComposerAttachmentRegistrationCorrespondence(
                        right,
                        capturedValue as ComposerAttachmentRuntime,
                    );
                }
                if (staged.family === REGISTRATION_FAMILY.connectedAccounts) {
                    const right = rightsByKey.get(registrationKey(staged.family, staged.localId))!;
                    assertConnectedAccountRegistrationCorrespondence(
                        right,
                        capturedValue as PluginConnectedAccountRuntime,
                    );
                }
                const captured = freezeRegistration(
                    staged.family,
                    staged.localId,
                    capturedValue as never,
                ) as PluginRuntimeRegistration;
                capturedByKey.set(registrationKey(staged.family, staged.localId), captured);
            }
            for (const right of rightsByKey.values()) {
                if (right.family !== REGISTRATION_FAMILY.agents || !right.requiredFields) continue;
                const registration = capturedByKey.get(registrationKey(right.family, right.localId));
                const value = registration?.family === REGISTRATION_FAMILY.agents
                    ? registration.value as PluginAgentRuntimeRegistration
                    : undefined;
                if (right.requiredFields.includes('factory') && value?.factory === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing Agent runtime for 'agents/${right.localId}'`);
                }
                if (right.requiredFields.includes('sessionRunnerFactory')
                    && value?.sessionRunnerFactory === undefined) {
                    fail(
                        `Plugin '${params.pluginId}' activation is missing Agent session runner factory locator for 'agents/${right.localId}'`,
                    );
                }
                if (!right.requiredFields.includes('sessionRunnerFactory')
                    && value?.sessionRunnerFactory !== undefined) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register a Session runner factory locator for non-Session Agent '${right.localId}'`,
                    );
                }
                if (right.requiredFields.includes('cliAuth') && value?.cliAuth === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing Agent CLI auth contribution for 'agents/${right.localId}'`);
                }
                if (!right.requiredFields.includes('cliAuth') && value?.cliAuth !== undefined) {
                    fail(`Plugin '${params.pluginId}' registered an undeclared Agent CLI auth contribution for 'agents/${right.localId}'`);
                }
                if (right.requiredFields.includes('externalSessions') && value?.externalSessions === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${right.localId}'`);
                }
            }
            for (const right of rightsByKey.values()) {
                if (right.family !== REGISTRATION_FAMILY.providers || !right.providerArms) continue;
                const registration = capturedByKey.get(registrationKey(right.family, right.localId));
                const value = registration?.family === REGISTRATION_FAMILY.providers
                    ? registration.value as StagedProviderRuntimeRegistration
                    : undefined;
                if (right.providerArms.managedRuntime && value?.managedRuntime === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing managed Provider runtime for 'providers/${right.localId}'`);
                }
                if (!right.providerArms.managedRuntime && value?.managedRuntime !== undefined) {
                    fail(`Plugin '${params.pluginId}' registered an undeclared managed Provider runtime for 'providers/${right.localId}'`);
                }
                const declaredFormats = right.providerArms.catalogParserIds;
                const registeredFormats = Object.keys(value?.catalogParsers ?? {}).sort();
                if (registeredFormats.length !== declaredFormats.length
                    || registeredFormats.some((format, index) => format !== declaredFormats[index])) {
                    fail(
                        `Plugin '${params.pluginId}' does not implement declared Provider catalog formats for 'providers/${right.localId}': `
                        + `declared [${declaredFormats.join(', ')}], registered [${registeredFormats.join(', ')}]`,
                    );
                }
            }
            for (const registration of capturedByKey.values()) {
                if (registration.family !== REGISTRATION_FAMILY.agents) continue;
                const value = registration.value as PluginAgentRuntimeRegistration;
                if ((value.externalSessionObservation !== undefined
                    || value.externalSessionHooks !== undefined
                    || value.externalSessionTakeover !== undefined)
                    && value.externalSessions === undefined) {
                    fail(
                        `Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${registration.localId}'`,
                    );
                }
            }
            for (const right of rightsByKey.values()) {
                if (right.family !== REGISTRATION_FAMILY.promptAssets || !right.promptAssetDescriptor) continue;
                const registration = capturedByKey.get(registrationKey(right.family, right.localId));
                const descriptor = registration?.family === REGISTRATION_FAMILY.promptAssets
                    ? (registration.value as PromptAssetAdapter).descriptor
                    : undefined;
                if (!isStructurallyEqual(right.promptAssetDescriptor, descriptor)) {
                    fail(`Plugin '${params.pluginId}' registered a mismatched Prompt Asset adapter descriptor for '${right.family}/${right.localId}'`);
                }
            }
            assertCommitActive();
            published = Object.freeze([...capturedByKey.values()]);
            state = 'committed';
            return published;
        },
        registrations() {
            return published;
        },
        dispose() {
            if (disposalPromise) return disposalPromise;
            state = 'disposed';
            published = Object.freeze([]);
            stagedByKey.clear();
            const pending = [...ownedMcpServerCleanups].reverse();
            ownedMcpServerCleanups.length = 0;
            const cleanupTimeoutMs = normalizeRegistrationCleanupTimeoutMs(
                params.cleanupTimeoutMs,
            );
            disposalPromise = (async () => {
                const errors: unknown[] = [];
                // Reverse order is an intentional LIFO dependency between
                // captured cleanups. Each independent cleanup receives its own
                // bounded attempt so one hung disposer cannot starve the
                // remaining steps; every timeout or rejection is collected for
                // the aggregate outcome.
                for (const cleanup of pending) {
                    if (!cleanup?.dispose) continue;
                    const capturedDispose = cleanup.dispose;
                    const outcome = await raceWithTimeout(
                        Promise.resolve().then(capturedDispose),
                        cleanupTimeoutMs,
                    );
                    if (outcome.type === 'rejected') {
                        errors.push(outcome.error);
                    } else if (outcome.type === 'timeout') {
                        errors.push(new Error(
                            `Plugin '${params.pluginId}' cleanup for 'mcp.servers/${cleanup.localId}' `
                            + `timed out after ${cleanupTimeoutMs}ms`,
                        ));
                    }
                }
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) {
                    throw new AggregateError(errors, `Plugin '${params.pluginId}' registration cleanup failed`);
                }
            })();
            return disposalPromise;
        },
    });
}
