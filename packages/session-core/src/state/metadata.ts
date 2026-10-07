import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from "zod";
import { applyRuntimeDescriptorSessionMetadata, normalizeLegacyAgentVocabularySessionMetadata } from "@happier-dev/agents/session/state/metadataWriters";
import { AgentModelOptionOverrideRuleReadSchema } from '@happier-dev/protocol/models/descriptor';
import { SessionOwnerModeCatalogV2Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionWorkspaceLocationV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { SessionForkFilesNotCopiedV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createAgentRuntimeFacetsV1Schema } from '@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1';
import { createAcpConfigOptionOverridesV1Schema, createAcpSessionModeOverrideV1Schema, createModelOverrideV1Schema, normalizeCodexBackendMode } from '@happier-dev/protocol/sessions/metadata/overrides';
import { createSessionPermissionModeSchema } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { createSessionRollbackRangesV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionRollbackRangesV1';
import { createSessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { createSessionSystemSessionV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readRuntimeDescriptorV1, RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { SessionActiveModelSelectionV1Schema, SessionAppliedModelV1Schema, SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionMcpSelectionV1Schema, SessionMcpSelectionRestartRequiredV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { SessionDiscussionSelectionSourceV1Schema } from '@happier-dev/protocol/sessions/discussions/content';
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
    description: z.string().optional(),
}));

const StoredModelOptionSchema = lazyZodSchema(() => z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    type: z.string(),
    currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    options: z.array(StoredOptionChoiceSchema).optional(),
    overridesWhenOn: AgentModelOptionOverrideRuleReadSchema.optional(),
}));

const StoredConfigOptionSchema = lazyZodSchema(() => StoredModelOptionSchema.extend({
    groups: z.array(z.object({
        id: z.string(),
        name: z.string(),
        options: z.array(StoredOptionChoiceSchema),
    })).optional(),
}));

