import { COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1 } from '@happier-dev/protocol/plugins/contributions/composer-attachments';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/manifest';

import type {
    BackendRuntime,
    ComposerAttachmentRuntime,
    ComposerReferenceRuntime,
    HostingProviderRuntime,
    PluginMcpServerRuntime,
} from '../../activation.js';
import type { ManagedProviderRuntime } from '../../managed-services/contract.js';
import type {
    PluginRegistrationFamily,
    PluginRegistrationValueByFamily,
} from '../../registration/valueByFamily.js';
import {
    captureStaticRegistrationMethod,
    requireStaticRegistrationObject,
} from '../../registration/staticCapture.js';
import type { PromptAssetAdapter } from '../../resources.js';
import type { PluginDynamicResourceRuntime } from '../../services/resources.js';
import type { PluginConnectedAccountRuntime } from '../../services/index.js';
import type { VoiceProvidersRegistrationApi } from '../../voice/projections.js';

export { captureStaticRegistrationMethod };

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

function readMember(receiver: object, key: PropertyKey): unknown {
    return Reflect.get(receiver, key);
}

const VOICE_CONVERSATION_OPTIONAL_METHODS = Object.freeze([
    'beforeToolContinuation',
    'beforeInterrupt',
    'forgetProviderConversation',
    'dispose',
    'encodePostCancelControls',
    'encodePostBargeInControls',
] as const);

const requireObject = requireStaticRegistrationObject;

function readVoiceRuntimeMember(
    receiver: object,
    key: string,
    label: string,
    required: boolean,
): unknown {
    const value = readMember(receiver, key);
    if (value === undefined && required) throw new TypeError(`${label} is required`);
    return value;
}

function captureRequiredStaticDataMember(
    receiver: object,
    key: string,
    label: string,
): unknown {
    const value = readMember(receiver, key);
    if (value === undefined) throw new TypeError(`${label} is required`);
    return snapshotStaticData(value, label);
}

/**
 * Static descriptors are copied once at commit. This deliberately uses
 * ordinary reads instead of object-topology inspection: plugin code is trusted
 * executable code, while the host needs an immutable value rather than a
 * second object-authentication protocol. This executable descriptor snapshot
 * is not an ordinary-JSON transport boundary, so it does not borrow generic
 * JSON depth, node, or string budgets.
 */
function snapshotStaticData(
    value: unknown,
    label: string,
    ancestors: ReadonlySet<object> = new Set(),
): unknown {
    if (typeof value === 'function') {
        throw new TypeError(`${label} must be static data`);
    }
    if (typeof value !== 'object' || value === null) return value;
    if (ancestors.has(value)) throw new TypeError(`${label} must not be circular`);
    const nextAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        const snapshot: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
            snapshot.push(snapshotStaticData(
                readMember(value, String(index)),
                `${label}[${index}]`,
                nextAncestors,
            ));
        }
        return Object.freeze(snapshot);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        Object.defineProperty(snapshot, key, {
            configurable: false,
            enumerable: true,
            value: snapshotStaticData(
                readMember(value, key),
                `${label}.${key}`,
                nextAncestors,
            ),
            writable: false,
        });
    }
    return Object.freeze(snapshot);
}

/**
 * Captures trusted plugin declaration data at registration commit time. This
 * is intentionally a data snapshot rather than another domain validator; the
 * owning consumer validates its operational invariants.
 */
export function snapshotStaticRegistrationData(value: unknown, label: string): unknown {
    return snapshotStaticData(value, label);
}

function snapshotMethodGroup(
    value: unknown,
    methodNames: readonly string[],
    label: string,
): Readonly<Record<string, unknown>> {
    const receiver = requireObject(value, label);
    const snapshot: Record<string, unknown> = {};
    for (const methodName of methodNames) {
        const method = captureStaticRegistrationMethod(
            receiver,
            methodName,
            `${label}.${methodName}`,
            false,
        );
        if (method !== undefined) snapshot[methodName] = method;
    }
    return Object.freeze(snapshot);
}

