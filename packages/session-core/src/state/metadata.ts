import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { z } from "zod/mini";
import * as zMini from 'zod/mini';
import { applyRuntimeDescriptorSessionMetadata, normalizeLegacyAgentVocabularySessionMetadata } from "@happier-dev/agents/session/state/metadataWriters";
import { AgentModelOptionOverrideRuleReadSchema } from '@happier-dev/protocol/models/descriptor';
import { SessionOwnerModeCatalogV2Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionWorkspaceLocationV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { SessionForkFilesNotCopiedV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionForkVisualCopyV1Schema, SessionForkVisualsV1Schema } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { createAgentRuntimeFacetsV1Schema } from '@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1';
import { createAcpConfigOptionOverridesV1Schema, createAcpSessionModeOverrideV1Schema, createModelOverrideV1Schema, normalizeCodexBackendMode } from '@happier-dev/protocol/sessions/metadata/overrides';
import { createSessionPermissionModeSchema } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { createSessionRollbackRangesV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionRollbackRangesV1';
import { createSessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { createSessionSystemSessionV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readRuntimeDescriptorV1, RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { SessionAppliedModelV1Schema, SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionActiveModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { SessionMcpSelectionV1Schema, SessionMcpSelectionRestartRequiredV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { DiscussionSelectionSourceV1Schema } from '@happier-dev/protocol/discussions/references';
import { SessionDirectoryV1ReadSchema } from '@happier-dev/protocol/sessions/metadata/directory';

/**
 * Persisted session option catalogs. The model and config catalogs are published under four
 * metadata keys (`acpSessionModelsV1`, `sessionModelsV1`, `acpConfigOptionsV1`,
 * `sessionConfigOptionsV1`); they share these schemas so a producer-declared field cannot
 * survive one carrier and be silently stripped by another. `MetadataSchema`'s top-level
 * `.passthrough()` does NOT reach nested objects, so every carried field must be declared here.
 */
const StoredOptionChoiceSchema = lazyZodSchema(() => z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    name: z.string(),
    description: z.optional(z.string()),
}));

const StoredModelOptionSchema = lazyZodSchema(() => z.object({
    id: z.string(),
    name: z.string(),
    description: z.optional(z.string()),
    category: z.optional(z.string()),
    type: z.string(),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.optional(z.array(StoredOptionChoiceSchema)),
    groups: z.optional(z.array(z.object({
        id: z.string(),
        name: z.string(),
        options: z.array(StoredOptionChoiceSchema),
    }))),
    overridesWhenOn: z.optional(AgentModelOptionOverrideRuleReadSchema),
}));

const StoredConfigOptionSchema = StoredModelOptionSchema;

// This retained carrier also custodians native descriptor/facet/override bags.
// Project its closed typed leaves, not the entire passthrough metadata tree.
const MetadataObjectSchema = lazyZodSchema(() => z.looseObject({
    // Cloud/system sessions may omit these fields; treat missing/null as empty.
    path: z.pipe(z.nullish(z.string()), z.transform((value) => (typeof value === 'string' ? value : ''))),
    host: z.pipe(z.nullish(z.string()), z.transform((value) => (typeof value === 'string' ? value : ''))),
    version: z.optional(z.string()),
    name: z.optional(z.string()),
    os: z.optional(z.string()),
    profileId: z.optional(z.nullable(z.string())), // Session-scoped profile identity (non-secret)
    approvalReviewerEnabled: z.optional(z.boolean()),
    summary: z.optional(z.object({
        text: z.string(),
        updatedAt: z.number()
    })),
    machineId: z.optional(z.string()),
    placementOrigin: z.optional(createStoredReadSchema(MachinePoolSelectionOriginV1Schema)),
    sessionWorkspaceLocationV1: z.optional(SessionWorkspaceLocationV1Schema),
    sessionDirectoryV1: z.catch(z.optional(SessionDirectoryV1ReadSchema), undefined),
    handoffV1: z.optional(z.object({
        v: z.literal(1),
        sourceMachineId: z.string(),
        targetMachineId: z.string(),
        agentId: z.string(),
        sessionStorageBefore: z.enum(['direct', 'persisted']),
        sessionStorageAfter: z.enum(['direct', 'persisted']),
        transportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
        completedAtMs: z.number(),
        sourceWorkspaceRootPath: z.optional(z.string()),
        targetWorkspaceRootPath: z.optional(z.string()),
    })),
    claudeSessionId: z.optional(z.string()), // Claude Code session ID
    codexSessionId: z.optional(z.string()), // Codex session/conversation ID (uuid)
    runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
    agentRuntimeCapabilitiesV1: z.optional(z.unknown()),
    agentRuntimeFacetsV1: z.optional(createAgentRuntimeFacetsV1Schema(zMini)),
    geminiSessionId: z.optional(z.string()), // Gemini ACP session ID (opaque)
    grokSessionId: z.optional(z.string()), // Grok ACP session ID (opaque)
    opencodeSessionId: z.optional(z.string()), // OpenCode ACP session ID (opaque)
    opencodeBackendMode: z.optional(z.enum(['server', 'acp'])),
    opencodeServerBaseUrl: z.optional(z.string()),
    opencodeServerBaseUrlExplicit: z.optional(z.literal(true)),
    auggieSessionId: z.optional(z.string()), // Auggie ACP session ID (opaque)
    qwenSessionId: z.optional(z.string()), // Qwen Code ACP session ID (opaque)
    kimiSessionId: z.optional(z.string()), // Kimi ACP session ID (opaque)
    kiloSessionId: z.optional(z.string()), // Kilo ACP session ID (opaque)
    piSessionId: z.optional(z.string()), // Pi RPC session ID (opaque)
    antigravitySessionId: z.optional(z.string()), // Antigravity CLI conversation ID (opaque)
    copilotSessionId: z.optional(z.string()), // Copilot ACP session ID (opaque)
    auggieAllowIndexing: z.optional(z.boolean()), // Auggie indexing enablement (spawn-time)
    tools: z.optional(z.array(z.string())),
    slashCommands: z.optional(z.array(z.string())),
    slashCommandDetails: z.optional(z.array(z.object({
        command: z.string(),
        description: z.optional(z.string()),
    }))),
    acpHistoryImportV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        remoteSessionId: z.string(),
        importedAt: z.number(),
        lastImportedFingerprint: z.optional(z.string()),
    })),
    acpSessionModesV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModeId: z.string(),
        availableModes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.optional(z.string()),
        })),
    })),
    sessionModesV2: z.optional(createStoredReadSchema(SessionOwnerModeCatalogV2Schema)),
    sessionModesV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModeId: z.string(),
        availableModes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.optional(z.string()),
        })),
    })),
    /**
     * ACP session models (if supported by the provider's ACP agent).
     *
     * NOTE: This is an UNSTABLE ACP feature and may be unsupported by some agents.
     */
    acpSessionModelsV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModelId: z.string(),
        availableModels: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.optional(z.string()),
            contextWindowTokens: z.optional(z.number().check(z.int(), z.nonnegative())),
            extendedContextModelId: z.optional(z.string()),
            modelOptions: z.optional(z.array(StoredModelOptionSchema)),
        })),
    })),
    sessionModelsV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModelId: z.string(),
        activeSelectionV1: z.optional(createStoredReadSchema(SessionActiveModelSelectionSchema)),
        availableModels: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.optional(z.string()),
            contextWindowTokens: z.optional(z.number().check(z.int(), z.nonnegative())),
            extendedContextModelId: z.optional(z.string()),
            modelOptions: z.optional(z.array(StoredModelOptionSchema)),
        })),
    })),
    /**
     * ACP session configuration options (if supported by the provider's ACP agent).
     */
    acpConfigOptionsV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        configOptions: z.array(StoredConfigOptionSchema),
        modelConfigOptionId: z.optional(z.string()),
    })),
    sessionConfigOptionsV1: z.optional(z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        configOptions: z.array(StoredConfigOptionSchema),
        modelConfigOptionId: z.optional(z.string()),
    })),
    sessionRollbackRangesV1: z.optional(createSessionRollbackRangesV1Schema(zMini)),
    /**
     * Desired ACP session mode override selected by the user (UI/CLI).
     *
     * This is distinct from `acpSessionModesV1`:
     * - `acpSessionModesV1` mirrors the agent-reported current state.
     * - `acpSessionModeOverrideV1` is the user's requested mode, applied by the runner when possible.
     */
    acpSessionModeOverrideV1: z.optional(createAcpSessionModeOverrideV1Schema(zMini)),
    sessionModeOverrideV1: z.optional(createAcpSessionModeOverrideV1Schema(zMini)),
    /**
     * Desired ACP config option overrides selected by the user (UI/CLI).
     */
    acpConfigOptionOverridesV1: z.optional(createAcpConfigOptionOverridesV1Schema(zMini)),
    sessionConfigOptionOverridesV1: z.optional(createAcpConfigOptionOverridesV1Schema(zMini)),
    acpConfiguredBackendV1: z.optional(z.looseObject({
        v: z.literal(1),
        updatedAt: z.number(),
        backendId: z.string(),
        title: z.string(),
    })),
    homeDir: z.optional(z.string()), // User's home directory on the machine
    happyHomeDir: z.optional(z.string()), // Happy configuration directory 
    hostPid: z.optional(z.number()), // Process ID of the session
    sessionLogPath: z.optional(z.string()), // Session-specific CLI log file path
    terminal: z.optional(createSessionTerminalMetadataSchema(zMini)),
    flavor: z.nullish(z.string()), // Session flavor/variant identifier
    // Published by happy-cli so the app can seed permission state even before there are messages.
    permissionMode: z.optional(createSessionPermissionModeSchema(zMini)),
    permissionModeUpdatedAt: z.optional(z.number()),
    /**
     * Session-level model override selected by the user (UI/CLI).
     *
     * This mirrors the permission/mode override pattern:
     * - Stored in session metadata for cross-device consistency
     * - Applied to outgoing user messages through the structured selection envelope,
     *   with `message.meta.model` retained only for providerless legacy readers
     */
    modelOverrideV1: z.optional(createModelOverrideV1Schema(zMini)),
    modelSelectionIntentV1: z.optional(createStoredReadSchema(SessionModelSelectionIntentV1Schema)),
    /** Per-session overlay for the account-owned managed MCP catalog. */
    mcpSelectionV1: z.optional(SessionMcpSelectionV1Schema),
    /** Applied baseline retained only while an active runner needs a restart. */
    mcpSelectionRestartRequiredV1: z.optional(SessionMcpSelectionRestartRequiredV1Schema),
    sessionAppliedModelV1: z.optional(createStoredReadSchema(SessionAppliedModelV1Schema)),
    /**
     * Local-only markers for committed transcript messages that should be treated as discarded
     * (e.g. when the user switches to terminal control and abandons unprocessed remote messages).
     */
    externalSessionAttentionV1: z.optional(z.looseObject({
        v: z.literal(1),
        observedProgressToken: z.optional(z.string()),
        viewedProgressToken: z.optional(z.string()),
        observedAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
        viewedAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    })),
    discardedCommittedMessageLocalIds: z.optional(z.array(z.string())),
    readStateV1: z.optional(z.object({
        v: z.literal(1),
        sessionSeq: z.number(),
        pendingActivityAt: z.number(),
        updatedAt: z.number(),
    })),
    /**
     * System/hidden sessions created for internal control planes (voice, execution carrier, etc).
     * These should be excluded from user-facing lists by default.
     */
    systemSessionV1: z.optional(createSessionSystemSessionV1Schema(zMini)),
    /**
     * Fork lineage for a child session.
     *
     * Used to render a virtual ancestor transcript (read-only) without duplicating messages.
     */
    forkV1: z.optional(z.object({
        v: z.literal(1),
        parentSessionId: z.string(),
        parentCutoffSeqInclusive: z.number(),
        createdAtMs: z.number(),
        strategy: z.string(),
        requestId: z.optional(z.nullable(z.string())),
        filesNotCopied: z.optional(createStoredReadSchema(SessionForkFilesNotCopiedV1Schema)),
        visualCopies: z.optional(z.array(createStoredReadSchema(SessionForkVisualCopyV1Schema))),
        agentHint: z.optional(z.object({
            agentId: z.optional(z.string()),
            backendMode: z.optional(z.string()),
            agentSessionId: z.optional(z.nullable(z.string())),
        })),
    })),
    forkVisualsV1: z.optional(createStoredReadSchema(SessionForkVisualsV1Schema)),
    /**
     * Hidden replay seed applied exactly once to the first real user prompt.
     */
    replaySeedV1: z.optional(z.object({
        v: z.literal(1),
        seedText: z.string(),
        sourceSessionId: z.string(),
        sourceCutoffSeqInclusive: z.number(),
        createdAtMs: z.number(),
        appliedToLocalId: z.optional(z.string()),
        appliedAtMs: z.optional(z.number()),
        /** Pending row the seed was composed into; the daemon owns and reconciles it. */
        dispatchedToLocalId: z.optional(z.string()),
    })),
    forkInitialPromptV1: z.optional(z.object({
        v: z.literal(1),
        text: z.string(),
        createdAtMs: z.number(),
        sourceMessageId: z.optional(z.string()),
        appliedAtMs: z.optional(z.number()),
    })),
    sessionInitialPromptV1: z.catch(z.optional(z.object({
        v: z.literal(1),
        text: z.string(),
        mode: z.enum(['replace', 'append']),
        createdAtMs: z.number(),
        sourceMessageIds: z.optional(z.array(z.string())),
        sourceSessionId: z.optional(z.string()),
        source: z.optional(createStoredReadSchema(zMini.omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true }))),
    })), undefined),
}));