const MetadataObjectSchema = lazyZodSchema(() => z.object({
    // Cloud/system sessions may omit these fields; treat missing/null as empty.
    path: z.string().nullish().transform((value) => (typeof value === 'string' ? value : '')),
    host: z.string().nullish().transform((value) => (typeof value === 'string' ? value : '')),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    profileId: z.string().nullable().optional(), // Session-scoped profile identity (non-secret)
    approvalReviewerEnabled: z.boolean().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    placementOrigin: MachinePoolSelectionOriginV1Schema.optional(),
    sessionWorkspaceLocationV1: SessionWorkspaceLocationV1Schema.optional(),
    sessionDirectoryV1: SessionDirectoryV1ReadSchema.optional().catch(undefined),
    handoffV1: z.object({
        v: z.literal(1),
        sourceMachineId: z.string(),
        targetMachineId: z.string(),
        agentId: z.string(),
        sessionStorageBefore: z.enum(['direct', 'persisted']),
        sessionStorageAfter: z.enum(['direct', 'persisted']),
        transportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
        completedAtMs: z.number(),
        sourceWorkspaceRootPath: z.string().optional(),
        targetWorkspaceRootPath: z.string().optional(),
    }).optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexSessionId: z.string().optional(), // Codex session/conversation ID (uuid)
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    agentRuntimeCapabilitiesV1: z.unknown().optional(),
    agentRuntimeFacetsV1: createAgentRuntimeFacetsV1Schema(z).optional(),
    geminiSessionId: z.string().optional(), // Gemini ACP session ID (opaque)
    grokSessionId: z.string().optional(), // Grok ACP session ID (opaque)
    opencodeSessionId: z.string().optional(), // OpenCode ACP session ID (opaque)
    opencodeBackendMode: z.enum(['server', 'acp']).optional(),
    opencodeServerBaseUrl: z.string().optional(),
    opencodeServerBaseUrlExplicit: z.literal(true).optional(),
    auggieSessionId: z.string().optional(), // Auggie ACP session ID (opaque)
    qwenSessionId: z.string().optional(), // Qwen Code ACP session ID (opaque)
    kimiSessionId: z.string().optional(), // Kimi ACP session ID (opaque)
    kiloSessionId: z.string().optional(), // Kilo ACP session ID (opaque)
    piSessionId: z.string().optional(), // Pi RPC session ID (opaque)
    antigravitySessionId: z.string().optional(), // Antigravity CLI conversation ID (opaque)
    copilotSessionId: z.string().optional(), // Copilot ACP session ID (opaque)
    auggieAllowIndexing: z.boolean().optional(), // Auggie indexing enablement (spawn-time)
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    slashCommandDetails: z.array(z.object({
        command: z.string(),
        description: z.string().optional(),
    })).optional(),
    acpHistoryImportV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        remoteSessionId: z.string(),
        importedAt: z.number(),
        lastImportedFingerprint: z.string().optional(),
    }).optional(),
    acpSessionModesV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModeId: z.string(),
        availableModes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
        })),
    }).optional(),
    sessionModesV2: SessionOwnerModeCatalogV2Schema.optional(),
    sessionModesV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModeId: z.string(),
        availableModes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
        })),
    }).optional(),
    /**
     * ACP session models (if supported by the provider's ACP agent).
     *
     * NOTE: This is an UNSTABLE ACP feature and may be unsupported by some agents.
     */
    acpSessionModelsV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModelId: z.string(),
        availableModels: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            contextWindowTokens: z.number().int().nonnegative().optional(),
            extendedContextModelId: z.string().optional(),
            modelOptions: z.array(StoredModelOptionSchema).optional(),
        })),
    }).optional(),
    sessionModelsV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        currentModelId: z.string(),
        activeSelectionV1: SessionActiveModelSelectionV1Schema.optional(),
        availableModels: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            contextWindowTokens: z.number().int().nonnegative().optional(),
            extendedContextModelId: z.string().optional(),
            modelOptions: z.array(StoredModelOptionSchema).optional(),
        })),
    }).optional(),
    /**
     * ACP session configuration options (if supported by the provider's ACP agent).
     */
    acpConfigOptionsV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        configOptions: z.array(StoredConfigOptionSchema),
    }).optional(),
    sessionConfigOptionsV1: z.object({
        v: z.literal(1),
        agentId: z.string(),
        updatedAt: z.number(),
        configOptions: z.array(StoredConfigOptionSchema),
    }).optional(),
    sessionRollbackRangesV1: createSessionRollbackRangesV1Schema(z).optional(),
    /**
     * Desired ACP session mode override selected by the user (UI/CLI).
     *
     * This is distinct from `acpSessionModesV1`:
     * - `acpSessionModesV1` mirrors the agent-reported current state.
     * - `acpSessionModeOverrideV1` is the user's requested mode, applied by the runner when possible.
     */
    acpSessionModeOverrideV1: createAcpSessionModeOverrideV1Schema(z).optional(),
    sessionModeOverrideV1: createAcpSessionModeOverrideV1Schema(z).optional(),
    /**
     * Desired ACP config option overrides selected by the user (UI/CLI).
     */
    acpConfigOptionOverridesV1: createAcpConfigOptionOverridesV1Schema(z).optional(),
    sessionConfigOptionOverridesV1: createAcpConfigOptionOverridesV1Schema(z).optional(),
    acpConfiguredBackendV1: z.object({
        v: z.literal(1),
        updatedAt: z.number(),
        backendId: z.string(),
        title: z.string(),
    }).passthrough().optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    hostPid: z.number().optional(), // Process ID of the session
    sessionLogPath: z.string().optional(), // Session-specific CLI log file path
    terminal: createSessionTerminalMetadataSchema(z).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    // Published by happy-cli so the app can seed permission state even before there are messages.
    permissionMode: createSessionPermissionModeSchema(z).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    /**
     * Session-level model override selected by the user (UI/CLI).
     *
     * This mirrors the permission/mode override pattern:
     * - Stored in session metadata for cross-device consistency
     * - Applied to outgoing user messages through the structured selection envelope,
     *   with `message.meta.model` retained only for providerless legacy readers
     */
    modelOverrideV1: createModelOverrideV1Schema(z).optional(),
    modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.optional(),
    /** Per-session overlay for the account-owned managed MCP catalog. */
    mcpSelectionV1: SessionMcpSelectionV1Schema.optional(),
    /** Applied baseline retained only while an active runner needs a restart. */
    mcpSelectionRestartRequiredV1: SessionMcpSelectionRestartRequiredV1Schema.optional(),
    sessionAppliedModelV1: SessionAppliedModelV1Schema.optional(),
    /**
     * Local-only markers for committed transcript messages that should be treated as discarded
     * (e.g. when the user switches to terminal control and abandons unprocessed remote messages).
     */
    externalSessionAttentionV1: z.object({
        v: z.literal(1),
        observedProgressToken: z.string().optional(),
        viewedProgressToken: z.string().optional(),
        observedAtMs: z.number().int().min(0).optional(),
        viewedAtMs: z.number().int().min(0).optional(),
    }).passthrough().optional(),
    discardedCommittedMessageLocalIds: z.array(z.string()).optional(),
    readStateV1: z.object({
        v: z.literal(1),
        sessionSeq: z.number(),
        pendingActivityAt: z.number(),
        updatedAt: z.number(),
    }).optional(),
    /**
     * System/hidden sessions created for internal control planes (voice, execution carrier, etc).
     * These should be excluded from user-facing lists by default.
     */
    systemSessionV1: createSessionSystemSessionV1Schema(z).optional(),
    /**
     * Fork lineage for a child session.
     *
     * Used to render a virtual ancestor transcript (read-only) without duplicating messages.
     */
    forkV1: z.object({
        v: z.literal(1),
        parentSessionId: z.string(),
        parentCutoffSeqInclusive: z.number(),
        createdAtMs: z.number(),
        strategy: z.string(),
        requestId: z.string().optional(),
        filesNotCopied: SessionForkFilesNotCopiedV1Schema.optional(),
        agentHint: z.object({
            agentId: z.string().optional(),
            backendMode: z.string().optional(),
            agentSessionId: z.string().optional(),
        }).optional(),
    }).optional(),
    /**
     * Hidden replay seed applied exactly once to the first real user prompt.
     */
    replaySeedV1: z.object({
        v: z.literal(1),
        seedText: z.string(),
        sourceSessionId: z.string(),
        sourceCutoffSeqInclusive: z.number(),
        createdAtMs: z.number(),
        appliedToLocalId: z.string().optional(),
        appliedAtMs: z.number().optional(),
        /** Pending row the seed was composed into; the daemon owns and reconciles it. */
        dispatchedToLocalId: z.string().optional(),
    }).optional(),
    forkInitialPromptV1: z.object({
        v: z.literal(1),
        text: z.string(),
        createdAtMs: z.number(),
        sourceMessageId: z.string().optional(),
        appliedAtMs: z.number().optional(),
    }).optional(),
    sessionInitialPromptV1: z.object({
        v: z.literal(1),
        text: z.string(),
        mode: z.enum(['replace', 'append']),
        createdAtMs: z.number(),
        sourceMessageIds: z.array(z.string()).optional(),
        sourceSessionId: z.string().optional(),
        source: SessionDiscussionSelectionSourceV1Schema.omit({ draftCorrelationId: true }).optional(),
    }).optional().catch(undefined),
}).passthrough());

export const MetadataSchema = lazyZodSchema(() => z.preprocess((value) => {
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
}, MetadataObjectSchema));

export type Metadata = z.infer<typeof MetadataSchema>;