export function captureVoiceProviderRuntimeKind(
    runtime: RegisteredVoiceProviderRuntime,
): RegisteredVoiceProviderRuntime['kind'] {
    const receiver = requireObject(runtime, 'Voice provider runtime');
    const kind = readVoiceRuntimeMember(receiver, 'kind', 'Voice provider runtime.kind', true);
    if (kind !== 'speech' && kind !== 'conversation') {
        throw new TypeError('Voice provider runtime.kind is invalid');
    }
    return kind;
}

function snapshotSettingsActions(
    value: NonNullable<RegisteredVoiceProviderRuntime['settingsActions']>,
): NonNullable<RegisteredVoiceProviderRuntime['settingsActions']> {
    const receiver = requireObject(value, 'Voice settings-action runtime');
    return Object.freeze({
        execute: captureStaticRegistrationMethod<
            NonNullable<RegisteredVoiceProviderRuntime['settingsActions']>['execute']
        >(receiver, 'execute', 'Voice settings-action runtime.execute', true)!,
    });
}

export function snapshotVoiceProviderRuntime(
    runtime: RegisteredVoiceProviderRuntime,
    capturedKind?: RegisteredVoiceProviderRuntime['kind'],
): RegisteredVoiceProviderRuntime {
    const actualKind = captureVoiceProviderRuntimeKind(runtime);
    if (capturedKind !== undefined && capturedKind !== actualKind) {
        throw new TypeError('Voice provider runtime.kind is invalid');
    }
    const kind = capturedKind ?? actualKind;
    const receiver = requireObject(runtime, 'Voice provider runtime');
    const settingsActionsValue = readVoiceRuntimeMember(
        receiver,
        'settingsActions',
        'Voice provider runtime.settingsActions',
        false,
    );
    const settingsActions = settingsActionsValue === undefined
        ? undefined
        : snapshotSettingsActions(
            settingsActionsValue as NonNullable<RegisteredVoiceProviderRuntime['settingsActions']>,
        );

    if (kind === 'speech') {
        const catalogValue = readVoiceRuntimeMember(
            receiver,
            'catalog',
            'Voice speech runtime.catalog',
            false,
        );
        const catalog = catalogValue === undefined
            ? undefined
            : (() => {
                const catalogReceiver = requireObject(catalogValue, 'Voice speech catalog runtime');
                return Object.freeze({
                    list: captureStaticRegistrationMethod<NonNullable<Extract<
                        RegisteredVoiceProviderRuntime,
                        Readonly<{ kind: 'speech' }>
                    >['catalog']>['list']>(
                        catalogReceiver,
                        'list',
                        'Voice speech catalog runtime.list',
                        true,
                    )!,
                });
            })();
        const transcribe = captureStaticRegistrationMethod(
            receiver,
            'transcribe',
            'Voice speech runtime.transcribe',
            false,
        );
        const synthesize = captureStaticRegistrationMethod(
            receiver,
            'synthesize',
            'Voice speech runtime.synthesize',
            false,
        );
        return Object.freeze({
            kind: 'speech' as const,
            ...(catalog ? { catalog } : {}),
            ...(transcribe ? { transcribe } : {}),
            ...(synthesize ? { synthesize } : {}),
            ...(settingsActions ? { settingsActions } : {}),
        }) as RegisteredVoiceProviderRuntime;
    }

    const protocolReceiver = requireObject(
        readVoiceRuntimeMember(receiver, 'protocol', 'Voice conversation runtime.protocol', true),
        'Voice conversation protocol',
    );
    const preflight = captureStaticRegistrationMethod(
        protocolReceiver,
        'preflight',
        'Voice conversation protocol.preflight',
        false,
    );
    const prepare = captureStaticRegistrationMethod(
        protocolReceiver,
        'prepare',
        'Voice conversation protocol.prepare',
        true,
    );
    const decodeControl = captureStaticRegistrationMethod(
        protocolReceiver,
        'decodeControl',
        'Voice conversation protocol.decodeControl',
        true,
    );
    const encodeTurnControl = captureStaticRegistrationMethod(
        protocolReceiver,
        'encodeTurnControl',
        'Voice conversation protocol.encodeTurnControl',
        true,
    );
    const refreshAuth = captureStaticRegistrationMethod(
        protocolReceiver,
        'refreshAuth',
        'Voice conversation protocol.refreshAuth',
        false,
    );
    const releasePrepared = captureStaticRegistrationMethod(
        protocolReceiver,
        'releasePrepared',
        'Voice conversation protocol.releasePrepared',
        false,
    );
    const protocol = Object.freeze({
        ...(preflight ? { preflight } : {}),
        prepare: prepare!,
        decodeControl: decodeControl!,
        encodeTurnControl: encodeTurnControl!,
        ...(refreshAuth ? { refreshAuth } : {}),
        ...(releasePrepared ? { releasePrepared } : {}),
    });
    const settingsOperationsValue = readVoiceRuntimeMember(
        receiver,
        'settingsOperations',
        'Voice conversation runtime.settingsOperations',
        false,
    );
    const settingsOperations = settingsOperationsValue === undefined
        ? undefined
        : (() => {
            const settingsReceiver = requireObject(
                settingsOperationsValue,
                'Voice conversation settings runtime',
            );
            const listCatalog = captureStaticRegistrationMethod(
                settingsReceiver,
                'listCatalog',
                'Voice conversation settings runtime.listCatalog',
                false,
            );
            return Object.freeze({ ...(listCatalog ? { listCatalog } : {}) });
        })();
    const microphoneMode = readVoiceRuntimeMember(
        receiver,
        'microphoneMode',
        'Voice conversation runtime.microphoneMode',
        true,
    );
    const outputLevelMeter = readVoiceRuntimeMember(
        receiver,
        'outputLevelMeter',
        'Voice conversation runtime.outputLevelMeter',
        false,
    );
    if (
        microphoneMode !== 'host_webrtc'
        && microphoneMode !== 'host_pcm'
        && microphoneMode !== 'provider_managed'
    ) {
        throw new TypeError(
            'Voice conversation runtime.microphoneMode must be host_webrtc, host_pcm, or provider_managed',
        );
    }
    if (outputLevelMeter !== undefined
        && outputLevelMeter !== 'measured'
        && outputLevelMeter !== 'unavailable') {
        throw new TypeError('Voice conversation runtime.outputLevelMeter must be measured or unavailable');
    }
    const optionalMethods: Record<string, unknown> = {};
    for (const methodName of VOICE_CONVERSATION_OPTIONAL_METHODS) {
        const method = captureStaticRegistrationMethod(
            receiver,
            methodName,
            `Voice conversation runtime.${methodName}`,
            false,
        );
        if (method !== undefined) optionalMethods[methodName] = method;
    }
    const setInputMuted = captureStaticRegistrationMethod(
        receiver,
        'setInputMuted',
        'Voice conversation runtime.setInputMuted',
        microphoneMode === 'provider_managed',
    );
    if (setInputMuted !== undefined) optionalMethods.setInputMuted = setInputMuted;
    return Object.freeze({
        kind: 'conversation' as const,
        protocol,
        ...(settingsOperations ? { settingsOperations } : {}),
        createConnection: captureStaticRegistrationMethod(
            receiver,
            'createConnection',
            'Voice conversation runtime.createConnection',
            true,
        )!,
        encodeToolResults: captureStaticRegistrationMethod(
            receiver,
            'encodeToolResults',
            'Voice conversation runtime.encodeToolResults',
            true,
        )!,
        encodeToolContinuation: captureStaticRegistrationMethod(
            receiver,
            'encodeToolContinuation',
            'Voice conversation runtime.encodeToolContinuation',
            true,
        )!,
        encodeContextUpdate: captureStaticRegistrationMethod(
            receiver,
            'encodeContextUpdate',
            'Voice conversation runtime.encodeContextUpdate',
            true,
        )!,
        encodeTextTurn: captureStaticRegistrationMethod(
            receiver,
            'encodeTextTurn',
            'Voice conversation runtime.encodeTextTurn',
            true,
        )!,
        ...optionalMethods,
        microphoneMode,
        ...(outputLevelMeter === undefined ? {} : { outputLevelMeter }),
        ...(settingsActions ? { settingsActions } : {}),
    }) as RegisteredVoiceProviderRuntime;
}