export const MetadataSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    const parsedValue = (() => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed) return value;
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    })();
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
        return parsedValue;
    }
    const legacyVocabularyMetadata = normalizeLegacyAgentVocabularySessionMetadata(
        parsedValue as Record<string, unknown>,
    );
    const {
        codexBackendMode: releasedCodexBackendModeInput,
        ...metadata
    } = legacyVocabularyMetadata;
    const releasedCodexBackendMode = Object.hasOwn(legacyVocabularyMetadata, 'codexBackendMode')
        ? normalizeCodexBackendMode(releasedCodexBackendModeInput)
        : null;
    if (Object.hasOwn(legacyVocabularyMetadata, 'codexBackendMode') && !releasedCodexBackendMode) {
        return { ...metadata, runtimeDescriptorV1: null };
    }
    const explicitRuntimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
    if (
        releasedCodexBackendMode
        && explicitRuntimeDescriptorV1
        && (
            explicitRuntimeDescriptorV1.agentId !== 'codex'
            || normalizeCodexBackendMode(explicitRuntimeDescriptorV1.agent.backendMode)
                !== releasedCodexBackendMode
        )
    ) {
        return { ...metadata, runtimeDescriptorV1: null };
    }
    const runtimeDescriptorV1 = explicitRuntimeDescriptorV1 ?? (releasedCodexBackendMode
        ? readRuntimeDescriptorV1({
            v: 1,
            agentId: 'codex',
            agent: {
                backendMode: releasedCodexBackendMode,
                ...(readNonBlankOpaqueIdentifier(metadata.codexSessionId)
                    ? { providerSessionId: metadata.codexSessionId as string }
                    : {}),
            },
        })
        : null);
    if (runtimeDescriptorV1 === null && Object.prototype.hasOwnProperty.call(metadata, 'runtimeDescriptorV1')) {
        const { agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1, ...rest } = metadata;
        return rest;
    }
    return applyRuntimeDescriptorSessionMetadata(metadata, runtimeDescriptorV1);
}), MetadataObjectSchema));

export type Metadata = z.infer<typeof MetadataSchema>;
