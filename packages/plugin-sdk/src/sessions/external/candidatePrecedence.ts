/** @moduleRealm daemon */
import { createHash } from 'node:crypto';

import { PluginAgentExternalSessionLinkDataSchema } from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Opaque identity for a private candidate. It deliberately includes linkData,
 * unlike the public ExternalSessionRef, so owners can preserve their existing
 * deterministic order without projecting private identity to consumers.
 */
export function resolveExternalSessionCandidateIdentityKey(
    candidate: Readonly<{
        remoteSessionId: string;
        linkData?: unknown;
    }>,
): string {
    if (!candidate.remoteSessionId) {
        throw new Error('External-session candidate identity requires a remote session id');
    }
    let linkData = null;
    if (candidate.linkData !== undefined) {
        const parsed = PluginAgentExternalSessionLinkDataSchema.safeParse(candidate.linkData);
        if (!parsed.success) {
            throw new Error('External-session candidate identity requires strict JSON link data');
        }
        linkData = parsed.data;
    }
    return createHash('sha256').update(createCanonicalJsonSigningInput({
        linkData,
        remoteSessionId: candidate.remoteSessionId,
    }), 'utf8').digest('hex');
}

/**
 * Canonical private Browse ordering. Public projections can reuse the final
 * opaque tie-break without retaining or exposing linkData.
 */
export function compareExternalSessionCandidatePrecedence(
    left: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        linkData?: unknown;
    }>,
    right: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        linkData?: unknown;
    }>,
): number {
    return right.updatedAtMs - left.updatedAtMs
        || compareCodeUnits(left.remoteSessionId, right.remoteSessionId)
        || compareCodeUnits(
            resolveExternalSessionCandidateIdentityKey(left),
            resolveExternalSessionCandidateIdentityKey(right),
        );
}