const MCP_SERVER_METHODS = Object.freeze([
    'dispose',
    'listTools',
    'callTool',
    'listResources',
    'listResourceTemplates',
    'readResource',
    'subscribeResource',
    'listPrompts',
    'getPrompt',
] as const);

export function snapshotMcpServerRuntime(
    runtime: PluginMcpServerRuntime,
): PluginMcpServerRuntime {
    const receiver = requireObject(runtime, 'MCP server runtime');
    const snapshot: Record<string, unknown> = {};
    for (const methodName of MCP_SERVER_METHODS) {
        snapshot[methodName] = captureStaticRegistrationMethod(
            receiver,
            methodName,
            `MCP server runtime.${methodName}`,
            true,
        );
    }
    return Object.freeze(snapshot) as unknown as PluginMcpServerRuntime;
}

const SCM_HOSTING_METHODS = Object.freeze([
    'detectRemote',
    'buildCompareUrl',
    'getPullRequestAuthProfileKey',
    'listPullRequests',
    'getPullRequest',
    'createPullRequest',
    'getDefaultBranch',
    'resolvePullRequestCheckoutReference',
    'describePublishTargets',
    'createRepository',
    'getRepository',
    'describeCloneTargets',
] as const);

export function snapshotScmHostingProviderRuntime(
    runtime: HostingProviderRuntime,
): HostingProviderRuntime {
    const receiver = requireObject(runtime, 'SCM hosting Provider runtime');
    return Object.freeze({
        adapter: snapshotMethodGroup(
            readMember(receiver, 'adapter'),
            SCM_HOSTING_METHODS,
            'SCM hosting Provider adapter',
        ),
    }) as HostingProviderRuntime;
}

