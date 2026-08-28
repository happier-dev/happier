import type { ReactNode } from 'react';
import {
    buildBackendTargetKeyV2,
    readAcpConfiguredBackendV1FromMetadata,
    readBackendTargetRefV2,
    SessionModelSelectionIntentV1Schema,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    AccountProfile,
    type ExternalSessionsAgentId,
    type AcpConfigOptionOverridesV1,
    type PendingDeliveryDetailV1,
    ExternalSessionLinkEnsureRequest,
    ExternalSessionsSource,
    RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentCoreConfig, AgentId, BundledAgentId, CanonicalAgentId, PermissionPromptProtocol } from './registryCore';
import {
    CANONICAL_AGENT_IDS,
    getAgentCore,
    isBundledAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
} from './registryCore';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { TranslationKey } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import type { PendingInputServerWireMode } from '@/sync/engine/pending/pendingInputServerWireContract';
import {
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS,
    type BundledAgentUiBehaviorDescriptor,
} from './generatedBundledPluginEntries.uiBehaviorOverrides';
import {
    createAgentUiBehaviorFromDescriptor,
    readOwnerMetadataFromSessionLike,
} from './agentUiBehaviorDescriptors';
import {
    resolveProjectedAgentUiBehaviorEntry,
    type ProjectedAgentUiBehaviorEntry,
} from './agentUiBehaviorProjection';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID } from '@/agents/backendCatalog/legacyCompatAgents';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveSessionGoalExecutionCapabilities } from '@/sync/domains/session/control/sessionGoalExecutionCapabilities';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export type PendingDeliveryTransientAction = Readonly<{
    id: 'interrupt_and_run';
    localId: string;
    stateAtMs?: number;
}>;

// RU-02: allow legacy compat ids at ingress (never as canonical agents).
export type AgentLookupId = AgentId | typeof LEGACY_COMPAT_PRIMARY_AGENT_ID;

export type AgentExperimentSwitches = Readonly<Record<string, boolean>>;

export type AgentResumeExperiments = Readonly<{
    enabled: boolean;
    switches: AgentExperimentSwitches;
}>;

export type AgentSpawnSessionExtras = Readonly<{
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
}> & Readonly<Record<string, unknown>>;

export type AgentExperimentSwitchDef = Readonly<{
    id: string;
    settingKey?: keyof Settings;
    getValue?: (settings: Settings) => boolean;
}>;

export type AgentTranscriptStorageMode = 'persisted' | 'direct';
export type AgentPermissionFooterStopHandling = 'denyOnly' | 'denyAndAbortRun';
export type AgentPermissionFooterBehavior = Readonly<{
    usePermissionUpdates: boolean;
    forceReadOnlyAfterStop: boolean;
    supportsExecPolicyAmendment: boolean;
    stopHandling: AgentPermissionFooterStopHandling;
}>;

export type AgentAskUserQuestionDialogBehavior = Readonly<{
    dialogId: string;
    settingMutation?: Readonly<{
        settingId: string;
        allowedValues: readonly string[];
    }>;
    terminalNotice?: Readonly<{
        headerKey: TranslationKey;
        questionKey: TranslationKey;
    }>;
    terminalSecondaryAction?: Readonly<{
        kind: 'openAttachedTerminal';
        labelKey: TranslationKey;
        descriptionKey: TranslationKey;
    }>;
}>;

/**
 * A closed, data-only declaration for host-owned AskUserQuestion behavior.
 * It can identify an exact dialog, allowlist one setting/value vocabulary, and
 * select the host's attached-terminal presentation. It cannot provide a
 * callback, route, or general effect.
 */
export type AgentAskUserQuestionBehavior = Readonly<{
    dialogs: readonly AgentAskUserQuestionDialogBehavior[];
}>;

export type ExternalSessionBrowseSourceOption = Readonly<{
    key: string;
    label: string;
    detail?: string;
    source: ExternalSessionsSource;
}>;

export type ExternalSessionBrowseLinkEnsureRequestExtras = Readonly<
    Partial<Omit<ExternalSessionLinkEnsureRequest, 'machineId' | 'providerId' | 'remoteSessionId' | 'titleHint' | 'directoryHint'>>
>;

export type AgentSessionHandoffProviderPatch = Readonly<{
    clearMetadataKeys?: readonly string[];
    metadataPatch?: Record<string, unknown>;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    externalSessionRuntimeDescriptor?: RuntimeDescriptorV1 | null;
}>;

export type AgentSessionHandoffSourceRecoveryResumePatch = Readonly<{
    environmentVariables?: Record<string, string>;
}>;

export type AgentSessionComposerNonSteerableReason = 'provider_config_change_refused';

export type AgentSessionComposerNonSteerablePayloadContext = Readonly<{
    agentId: AgentLookupId;
    agentTargetKey: string;
    session: Session;
    metaOverrides?: Record<string, unknown> | null;
    currentRunnerProcessIdentity: CurrentSessionRunnerProcessIdentity | null;
}>;

