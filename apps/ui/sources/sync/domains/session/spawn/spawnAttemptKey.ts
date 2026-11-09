import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

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

/**
 * The directory part of a spawn attempt's identity. A folder is keyed by its canonical absolute
 * path; no folder has no path to key by, so the attempt's own creation key keeps two separate
 * no-folder chats with the same settings apart (the daemon keys the private folder by the canonical
 * creation tag, not by this client-side custody key).
 */
function resolveSpawnAttemptDirectoryIntentIdentity(
    directory: SessionDirectoryIntentV1,
    creationKey: string | undefined,
    machineHomeDir: string | null | undefined,
): unknown {
    return directory.kind === 'managed'
        ? { kind: 'managed', creationKey: creationKey ?? null }
        : resolveSpawnAttemptDirectoryIdentity(directory.path, machineHomeDir);
}

export function createSpawnAttemptKeyForSessionSpawnNewInput(
    input: SessionSpawnNewInputV2,
    machineHomeDir: string,
): string {
    // Only immutable authored fields enter custody identity; raw launch
    // environment values remain outside the digest.
    const parsed = SessionSpawnNewInputV2Schema.parse(input);
    const authoredImmutableIntent = {
        executionTarget: parsed.executionTarget,
        directory: resolveSpawnAttemptDirectoryIntentIdentity(parsed.directory, parsed.creationKey, machineHomeDir),
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
        capabilitySelection: parsed.capabilitySelection ?? null,
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