const SCM_BACKEND_HANDLER_METHODS = Object.freeze({
    detection: ['detectRepo', 'describeBackend'],
    read: ['statusSnapshot', 'worktreesEnrichment', 'diffFile', 'diffCommit', 'logList', 'stashList'],
    changeSet: ['include', 'exclude', 'discard'],
    commit: ['create', 'backout'],
    remote: ['add', 'setUrl', 'remove', 'fetch', 'pull', 'push', 'publish'],
    branch: ['list', 'create', 'checkout', 'merge', 'rebase', 'operationContinue', 'operationAbort'],
    worktree: ['create', 'remove', 'prune'],
    lifecycle: ['init', 'clone', 'removeIndexLock'],
    hosting: [
        'repositoryDescribePublishTargets',
        'repositoryPublish',
        'pullRequestList',
        'pullRequestGet',
        'pullRequestOpenCompose',
        'pullRequestOpenOrReuse',
        'pullRequestCheckout',
        'pullRequestPrepareWorktree',
        'pullRequestRunStacked',
    ],
    stash: ['drop', 'pop', 'apply', 'show'],
    workspaceIntegration: [
        'inspectWorkspaceLocation',
        'reconcilePostMaterialization',
        'realizeWorkspaceCheckout',
        'createWorkspaceCheckout',
        'materializeWorkspaceCheckout',
        'resolveWorkspaceTransferEntries',
        'resolveWorkspaceTransferMetadata',
        'assertPortableWorkspaceEntries',
        'classifyPortableWorkspaceTransferEntry',
        'isAdministrativeWorkspacePath',
        'classifyPortableWorkspacePath',
    ],
} as const);

function snapshotScmBackendRuntimeDescriptor(
    value: unknown,
): NonNullable<BackendRuntime['runtime']> {
    const receiver = requireObject(value, 'SCM backend runtime descriptor');
    return Object.freeze({
        repoModes: captureRequiredStaticDataMember(
            receiver,
            'repoModes',
            'SCM backend runtime descriptor.repoModes',
        ),
        capabilities: captureRequiredStaticDataMember(
            receiver,
            'capabilities',
            'SCM backend runtime descriptor.capabilities',
        ),
        commands: captureRequiredStaticDataMember(
            receiver,
            'commands',
            'SCM backend runtime descriptor.commands',
        ),
    }) as NonNullable<BackendRuntime['runtime']>;
}