export type AgentContextWindowBehavior = Readonly<{
    getDefaultContextWindowTokens?: () => number | null;
    getContextWindowTokensForModel?: (ctx: Readonly<{
        modelId: string;
        description?: unknown;
    }>) => number | null;
    bumpContextWindowTokensForObservedUsage?: (ctx: Readonly<{
        contextWindowTokens: number;
        observedUsedTokens: unknown;
    }>) => number;
}>;

export type AgentBackendTransportFields = Readonly<{
    runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export type AgentBackendTransportContext = Readonly<{
    agentId: AgentLookupId;
    backendTarget: BackendTargetRefV2;
    providerMode?: unknown;
    legacyExperimentalMode?: boolean;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    providerSessionId?: string;
}>;

/**
 * Declarative data for a session-subagent launch surface. The registry owns
 * which declared surface applies; the session-subagent UI adapter owns its
 * physical React rendering and mount role.
 */
export type AgentSessionSubagentLaunchSurface = Readonly<{
    slotId: string;
    pluginId: string;
    surfaceId: string;
    sessionId: string;
    machineId: string | null;
    agentId: string;
    launchInput?: PluginUiJsonValueV1;
}>;

export type AgentUiBehavior = Readonly<{
    /**
     * The bundled Agent that owns this behavior. It is deliberately absent
     * for the neutral unknown fallback so callers cannot mistake an unknown
     * external identity for a built-in Agent.
     */
    agentId?: CanonicalAgentId;
    /**
     * Presentation of the host's own pending-input custody facts. The host owns
     * both the decision and the state it reads (`agentState.capabilities`,
     * published by any Agent through the public SDK runtime context); an Agent
     * only declares that it participates and which label names it.
     */
    pendingDelivery?: Readonly<{
        /**
         * Label shown once the runner reports custody of a queued prompt.
         * Undeclared means the Agent publishes no custody evidence and the
         * generic queued presentation applies.
         */
        custodyLabelKey?: TranslationKey;
        /**
         * Whether the Agent's runner honours `interrupt_and_run` for the
         * prompt it currently holds. The host still requires the runner to have
         * published that local id before offering the action.
         */
        interruptAndRun?: boolean;
    }>;
    /**
     * Whether this Agent's sessions can be driven from the attached terminal
     * viewer. Serviceability itself is a host fact
     * (`metadata.terminal.controlServiceabilityV1`, written by the daemon for
     * whichever Agent runs inside a terminal host), so this is an opt-in, not a
     * second decision-maker.
     */
    attachedSessionTerminal?: Readonly<{
        supported?: boolean;
    }>;
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    permissions?: Readonly<{
        /**
         * Which permission-prompt conversation this Agent speaks. It selects the
         * footer's whole semantic action model — button set, handlers and
         * terminal-decision reading — not just its wording, so it is a behavior
         * fact rather than presentation. A bundled Agent's build-time core
         * supplies it here; an installed Agent declares it in the same public
         * block, so the footer has ONE owner for both.
         */
        promptProtocol?: PermissionPromptProtocol;
        footer?: Partial<AgentPermissionFooterBehavior>;
    }>;
    askUserQuestion?: AgentAskUserQuestionBehavior;
    resume?: Readonly<{
        experimentSwitches?: readonly AgentExperimentSwitchDef[];
    }>;
    workState?: Readonly<{
        supportsEditableGoals?: (ctx: {
            agentId: AgentLookupId;
            session: Session;
        }) => boolean;
        /**
         * Provider goal-action capability profile applied when no goal item carries its own
         * `goalCapabilities` yet (the "Set goal" form before any native goal is derived). Lets a
         * provider restrict the control surface (e.g. Claude: edit/clear only, no budget) at the
         * session level without the goal-item round-trip. Return null to fall back to the full legacy
         * control surface.
         */
        resolveGoalActionCapabilityProfile?: (ctx: {
            agentId: AgentLookupId;
            session: Session;
        }) => GoalActionCapabilities | null;
    }>;
    sessionComposer?: Readonly<{
        classifyNonSteerablePayload?: (
            ctx: AgentSessionComposerNonSteerablePayloadContext
        ) => AgentSessionComposerNonSteerableReason | null;
    }>;
    contextWindow?: AgentContextWindowBehavior;
    message?: Readonly<{
        buildOverrides?: (ctx: Readonly<{
            session: unknown;
            settings?: Record<string, unknown>;
            metaOverrides?: Record<string, unknown>;
        }>) => Record<string, unknown> | undefined;
    }>;
    newSession?: Readonly<{
        resolveConfiguredRuntimeKind?: (ctx: {
            agentId: AgentLookupId;
            settings: Settings;
        }) => string | null;
        buildNewSessionOptions?: (ctx: {
            agentId: AgentLookupId;
            agentOptionState?: Record<string, unknown> | null;
        }) => Record<string, unknown> | null;
        canSelectWithoutDetectedCli?: (ctx: NewSessionCliSelectabilityContext) => boolean;
        getAgentInputExtraActionChips?: (ctx: {
            agentId: AgentLookupId;
            agentOptionState?: Record<string, unknown> | null;
            setAgentOptionState: (key: string, value: unknown) => void;
        }) => ReadonlyArray<AgentInputExtraActionChip> | undefined;
        supportsTranscriptStorageMode?: (ctx: {
            agentId: AgentLookupId;
            settings: Settings;
            storageMode: AgentTranscriptStorageMode;
        }) => boolean;
        getPreflightIssues?: (ctx: NewSessionPreflightContext) => readonly NewSessionPreflightIssue[];
        getRelevantInstallableDepKeys?: (ctx: NewSessionRelevantInstallableDepsContext) => readonly string[];
    }>;
    externalSessions?: Readonly<{
        browse?: Readonly<{
            order?: number;
            getSourceOptions?: (ctx: {
                agentId: ExternalSessionsAgentId;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => readonly ExternalSessionBrowseSourceOption[];
            resolveLockedSourceOption?: (ctx: {
                agentId: ExternalSessionsAgentId;
                sourceOptions: readonly ExternalSessionBrowseSourceOption[];
                agentOptionState?: Record<string, unknown> | null;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => ExternalSessionBrowseSourceOption | null;
            buildLinkEnsureRequestExtras?: (ctx: {
                agentId: ExternalSessionsAgentId;
                source: ExternalSessionsSource;
                candidate: Readonly<{ details?: Record<string, unknown> }>;
            }) => ExternalSessionBrowseLinkEnsureRequestExtras;
            resolveCompatibleLinkSource?: (ctx: {
                agentId: ExternalSessionsAgentId;
                selectedSource: ExternalSessionsSource;
                candidateSource: ExternalSessionsSource;
            }) => ExternalSessionsSource | null;
        }>;
    }>;
    sessionHandoff?: Readonly<{
        buildProviderPatch?: (ctx: {
            agentId: AgentId;
            metadata: Record<string, unknown>;
            sourceMetadataForHandoff?: Record<string, unknown>;
            targetRemoteSessionId: string;
            targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
            targetRuntimeDescriptor?: RuntimeDescriptorV1;
        }) => AgentSessionHandoffProviderPatch;
        buildSourceRecoveryResumePatch?: (ctx: {
            agentId: AgentId;
            metadata: Record<string, unknown>;
            /**
             * The Agent's own canonical runtime handle for the session being
             * recovered. `metadata` is the strict Agent-facing handoff view,
             * whose key list is first-party only, so this is where an installed
             * Agent's declared runtime fields actually arrive.
             */
            runtimeDescriptorV1?: RuntimeDescriptorV1;
        }) => AgentSessionHandoffSourceRecoveryResumePatch;
    }>;
    payload?: Readonly<{
        buildSpawnEnvironmentVariables?: (opts: {
            agentId: AgentLookupId;
            settings: Settings;
            environmentVariables: Record<string, string> | undefined;
            newSessionOptions?: Record<string, unknown> | null;
        }) => Record<string, string> | undefined;
        buildSpawnSessionExtras?: (opts: {
            agentId: AgentLookupId;
            settings: Settings;
            experiments: AgentResumeExperiments;
            resumeSessionId: string;
            newSessionOptions?: Record<string, unknown> | null;
            sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
            updatedAt?: number;
        }) => AgentSpawnSessionExtras;
        buildResumeSessionExtras?: (opts: {
            agentId: AgentLookupId;
            experiments: AgentResumeExperiments;
            settings: Settings;
            session?: Session | null;
        }) => Record<string, unknown>;
        buildWakeResumeExtras?: (opts: {
            agentId: AgentLookupId;
            resumeCapabilityOptions: ResumeCapabilityOptions;
            session?: Session | null;
        }) => Record<string, unknown>;
        buildBackendTransportFields?: (opts: AgentBackendTransportContext) => AgentBackendTransportFields;
    }>;
    sessionSubagents?: Readonly<{
        renderLaunchCards?: (ctx: {
            sessionId: string;
            scopeId: string;
            session: Session;
            subagents: readonly SessionSubagent[];
            renderInlineSurface: (surface: AgentSessionSubagentLaunchSurface) => ReactNode;
        }) => readonly ReactNode[];
        createTeammateLauncherDetailsTab?: (ctx: {
            session: Session;
            teamId: string;
        }) => DetailsTab | null;
    }>;
}>;

export type NewSessionPreflightContext = Readonly<{
    agentId: AgentLookupId;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
    results: CapabilityResults | undefined;
}>;

export type NewSessionCliSelectabilityContext = Readonly<{
    agentId: AgentLookupId;
    settings: Settings;
    agentOptionState?: Record<string, unknown> | null;
    /** The machine whose installed Agent declaration owns this decision. */
    machineId?: string | null;
}>;

export type NewSessionRelevantInstallableDepsContext = Readonly<{
    agentId: AgentLookupId;
    settings: Settings;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
    /**
     * The machine whose installables are being resolved. Omitted by the
     * explicitly machine-blind offline floor only; supplied whenever the
     * answer is about one selected machine's Agent.
     */
    machineId?: string | null;
}>;

export type NewSessionPreflightIssue = Readonly<{
    id: string;
    titleKey: TranslationKey;
    messageKey: TranslationKey;
    confirmTextKey: TranslationKey;
    action: 'openMachine';
}>;

function mergeMessageBehavior(
    a: AgentUiBehavior['message'] | undefined,
    b: AgentUiBehavior['message'] | undefined,
): AgentUiBehavior['message'] | undefined {
    if (!a && !b) return undefined;
    if (!a?.buildOverrides || !b?.buildOverrides) {
        return { ...(a ?? {}), ...(b ?? {}) };
    }
    return {
        ...a,
        ...b,
        buildOverrides: (ctx) => {
            const first = a.buildOverrides?.(ctx) ?? ctx.metaOverrides;
            return b.buildOverrides?.({
                ...ctx,
                metaOverrides: first,
            }) ?? first;
        },
    };
}

function mergeAgentUiBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
    const message = mergeMessageBehavior(a.message, b.message);
    return {
        ...(b.agentId ? { agentId: b.agentId } : a.agentId ? { agentId: a.agentId } : {}),
        ...(a.pendingDelivery || b.pendingDelivery
            ? { pendingDelivery: { ...(a.pendingDelivery ?? {}), ...(b.pendingDelivery ?? {}) } }
            : {}),
        ...(a.attachedSessionTerminal || b.attachedSessionTerminal
            ? {
                attachedSessionTerminal: {
                    ...(a.attachedSessionTerminal ?? {}),
                    ...(b.attachedSessionTerminal ?? {}),
                },
            }
            : {}),
        ...(a.guidance || b.guidance ? { guidance: { ...(a.guidance ?? {}), ...(b.guidance ?? {}) } } : {}),
        ...(a.permissions || b.permissions
            ? {
                permissions: {
                    ...(a.permissions ?? {}),
                    ...(b.permissions ?? {}),
                    ...(a.permissions?.footer || b.permissions?.footer
                        ? { footer: { ...(a.permissions?.footer ?? {}), ...(b.permissions?.footer ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(b.askUserQuestion
            ? { askUserQuestion: b.askUserQuestion }
            : a.askUserQuestion
                ? { askUserQuestion: a.askUserQuestion }
                : {}),
        ...(a.resume || b.resume ? { resume: { ...(a.resume ?? {}), ...(b.resume ?? {}) } } : {}),
        ...(a.workState || b.workState ? { workState: { ...(a.workState ?? {}), ...(b.workState ?? {}) } } : {}),
        ...(a.sessionComposer || b.sessionComposer
            ? { sessionComposer: { ...(a.sessionComposer ?? {}), ...(b.sessionComposer ?? {}) } }
            : {}),
        ...(a.contextWindow || b.contextWindow
            ? { contextWindow: { ...(a.contextWindow ?? {}), ...(b.contextWindow ?? {}) } }
            : {}),
        ...(message ? { message } : {}),
        ...(a.newSession || b.newSession ? { newSession: { ...(a.newSession ?? {}), ...(b.newSession ?? {}) } } : {}),
        ...(a.externalSessions || b.externalSessions
            ? {
                externalSessions: {
                    ...(a.externalSessions ?? {}),
                    ...(b.externalSessions ?? {}),
                    ...(a.externalSessions?.browse || b.externalSessions?.browse
                        ? { browse: { ...(a.externalSessions?.browse ?? {}), ...(b.externalSessions?.browse ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.sessionHandoff || b.sessionHandoff
            ? { sessionHandoff: { ...(a.sessionHandoff ?? {}), ...(b.sessionHandoff ?? {}) } }
            : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
        ...(a.sessionSubagents || b.sessionSubagents
            ? { sessionSubagents: { ...(a.sessionSubagents ?? {}), ...(b.sessionSubagents ?? {}) } }
            : {}),
    };
}

function buildDefaultAgentUiBehaviorFromCore(core: Pick<AgentCoreConfig, 'permissions' | 'sessionStorage'>): AgentUiBehavior {
    const promptProtocol = core.permissions.promptProtocol;

    return {
        permissions: {
            promptProtocol,
            footer: {
                usePermissionUpdates: promptProtocol === 'claude',
                forceReadOnlyAfterStop: promptProtocol !== 'codexDecision',
                supportsExecPolicyAmendment: false,
                stopHandling: 'denyAndAbortRun',
            },
        },
        newSession: {
            supportsTranscriptStorageMode: ({ storageMode }) => core.sessionStorage[storageMode] === true,
        },
    };
}

function buildDefaultAgentUiBehavior(agentId: BundledAgentId): AgentUiBehavior {
    return buildDefaultAgentUiBehaviorFromCore(getAgentCore(agentId));
}

function resolveGeneratedAgentUiBehavior(agentId: CanonicalAgentId): AgentUiBehavior {
    const generatedDescriptor = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS[agentId]?.descriptor;
    const generatedBehavior = generatedDescriptor
        ? createAgentUiBehaviorFromDescriptor(generatedDescriptor, agentId).behavior
        : {};
    return generatedBehavior;
}

export const CANONICAL_AGENTS_UI_BEHAVIOR: Readonly<Record<CanonicalAgentId, AgentUiBehavior>> = Object.freeze(
    Object.fromEntries(
        CANONICAL_AGENT_IDS.map((id: CanonicalAgentId) => {
            const base: AgentUiBehavior = {
                agentId: id,
                ...buildDefaultAgentUiBehavior(id),
            };
            const descriptorBehavior = resolveGeneratedAgentUiBehavior(id);
            return [
                id,
                mergeAgentUiBehavior(base, descriptorBehavior),
            ] as const;
        }),
    ) as Record<CanonicalAgentId, AgentUiBehavior>,
);

export const AGENTS_UI_BEHAVIOR: Readonly<Record<CanonicalAgentId, AgentUiBehavior>> = Object.freeze({
    ...CANONICAL_AGENTS_UI_BEHAVIOR,
});

const UNKNOWN_AGENT_UI_BEHAVIOR: AgentUiBehavior = Object.freeze({
    permissions: {
        footer: {
            usePermissionUpdates: false,
            forceReadOnlyAfterStop: true,
            supportsExecPolicyAmendment: false,
            stopHandling: 'denyAndAbortRun' as const,
        },
    },
    newSession: {
        supportsTranscriptStorageMode: () => false,
    },
});

export type BundledAgentUiBehaviorProjection = Readonly<{
    descriptor: BundledAgentUiBehaviorDescriptor;
    behavior: AgentUiBehavior;
}>;

/**
 * Resolves behavior only for an explicitly declared bundled backing Agent.
 * Callers retain their own Agent identity: this is presentation projection,
 * never an alias for session/runtime/handoff ownership.
 */
export function resolveBundledAgentUiBehaviorProjection(
    agentId: string | null | undefined,
): BundledAgentUiBehaviorProjection | null {
    if (!isBundledAgentId(agentId)) return null;
    const descriptor = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS[agentId];
    if (!descriptor) return null;
    return {
        descriptor,
        behavior: CANONICAL_AGENTS_UI_BEHAVIOR[agentId],
    };
}

function resolveKnownAgentUiBehavior(agentId: string | null | undefined): AgentUiBehavior | null {
    if (isBundledAgentId(agentId)) {
        return CANONICAL_AGENTS_UI_BEHAVIOR[agentId];
    }
    return null;
}

/**
 * The neutral fallback is the floor an installed Agent's own descriptor
 * builds on, so a declared field wins and an undeclared one keeps the safe
 * default. Interpreted entries are stable while published, so the merged
 * result is retained per entry rather than rebuilt on every read.
 */
const PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY = new WeakMap<ProjectedAgentUiBehaviorEntry, AgentUiBehavior>();
const BUNDLED_PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY = new WeakMap<ProjectedAgentUiBehaviorEntry, AgentUiBehavior>();

function resolveProjectedAgentUiBehavior(
    agentId: string | null | undefined,
    machineId: string | null | undefined,
): AgentUiBehavior | null {
    const entry = resolveProjectedAgentUiBehaviorEntry(agentId, machineId);
    if (!entry) return null;
    const retained = PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY.get(entry);
    if (retained) return retained;
    const merged = Object.freeze(mergeAgentUiBehavior(UNKNOWN_AGENT_UI_BEHAVIOR, entry.behavior));
    PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY.set(entry, merged);
    return merged;
}

/**
 * `machineId` narrows the projected half to the machine that owns the render.
 * A bundled Agent's behavior ships in this binary and is identical everywhere,
 * so it ignores the machine; an installed Agent's descriptor is a per-machine
 * fact and two machines can hold different versions of it. Callers that know
 * the owning machine — every Session-scoped read — pass it so a Session on one
 * machine can never render with another machine's declaration.
 */
export function resolveAgentUiBehavior(
    agentId: string | null | undefined,
    machineId?: string | null,
): AgentUiBehavior {
    const behavior = resolveKnownAgentUiBehavior(agentId);
    if (behavior) {
        // A bundled Agent dogfoods the same machine-/Account-qualified public
        // descriptor seam as an installed Agent. The build-time declaration is
        // the offline floor; an exact current machine projection can refresh
        // localized/public declaration facts without granting a private UI
        // callback or falling back to another machine.
        const entry = machineId
            ? resolveProjectedAgentUiBehaviorEntry(agentId, machineId)
            : null;
        if (entry) {
            const retained = BUNDLED_PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY.get(entry);
            if (retained) return retained;
            const merged = Object.freeze(mergeAgentUiBehavior(behavior, entry.behavior));
            BUNDLED_PROJECTED_AGENT_UI_BEHAVIOR_BY_ENTRY.set(entry, merged);
            return merged;
        }
        return behavior;
    }
    // An Agent that ships a descriptor is projected from it; the neutral
    // fallback is reserved for one that ships none.
    return resolveProjectedAgentUiBehavior(agentId, machineId) ?? UNKNOWN_AGENT_UI_BEHAVIOR;
}

export function resolveConfiguredAgentRuntimeKindFromUiBehavior(params: Readonly<{
    agentId: string;
    settings: Settings;
    machineId?: string | null;
}>): string | null {
    return resolveAgentUiBehavior(params.agentId, params.machineId)
        .newSession
        ?.resolveConfiguredRuntimeKind?.({
            agentId: params.agentId,
            settings: params.settings,
        }) ?? null;
}

export function resolveAgentUiBehaviorFromFlavor(flavor: unknown): AgentUiBehavior | null {
    const agentId = typeof flavor === 'string' ? resolveAgentIdFromFlavor(flavor) : null;
    return agentId ? resolveAgentUiBehavior(agentId) : null;
}

export function resolveAgentUiBehaviorFromSessionMetadata(metadata: unknown): AgentUiBehavior | null {
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    // The Session's own metadata already carries the machine that runs it, so
    // the machine-scoped read costs no call-site change anywhere.
    return agentId ? resolveAgentUiBehavior(agentId, resolveSessionMachineId(metadata)) : null;
}

/**
 * The runner's own report that it now holds a queued prompt. Any Agent can
 * publish it through the public SDK runtime context
 * (`pendingInputInterruptAndRunLocalId`), so reading it is host work; the Agent
 * only declares the label and whether interrupt-and-run is honoured.
 */
function readCustodyObservedLocalId(session: Session): string | null {
    const value = session.agentState?.capabilities?.pendingInputInterruptAndRunLocalId;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The machine that owns a Session's render, read through the canonical owner
 * metadata view. Every Session-scoped behavior read passes it so a decision
 * about the Agent running on this machine can never be answered with another
 * machine's declaration.
 *
 * It accepts a session-like value because the outbound message path carries the
 * Session untyped; the narrowing is the same one the descriptor interpreter
 * already uses, so there is one owner-metadata reader rather than two.
 */
export function resolveOwningMachineIdForSession(session: unknown): string | null {
    return resolveSessionMachineId(readOwnerMetadataFromSessionLike(session));
}

function resolveSessionAgentUiBehavior(session: Session): AgentUiBehavior | null {
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    if (!agentId) return null;
    return resolveAgentUiBehavior(agentId, resolveSessionMachineId(ownerMetadata));
}

export function resolvePendingDeliveryLabelKeyForSession(ctx: Readonly<{
    session: Session;
    localId: string | null;
    detail: PendingDeliveryDetailV1 | undefined;
}>): TranslationKey | null {
    const custodyLabelKey = resolveSessionAgentUiBehavior(ctx.session)?.pendingDelivery?.custodyLabelKey;
    if (!custodyLabelKey) return null;
    if (ctx.detail === 'custody_observed') return custodyLabelKey;
    const custodyObservedLocalId = readCustodyObservedLocalId(ctx.session);
    return ctx.localId !== null
        && ctx.localId.length > 0
        && ctx.localId === custodyObservedLocalId
        ? custodyLabelKey
        : null;
}

export function resolvePendingDeliveryTransientActionForSession(ctx: Readonly<{
    session: Session;
    localId: string;
    wireMode: PendingInputServerWireMode;
}>): PendingDeliveryTransientAction | null {
    if (ctx.wireMode !== 'pending_input_v1') return null;
    if (resolveSessionAgentUiBehavior(ctx.session)?.pendingDelivery?.interruptAndRun !== true) return null;
    if (readCustodyObservedLocalId(ctx.session) !== ctx.localId) return null;
    const stateAt = ctx.session.agentState?.capabilities?.pendingInputInterruptAndRunStateAt;
    return {
        id: 'interrupt_and_run',
        localId: ctx.localId,
        ...(typeof stateAt === 'number' ? { stateAtMs: stateAt } : {}),
    };
}

/**
 * Whether the attached-terminal viewer can drive this session right now.
 *
 * Every fact in the decision is host-owned: the session is live, the daemon
 * published a servable, unretired control attachment for it, and the terminal
 * host is a controllable one rather than `plain`. The Agent contributes only
 * the opt-in, so an installed Agent that declares support is answered by the
 * same predicate as a bundled one.
 */
export function isAttachedSessionTerminalAvailableForSession(session: Session): boolean {
    if (session.active !== true) return false;
    if (resolveSessionAgentUiBehavior(session)?.attachedSessionTerminal?.supported !== true) return false;
    const terminal = readSessionOwnerMetadataView(session)?.terminal;
    if (!terminal || terminal.mode === undefined || terminal.mode === 'plain') return false;
    const serviceability = terminal.controlServiceabilityV1;
    if (serviceability?.v !== 1) return false;
    if (serviceability.state !== 'servable' || serviceability.retired === true) return false;
    return typeof serviceability.attachmentId === 'string' && serviceability.attachmentId.trim().length > 0;
}

export function classifyAgentSessionComposerNonSteerablePayload(opts: {
    session: Session | null;
    agentTargetKey?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
}): AgentSessionComposerNonSteerableReason | null {
    const agentId = resolveAgentIdFromSessionMetadata(
        opts.session ? readSessionOwnerMetadataView(opts.session) : null,
    );
    if (!opts.session || !agentId) return null;
    const ownerMetadata = readSessionOwnerMetadataView(opts.session);
    const explicitAgentTargetKey = typeof opts.agentTargetKey === 'string'
        ? opts.agentTargetKey.trim()
        : '';
    const canonicalIntent = ownerMetadata
        && typeof ownerMetadata === 'object'
        && !Array.isArray(ownerMetadata)
        ? SessionModelSelectionIntentV1Schema.safeParse(
            (ownerMetadata as Readonly<Record<string, unknown>>).modelSelectionIntentV1,
        )
        : null;
    const configuredBackend = readAcpConfiguredBackendV1FromMetadata(ownerMetadata);
    const agentTargetKey = explicitAgentTargetKey
        || (canonicalIntent?.success
            ? canonicalIntent.data.selection?.agentTargetKey ?? ''
            : '')
        || (configuredBackend
            ? buildBackendTargetKeyV2({
                kind: 'backend',
                backendId: configuredBackend.backendId,
                configuredBackendId: configuredBackend.backendId,
                sourceKind: 'configured',
            })
            : '')
        || buildAgentUniverseBackendTargetKey(agentId);

    return resolveAgentUiBehavior(agentId, resolveSessionMachineId(ownerMetadata))
        .sessionComposer?.classifyNonSteerablePayload?.({
        agentId,
        agentTargetKey,
        session: opts.session,
        metaOverrides: opts.metaOverrides ?? null,
        currentRunnerProcessIdentity: opts.currentRunnerProcessIdentity ?? null,
    }) ?? null;
}

export function getAgentResumeExperimentsFromSettings(agentId: AgentLookupId, settings: Settings): AgentResumeExperiments {
    const enabled = true;
    const defs = resolveAgentUiBehavior(agentId).resume?.experimentSwitches ?? [];
    if (defs.length === 0) return { enabled, switches: {} };
    const switches: Record<string, boolean> = {};
    for (const def of defs) {
        if (typeof def.getValue === 'function') {
            switches[def.id] = def.getValue(settings);
            continue;
        }
        const settingKey = def.settingKey as Extract<keyof Settings, string> | undefined;
        switches[def.id] = settingKey ? settings[settingKey] === true : false;
    }
    return { enabled, switches };
}

export function buildResumeCapabilityOptionsFromUiState(opts: {
    settings: Settings;
    results: CapabilityResults | undefined;
}): ResumeCapabilityOptions {
    return {
        accountSettings: opts.settings,
    };
}

export function getNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    const fn = resolveAgentUiBehavior(ctx.agentId).newSession?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function buildNewSessionOptionsFromUiState(opts: {
    agentId: AgentLookupId;
    agentOptionState?: Record<string, unknown> | null;
    /** The machine the composer is about to spawn on; see `buildSpawnSessionExtrasFromUiState`. */
    machineId?: string | null;
}): Record<string, unknown> | null {
    const fn = resolveAgentUiBehavior(opts.agentId, opts.machineId).newSession?.buildNewSessionOptions;
    return fn ? fn(opts) : null;
}

export function canSelectAgentWithoutDetectedCli(ctx: NewSessionCliSelectabilityContext): boolean {
    const fn = resolveAgentUiBehavior(ctx.agentId, ctx.machineId).newSession?.canSelectWithoutDetectedCli;
    return fn ? fn(ctx) : false;
}

export function getNewSessionAgentInputExtraActionChips(opts: {
    agentId: AgentLookupId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, value: unknown) => void;
    /** The machine the composer is about to spawn on; see `buildSpawnSessionExtrasFromUiState`. */
    machineId?: string | null;
}): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const fn = resolveAgentUiBehavior(opts.agentId, opts.machineId).newSession?.getAgentInputExtraActionChips;
    return fn ? fn(opts) : undefined;
}

export function getNewSessionRelevantInstallableDepKeys(
    ctx: NewSessionRelevantInstallableDepsContext,
): readonly string[] {
    const fn = resolveAgentUiBehavior(ctx.agentId, ctx.machineId).newSession?.getRelevantInstallableDepKeys;
    return fn ? fn(ctx) : [];
}

export function buildSpawnSessionExtrasFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    resumeSessionId: string;
    /**
     * The machine the composer is about to spawn on. An installed Agent's
     * descriptor is a per-machine fact, so the spawn envelope is built from the
     * declaration held by the machine that will run the Session.
     */
    machineId?: string | null;
    newSessionOptions?: Record<string, unknown> | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    updatedAt?: number;
}): AgentSpawnSessionExtras {
    const fn = resolveAgentUiBehavior(opts.agentId, opts.machineId).payload?.buildSpawnSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({
        agentId: opts.agentId,
        settings: opts.settings,
        experiments,
        resumeSessionId: opts.resumeSessionId,
        newSessionOptions: opts.newSessionOptions ?? null,
        sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides ?? null,
        ...(opts.updatedAt === undefined ? {} : { updatedAt: opts.updatedAt }),
    });
}

export function buildSpawnEnvironmentVariablesFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    environmentVariables: Record<string, string> | undefined;
    /** The machine the composer is about to spawn on; see `buildSpawnSessionExtrasFromUiState`. */
    machineId?: string | null;
    newSessionOptions?: Record<string, unknown> | null;
}): Record<string, string> | undefined {
    const fn = resolveAgentUiBehavior(opts.agentId, opts.machineId).payload?.buildSpawnEnvironmentVariables;
    return fn ? fn(opts) : opts.environmentVariables;
}

export function buildResumeSessionExtrasFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = resolveAgentUiBehavior(
        opts.agentId,
        resolveOwningMachineIdForSession(opts.session),
    ).payload?.buildResumeSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, experiments, settings: opts.settings, session: opts.session });
}

export function buildWakeResumeExtras(opts: {
    agentId: AgentLookupId;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = resolveAgentUiBehavior(
        opts.agentId,
        resolveOwningMachineIdForSession(opts.session),
    )?.payload?.buildWakeResumeExtras;
    return fn ? fn(opts) : {};
}

function readCanonicalBackendTarget(input: BackendTargetRefV2Input | undefined): BackendTargetRefV2 | null {
    if (!input) return null;
    try {
        return readBackendTargetRefV2(input);
    } catch {
        return null;
    }
}

function resolveAgentIdFromBackendTarget(input: BackendTargetRefV2Input | undefined): AgentId | null {
    const target = readCanonicalBackendTarget(input);
    if (!target || target.kind !== 'backend' || target.sourceKind === 'configured') return null;
    // An Agent-sourced backend target carries the Agent's own id, which may be an
    // externally installed contribution. `resolveAgentUiBehavior` already answers
    // with the neutral behavior when no bundled behavior is contributed, so there
    // is nothing left for a bundled-id filter to decide here.
    return target.backendId;
}

export function buildBackendTransportFieldsFromUiState(opts: Readonly<{
    /** Exact daemon target that will consume the transport fields. */
    machineId: string | null;
    backendTarget?: BackendTargetRefV2Input;
    providerMode?: unknown;
    legacyExperimentalMode?: boolean;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    providerSessionId?: string;
}>): AgentBackendTransportFields {
    const backendTarget = readCanonicalBackendTarget(opts.backendTarget);
    const agentId = resolveAgentIdFromBackendTarget(opts.backendTarget);
    if (!backendTarget || !agentId) return {};

    const fn = resolveAgentUiBehavior(agentId, opts.machineId).payload?.buildBackendTransportFields;
    return fn
        ? fn({
            agentId,
            backendTarget,
            providerMode: opts.providerMode,
            legacyExperimentalMode: opts.legacyExperimentalMode,
            runtimeDescriptorV1: opts.runtimeDescriptorV1,
            providerSessionId: opts.providerSessionId,
        })
        : {};
}

/**
 * The Agent's own source-recovery patch for a handoff that is being rolled back
 * onto the machine it came from.
 *
 * `machineId` is passed explicitly because the Agent-facing handoff metadata
 * view deliberately drops host-owned facts such as `machineId`; deriving the
 * machine from that view answered `null` for every real caller and silently
 * degraded the read to the machine-blind floor.
 */
export function buildSessionHandoffSourceRecoveryResumePatch(opts: {
    agentId: AgentId;
    machineId: string | null;
    metadata: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
}): AgentSessionHandoffSourceRecoveryResumePatch {
    const fn = resolveAgentUiBehavior(
        opts.agentId,
        opts.machineId,
    ).sessionHandoff?.buildSourceRecoveryResumePatch;
    return fn ? fn(opts) : {};
}

export function supportsEditableSessionGoals(ctx: {
    agentId: AgentLookupId;
    session: Session;
    daemonGoalControlsSupported?: boolean;
}): boolean {
    const profile = resolveSessionGoalActionCapabilityProfile(ctx);
    return profile !== null && (
        profile.canEdit
        || profile.canStop
        || profile.canClear
        || profile.canConfigureBudget
    );
}

/**
 * Effective goal-action profile for a session. Provider semantics are intersected with the active
 * runner or target daemon's callable controls here so every goal surface consumes one decision.
 * Returns null only when the provider does not semantically support editable goals.
 */
export function resolveSessionGoalActionCapabilityProfile(ctx: {
    agentId: AgentLookupId;
    session: Session;
    daemonGoalControlsSupported?: boolean;
}): GoalActionCapabilities | null {
    const workState = resolveAgentUiBehavior(
        ctx.agentId,
        resolveOwningMachineIdForSession(ctx.session),
    ).workState;
    if (!workState?.supportsEditableGoals?.(ctx)) return null;

    const semanticProfile = workState.resolveGoalActionCapabilityProfile?.(ctx) ?? {
        canEdit: true,
        canStop: true,
        canClear: true,
        canConfigureBudget: true,
    };
    const execution = resolveSessionGoalExecutionCapabilities({
        session: ctx.session,
        machine: {
            metadata: {
                daemonSessionGoalControlsSupported: ctx.daemonGoalControlsSupported,
            },
        },
    });
    return {
        canEdit: semanticProfile.canEdit && execution.canSet,
        canStop: semanticProfile.canStop && execution.canSet,
        canClear: semanticProfile.canClear && execution.canClear,
        canConfigureBudget: semanticProfile.canConfigureBudget && execution.canSet,
    };
}
