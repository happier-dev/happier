import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';

import type { PluginUiArtifactTrustedSourceReason } from './artifactSigning';

/**
 * Canonical plugin-source trust gate for the LOCAL render/load chokepoints
 * (§2.2 / §5.1 / §8 DT-1). This is the single owner of the question
 * "is this contribution trusted for local render/load purely from its install
 * provenance + the granted trust policy, WITHOUT a signature?".
 *
 * The trust signal is `provenance` + `sourceSpec.trustPolicy` — the REAL grant
 * recorded at install time — NOT `source.kind`. Keying on `source.kind`
 * (`path` / `archive`) is a conflation bug: a `kind:'archive'` source can be
 * either a local archive the user pointed the CLI at (`trustPolicy:'local_trusted'`)
 * or a REMOTE marketplace archive (`trustPolicy:'prompt'`). Install + enable IS
 * the trust grant for a local source, and that grant is recorded as
 * `trustPolicy:'local_trusted'` by the install machinery (`localPath.ts`,
 * `store/install/source.ts`); a remote archive keeps `trustPolicy:'prompt'`
 * and must fall through to signature/integrity verification (§5.2).
 *
 * Returning `null` means "not trusted by provenance alone" → the caller must
 * verify a signature (or deny). This keeps the projection gate, the daemon
 * byte-read gate, and the module-load gate (`loadPluginModule.ts assertTrusted`,
 * which only loads `local_trusted`) in agreement: a remote archive projects as
 * NOT trusted, matching the load-time rejection.
 */
/**
 * The single predicate for "does this granted trust policy admit local
 * render/load without a signature?". Only an explicit `local_trusted` grant
 * (recorded at install time when the user pointed the CLI at a local source)
 * qualifies; `prompt`/`untrusted` must verify a signature or be rejected. The
 * load-time gate (`loadPluginModule.ts assertTrusted`) and the projection
 * reason resolution below both derive from THIS predicate so the two gates can
 * never drift.
 */
export function isTrustPolicyLocallyTrusted(
    trustPolicy: PluginSourceTrustPolicyV1 | string | undefined,
): boolean {
    return trustPolicy === 'local_trusted';
}

export function resolveTrustedSourceReason(
    contribution: Readonly<{
        provenance?: string;
        source?: Readonly<{ kind?: string }>;
        sourceSpec?: Readonly<{ trustPolicy?: PluginSourceTrustPolicyV1 | string }>;
    }>,
): PluginUiArtifactTrustedSourceReason | null {
    if (contribution.provenance === 'first_party') {
        return 'first_party';
    }
    if (contribution.source?.kind === 'bundled') {
        return 'bundled';
    }
    if (isTrustPolicyLocallyTrusted(contribution.sourceSpec?.trustPolicy)) {
        return 'local_trusted';
    }
    return null;
}