export function snapshotScmBackendRuntime(runtime: BackendRuntime): BackendRuntime {
    const receiver = requireObject(runtime, 'SCM backend runtime');
    const handlersReceiver = requireObject(
        readMember(receiver, 'handlers'),
        'SCM backend handlers',
    );
    const handlers: Record<string, unknown> = {};
    for (const [groupName, methodNames] of Object.entries(SCM_BACKEND_HANDLER_METHODS)) {
        const group = readMember(handlersReceiver, groupName);
        if (group === undefined) continue;
        handlers[groupName] = snapshotMethodGroup(
            group,
            methodNames,
            `SCM backend handlers.${groupName}`,
        );
    }
    const runtimeDescriptor = readMember(receiver, 'runtime');
    return Object.freeze({
        ...(runtimeDescriptor === undefined
            ? {}
            : { runtime: snapshotScmBackendRuntimeDescriptor(runtimeDescriptor) }),
        handlers: Object.freeze(handlers),
    }) as BackendRuntime;
}

export function snapshotPromptAssetDescriptor(
    descriptor: PromptAssetAdapter['descriptor'],
): PromptAssetAdapter['descriptor'] {
    // The descriptor is compared with its normalized manifest declaration, so
    // it is the one registration payload whose data contract is deliberately closed.
    return snapshotStaticData(
        descriptor,
        'Prompt Asset adapter descriptor',
    ) as PromptAssetAdapter['descriptor'];
}

export function snapshotPromptAssetAdapter(adapter: PromptAssetAdapter): PromptAssetAdapter {
    const receiver = requireObject(adapter, 'Prompt Asset adapter');
    return Object.freeze({
        descriptor: snapshotPromptAssetDescriptor(
            readMember(receiver, 'descriptor') as PromptAssetAdapter['descriptor'],
        ),
        discover: captureStaticRegistrationMethod<PromptAssetAdapter['discover']>(
            receiver,
            'discover',
            'Prompt Asset adapter.discover',
            true,
        )!,
        read: captureStaticRegistrationMethod<PromptAssetAdapter['read']>(
            receiver,
            'read',
            'Prompt Asset adapter.read',
            true,
        )!,
        writeDoc: captureStaticRegistrationMethod<PromptAssetAdapter['writeDoc']>(
            receiver,
            'writeDoc',
            'Prompt Asset adapter.writeDoc',
            true,
        )!,
        writeBundle: captureStaticRegistrationMethod<PromptAssetAdapter['writeBundle']>(
            receiver,
            'writeBundle',
            'Prompt Asset adapter.writeBundle',
            true,
        )!,
        delete: captureStaticRegistrationMethod<PromptAssetAdapter['delete']>(
            receiver,
            'delete',
            'Prompt Asset adapter.delete',
            true,
        )!,
    }) as PromptAssetAdapter;
}

export function snapshotDynamicResourceRuntime(
    runtime: PluginDynamicResourceRuntime,
): PluginDynamicResourceRuntime {
    const receiver = requireObject(runtime, 'Dynamic Resource runtime');
    return Object.freeze({
        read: captureStaticRegistrationMethod<PluginDynamicResourceRuntime['read']>(
            receiver,
            'read',
            'Dynamic Resource runtime.read',
            true,
        )!,
        observe: captureStaticRegistrationMethod<PluginDynamicResourceRuntime['observe']>(
            receiver,
            'observe',
            'Dynamic Resource runtime.observe',
            true,
        )!,
    });
}

export function snapshotComposerReferenceRuntime(
    runtime: ComposerReferenceRuntime,
): ComposerReferenceRuntime {
    const receiver = requireObject(runtime, 'Composer reference provider runtime');
    return Object.freeze({
        search: captureStaticRegistrationMethod<ComposerReferenceRuntime['search']>(
            receiver,
            'search',
            'Composer reference provider runtime.search',
            true,
        )!,
        resolve: captureStaticRegistrationMethod<ComposerReferenceRuntime['resolve']>(
            receiver,
            'resolve',
            'Composer reference provider runtime.resolve',
            true,
        )!,
    });
}

/**
 * Attachment lifecycles are a closed public runtime object. Unlike legacy
 * reference providers, its declaration advertises an exact callback set, so
 * preserve no unrecognized runtime surface for a later host to misinterpret.
 */
