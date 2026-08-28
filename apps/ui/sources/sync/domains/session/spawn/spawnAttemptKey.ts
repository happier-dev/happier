import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import {
    SessionCreationImmutableRecipeV1Schema,
    SessionSpawnNewInputV2Schema,
    type SessionCreationImmutableRecipeV1,
    type SessionSpawnNewInputV2,
    normalizeSessionCreationOrganizationPlacementV1,
} from '@happier-dev/protocol';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

type SpawnAttemptKeyOptions = Readonly<{
    machineId: string;
    serverId?: string | null;
    directory: string;
    agentTarget?: unknown;
    backendTarget?: unknown;
    modelSelection?: unknown;
    profileId?: string | null;
    permissionMode?: unknown;
    agentModeId?: string | null;
    configuration?: unknown;
    sessionConfigOptionOverrides?: unknown;
    runtimeDescriptorV1?: unknown;
    resume?: string | null;
    connectedServices?: unknown;
    mcpSelection?: unknown;
    transcriptStorage?: 'persisted' | 'direct' | null;
    terminal?: unknown;
    windowsRemoteSessionLaunchMode?: unknown;
    windowsRemoteSessionConsole?: unknown;
    windowsTerminalWindowName?: string | null;
    organizationPlacement?: unknown;
    checkout?: unknown;
}>;

function normalizedOptionalString(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized || null;
}

export function resolveSpawnAttemptDirectoryIdentity(
    directory: string,
    machineHomeDir?: string | null,
): string {
    const identity = normalizeFileSystemPath(
        resolveAbsolutePath(directory.trim(), machineHomeDir?.trim() || undefined),
    );
    if (!identity) {
        throw new Error('Spawn attempt directory identity is unavailable');
    }
    return identity;
}

export function createSpawnAttemptKeyForImmutableCreationRecipe(
    input: SessionCreationImmutableRecipeV1,
): string {
    const recipe = SessionCreationImmutableRecipeV1Schema.parse(input);
    return `machine.spawn_new:v4:${computeCanonicalDomainSeparatedDigest(
        'happier.session.spawn-attempt-immutable-recipe.v1',
        [createCanonicalJsonSigningInput(recipe)],
    )}`;
}

export function createSpawnAttemptKeyForSessionSpawnNewInput(
    input: SessionSpawnNewInputV2,
    machineHomeDir: string,
): string {
    const parsed = SessionSpawnNewInputV2Schema.parse(input);
    if (parsed.environmentVariables !== undefined) {
        throw new Error('Deterministic Session custody cannot include raw environment variables');
    }
    const authoredImmutableIntent = {
        executionTarget: parsed.executionTarget,
        directory: resolveSpawnAttemptDirectoryIdentity(parsed.directory, machineHomeDir),
        organizationPlacement: normalizeSessionCreationOrganizationPlacementV1(
            parsed.organizationPlacement,
        ),
        agentTarget: parsed.agentTarget,
        modelSelection: parsed.modelSelection ?? null,
        profileId: parsed.profileId ?? null,
        permissionMode: parsed.permissionMode ?? null,
        agentModeId: parsed.agentModeId ?? null,
        configuration: parsed.configuration ?? null,
        connectedServices: parsed.connectedServices ?? null,
        mcpSelection: parsed.mcpSelection ?? null,
        transcriptStorage: parsed.transcriptStorage ?? null,
        terminal: parsed.terminal ?? null,
        checkoutCreationDraft: parsed.checkoutCreationDraft ?? null,
        agentSessionStartupInstructionsMarkerV1: parsed.agentSessionStartupInstructionsV1
            ? {
                v: parsed.agentSessionStartupInstructionsV1.v,
                id: parsed.agentSessionStartupInstructionsV1.id,
                revision: parsed.agentSessionStartupInstructionsV1.revision,
            }
            : null,
    };
    return `machine.spawn_new:v4:${computeCanonicalDomainSeparatedDigest(
        'happier.session.spawn-attempt-authored-intent.v1',
        [createCanonicalJsonSigningInput(authoredImmutableIntent)],
    )}`;
}

export function createSpawnAttemptKeyForFreshSpawnOptions<T extends SpawnAttemptKeyOptions>(
    options: T,
    machineHomeDir: string,
): string {
    const directory = resolveSpawnAttemptDirectoryIdentity(options.directory, machineHomeDir);
    const usesPredecessorLaunchFields = options.backendTarget !== undefined
        || options.sessionConfigOptionOverrides !== undefined
        || options.runtimeDescriptorV1 !== undefined
        || normalizedOptionalString(options.resume) !== null
        || options.windowsRemoteSessionLaunchMode !== undefined
        || options.windowsRemoteSessionConsole !== undefined
        || normalizedOptionalString(options.windowsTerminalWindowName) !== null;
    if (options.agentTarget === undefined || options.agentTarget === null || usesPredecessorLaunchFields) {
        // Persisted v2/v3 custody may still be resumed by the predecessor raw
        // spawn ingress. Keep its exact target-only identity as a reader/writer
        // obligation until those already-submitted attempts settle; strict V2
        // New Session writers always provide `agentTarget` and use v4 below.
        return `machine.spawn_new:${JSON.stringify({
            machineId: options.machineId.trim(),
            serverId: options.serverId?.trim() ?? null,
            directory,
        })}`;
    }
    const organization = normalizeSessionCreationOrganizationPlacementV1(
        options.organizationPlacement as Parameters<typeof normalizeSessionCreationOrganizationPlacementV1>[0],
    );
    const recipe = SessionCreationImmutableRecipeV1Schema.parse({
        execution: {
            machineId: options.machineId.trim(),
            directory,
        },
        organization,
        agentTarget: options.agentTarget,
        modelSelection: options.modelSelection ?? null,
        profileId: normalizedOptionalString(options.profileId),
        requestedPermissionMode: options.permissionMode ?? null,
        agentModeId: normalizedOptionalString(options.agentModeId),
        configuration: options.configuration ?? null,
        connectedServices: options.connectedServices ?? null,
        mcpSelection: options.mcpSelection ?? null,
        transcriptStorage: options.transcriptStorage ?? null,
        terminal: options.terminal ?? null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: options.checkout ?? null,
    });

    return createSpawnAttemptKeyForImmutableCreationRecipe(recipe);
}
