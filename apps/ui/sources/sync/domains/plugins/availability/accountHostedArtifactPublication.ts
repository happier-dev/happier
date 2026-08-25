import type { PluginUiArtifactCompatibilityKeyV1 } from '@happier-dev/protocol/plugins/ui';

import {
    publishActivePluginAccountHostedArtifact,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { PluginSelectedArtifactLease } from './artifactLease';
import type { PluginAccountAvailabilityReader } from './reader';

export type PluginAccountHostedArtifactPublicationInput = Readonly<{
    /** Availability owns hosting admission; this function never re-derives it. */
    reader: Pick<PluginAccountAvailabilityReader, 'readCurrentHostedPublicationTarget'>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** An already fully verified lease; its declared bytes are the only payload. */
    lease: PluginSelectedArtifactLease;
    /**
     * The publishing host's own adoption facts for exactly these bytes,
     * supplied by the renderer tier that owns them. The publication Action
     * validates them against the declared slot before it sends anything.
     */
    hostCompatibility: PluginUiArtifactCompatibilityKeyV1;
}>;

/**
 * The one place a verified Artifact lease becomes an Account-hosted archive.
 *
 * Account hosting exists so a new uncached client can cold-load a plugin
 * surface with every daemon offline. Nothing else in the product uploads the
 * archive, so the present client that has just verified those exact bytes is
 * the only producer that ever holds them beside a current Account authority.
 *
 * It owns no queue, retry, receipt, or byte store: publication is one
 * invocation of the existing qualified publication Action, gated by
 * Availability's existing hosting admission, and its failure is a truthful
 * non-event that leaves the verified lease untouched. Archive/slot/digest
 * exactness stays with that Action, which recomputes the digest from these
 * bytes rather than trusting a coordinate compared here.
 */
export async function publishVerifiedPluginArtifactToAccountHosting(
    input: PluginAccountHostedArtifactPublicationInput,
): Promise<void> {
    if (!input.accountLifetime.isCurrent() || !input.lease.isCurrent()) return;

    const artifact = input.lease.artifact;
    const admission = input.reader.readCurrentHostedPublicationTarget({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        tier: artifact.tier,
        platform: artifact.platform,
    });
    if (admission.kind !== 'available') return;
    const target = admission.target;

    const files: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
    for (const declared of input.lease.files) {
        const read = await input.lease.readFile(declared.relativePath);
        if (read.kind !== 'available') return;
        files.push(Object.freeze({
            relativePath: read.file.relativePath,
            bytes: new Uint8Array(read.bytes),
        }));
    }
    if (!input.accountLifetime.isCurrent() || !input.lease.isCurrent()) return;

    try {
        await publishActivePluginAccountHostedArtifact({
            accountLifetime: input.accountLifetime,
            release: target.release,
            slot: target.slot,
            hostCompatibility: input.hostCompatibility,
            artifactGraph: input.lease.artifactGraph,
            files: Object.freeze(files),
        });
    } catch {
        // Optional hosting must never turn a verified lease into a failure the
        // user can see. The next acquisition re-evaluates the same admission.
    }
}