export function snapshotComposerAttachmentRuntime(
    runtime: ComposerAttachmentRuntime,
): ComposerAttachmentRuntime {
    if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
        throw new TypeError('Composer attachment runtime must be an object');
    }
    const ownKeys = Reflect.ownKeys(runtime);
    if (ownKeys.some((key) => typeof key !== 'string'
        || !COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1.includes(
            key as typeof COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1[number],
        ))) {
        throw new TypeError('Composer attachment runtime contains unknown fields');
    }
    const snapshot: {
        prepareForSend?: ComposerAttachmentRuntime['prepareForSend'];
        resolveForDispatch?: ComposerAttachmentRuntime['resolveForDispatch'];
        afterMessageAccepted?: ComposerAttachmentRuntime['afterMessageAccepted'];
    } = {};
    for (const field of COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1) {
        const method = captureStaticRegistrationMethod(
            runtime,
            field,
            `Composer attachment runtime.${field}`,
            false,
        );
        if (method !== undefined) {
            snapshot[field] = method as never;
        }
    }
    return Object.freeze(snapshot);
}

function snapshotConnectedAccountMode(
    value: unknown,
    modeId: string,
): PluginConnectedAccountRuntime['authentication']['modes'][string] {
    const receiver = requireObject(value, `Connected-account authentication mode '${modeId}'`);
    const kind = readMember(receiver, 'kind');
    const reconcile = captureStaticRegistrationMethod(
        receiver,
        'reconcile',
        `Connected-account authentication mode '${modeId}'.reconcile`,
        false,
    );
    if (kind === 'manual') {
        return Object.freeze({
            kind,
            complete: captureStaticRegistrationMethod(
                receiver,
                'complete',
                `Manual connected-account authentication mode '${modeId}'.complete`,
                true,
            )!,
            ...(reconcile ? { reconcile } : {}),
        }) as PluginConnectedAccountRuntime['authentication']['modes'][string];
    }
    if (kind === 'oauthAuthorizationCode') {
        return Object.freeze({
            kind,
            begin: captureStaticRegistrationMethod(
                receiver,
                'begin',
                `OAuth connected-account authentication mode '${modeId}'.begin`,
                true,
            )!,
            complete: captureStaticRegistrationMethod(
                receiver,
                'complete',
                `OAuth connected-account authentication mode '${modeId}'.complete`,
                true,
            )!,
            cancel: captureStaticRegistrationMethod(
                receiver,
                'cancel',
                `OAuth connected-account authentication mode '${modeId}'.cancel`,
                true,
            )!,
            ...(reconcile ? { reconcile } : {}),
        }) as PluginConnectedAccountRuntime['authentication']['modes'][string];
    }
    if (kind === 'oauthDeviceCode') {
        return Object.freeze({
            kind,
            begin: captureStaticRegistrationMethod(
                receiver,
                'begin',
                `Device connected-account authentication mode '${modeId}'.begin`,
                true,
            )!,
            poll: captureStaticRegistrationMethod(
                receiver,
                'poll',
                `Device connected-account authentication mode '${modeId}'.poll`,
                true,
            )!,
            cancel: captureStaticRegistrationMethod(
                receiver,
                'cancel',
                `Device connected-account authentication mode '${modeId}'.cancel`,
                true,
            )!,
            ...(reconcile ? { reconcile } : {}),
        }) as PluginConnectedAccountRuntime['authentication']['modes'][string];
    }
    throw new TypeError(`Connected-account authentication mode '${modeId}' has an unknown kind`);
}

export function snapshotConnectedAccountRuntime(
    runtime: PluginConnectedAccountRuntime,
): PluginConnectedAccountRuntime {
    const receiver = requireObject(runtime, 'Connected-account runtime');
    const authentication = requireObject(
        readMember(receiver, 'authentication'),
        'Connected-account authentication runtime',
    );
    const modesReceiver = requireObject(
        readMember(authentication, 'modes'),
        'Connected-account authentication modes',
    );
    const modeIds = Object.keys(modesReceiver);
    if (modeIds.length === 0
        || modeIds.some((modeId) => !PluginContributionLocalIdSchema.safeParse(modeId).success)) {
        throw new TypeError('Connected-account authentication modes must use contribution-local ids');
    }
    const modes: Record<string, PluginConnectedAccountRuntime['authentication']['modes'][string]> = {};
    for (const modeId of modeIds) {
        modes[modeId] = snapshotConnectedAccountMode(readMember(modesReceiver, modeId), modeId);
    }
    const quota = captureStaticRegistrationMethod<PluginConnectedAccountRuntime['quota']>(
        receiver,
        'quota',
        'Connected-account runtime.quota',
        false,
    );
    return Object.freeze({
        authentication: Object.freeze({ modes: Object.freeze(modes) }),
        refresh: captureStaticRegistrationMethod<PluginConnectedAccountRuntime['refresh']>(
            receiver,
            'refresh',
            'Connected-account runtime.refresh',
            true,
        )!,
        revoke: captureStaticRegistrationMethod<PluginConnectedAccountRuntime['revoke']>(
            receiver,
            'revoke',
            'Connected-account runtime.revoke',
            true,
        )!,
        status: captureStaticRegistrationMethod<PluginConnectedAccountRuntime['status']>(
            receiver,
            'status',
            'Connected-account runtime.status',
            true,
        )!,
        materialize: captureStaticRegistrationMethod<PluginConnectedAccountRuntime['materialize']>(
            receiver,
            'materialize',
            'Connected-account runtime.materialize',
            true,
        )!,
        ...(quota ? { quota } : {}),
    }) as PluginConnectedAccountRuntime;
}

export function snapshotManagedProviderRuntime(
    runtime: ManagedProviderRuntime,
): ManagedProviderRuntime {
    const receiver = requireObject(runtime, 'Managed Provider runtime');
    return Object.freeze({
        start: captureStaticRegistrationMethod<ManagedProviderRuntime['start']>(
            receiver,
            'start',
            'Managed Provider runtime.start',
            true,
        )!,
    });
}

function captureDirectCallable(value: unknown, family: PluginRegistrationFamily): unknown {
    if (typeof value !== 'function') {
        throw new TypeError(`${family} registration must be a function`);
    }
    return value;
}

/**
 * The canonical registration value map is the policy source. Keep this switch
 * exhaustive: object families must take exactly one registration-commit capture
 * path, while direct callbacks preserve identity and the registration scope
 * captures the staged Agent composite through its field-specific owner.
 */
export function snapshotStaticRegistrationValue<
    TFamily extends PluginRegistrationFamily,
>(
    family: TFamily,
    value: PluginRegistrationValueByFamily[TFamily],
): PluginRegistrationValueByFamily[TFamily] {
    const policyFamily: PluginRegistrationFamily = family;
    switch (policyFamily) {
        case 'actions':
        case 'hooks':
        case 'events':
        case 'notificationChannels':
        case 'mcp.discoverySources':
        case 'requestInterceptors':
        case 'backgroundServices':
            return captureDirectCallable(value, policyFamily) as PluginRegistrationValueByFamily[TFamily];
        case 'agents':
            // The registration scope captures the staged Agent composite at
            // commit because its public API assembles several subregistrations.
            throw new TypeError('Agent registrations must be captured field-by-field');
        case 'connectedAccountDescriptors':
            return snapshotConnectedAccountRuntime(
                value as PluginConnectedAccountRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'providers':
            // Like Agents, a Provider registration is a composite the scope
            // assembles from several subregistrations; it is captured
            // field-by-field at commit.
            throw new TypeError('Provider registrations must be captured field-by-field');
        case 'scmHostingProviders':
            return snapshotScmHostingProviderRuntime(
                value as HostingProviderRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'scmBackends':
            return snapshotScmBackendRuntime(value as BackendRuntime) as PluginRegistrationValueByFamily[TFamily];
        case 'mcp.servers':
            return snapshotMcpServerRuntime(
                value as PluginMcpServerRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'voiceProviders':
            return snapshotVoiceProviderRuntime(
                value as RegisteredVoiceProviderRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'promptAssets':
            return snapshotPromptAssetAdapter(value as PromptAssetAdapter) as PluginRegistrationValueByFamily[TFamily];
        case 'resources':
            return snapshotDynamicResourceRuntime(
                value as PluginDynamicResourceRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'composerReferences':
            return snapshotComposerReferenceRuntime(
                value as ComposerReferenceRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
        case 'composerAttachments':
            return snapshotComposerAttachmentRuntime(
                value as ComposerAttachmentRuntime,
            ) as PluginRegistrationValueByFamily[TFamily];
    }
    const exhaustive: never = policyFamily;
    return exhaustive;
}
