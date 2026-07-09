import { describe, expect, it } from 'vitest';

import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';

import { loadPluginModule } from '@/plugins/runtime/loadPluginModule';

import { resolveTrustedSourceReason } from './trustedSource';

type TrustContribution = Readonly<{
    provenance?: string;
    source?: Readonly<{ kind?: string }>;
    sourceSpec?: Readonly<{ trustPolicy?: PluginSourceTrustPolicyV1 }>;
}>;

/**
 * Exercise the REAL daemon module-load trust gate (`loadPluginModule` →
 * `assertTrusted`) for a contribution and return whether the gate ADMITS it
 * (trust passed) or REJECTS it (`PLUGIN_DAEMON_TRUST_*`). We point at a
 * non-existent `.js` entry: if trust passes the load proceeds past the gate and
 * fails later with a non-trust error; if trust fails the gate throws first.
 */
async function loadGateAdmits(contribution: TrustContribution): Promise<boolean> {
    try {
        await loadPluginModule({
            source: {
                kind: 'file_backed',
                entryPath: '/nonexistent/plugin/daemon/entry.js',
                trustPolicy: contribution.sourceSpec?.trustPolicy,
            },
        });
        return true;
    } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'PLUGIN_DAEMON_TRUST_UNTRUSTED' || code === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED') {
            return false;
        }
        // Any non-trust load error (missing entry, etc.) means the trust gate
        // ADMITTED the source.
        return true;
    }
}

describe('resolveTrustedSourceReason (canonical plugin-source trust gate)', () => {
    it('treats first-party provenance as trusted', () => {
        expect(resolveTrustedSourceReason({ provenance: 'first_party', source: { kind: 'path' } })).toBe('first_party');
    });

    it('treats bundled source.kind as trusted', () => {
        expect(resolveTrustedSourceReason({ provenance: 'external', source: { kind: 'bundled' } })).toBe('bundled');
    });

    it('treats a local_trusted trust policy as trusted regardless of source.kind', () => {
        expect(
            resolveTrustedSourceReason({
                provenance: 'external',
                source: { kind: 'path' },
                sourceSpec: { trustPolicy: 'local_trusted' },
            }),
        ).toBe('local_trusted');
        expect(
            resolveTrustedSourceReason({
                provenance: 'external',
                source: { kind: 'archive' },
                sourceSpec: { trustPolicy: 'local_trusted' },
            }),
        ).toBe('local_trusted');
    });

    it('REJECTS a remote archive that needs a prompt (drops the source.kind path/archive conflation)', () => {
        // The conflation bug: a remote marketplace archive carries kind:'archive'
        // but trustPolicy:'prompt'. Keying on source.kind wrongly granted it
        // 'local_install'. Keying on the real grant (trustPolicy) denies it.
        expect(
            resolveTrustedSourceReason({
                provenance: 'external',
                source: { kind: 'archive' },
                sourceSpec: { trustPolicy: 'prompt' },
            }),
        ).toBeNull();
    });

    it('REJECTS an untrusted source', () => {
        expect(
            resolveTrustedSourceReason({
                provenance: 'external',
                source: { kind: 'archive' },
                sourceSpec: { trustPolicy: 'untrusted' },
            }),
        ).toBeNull();
    });

    it('REJECTS a contribution with no provenance/trust signal', () => {
        expect(resolveTrustedSourceReason({})).toBeNull();
    });
});

describe('DT-3 cross-boundary: projection trust gate AGREES with the module-load trust gate', () => {
    const cases: ReadonlyArray<Readonly<{ name: string; contribution: TrustContribution }>> = [
        {
            name: 'local path install (trustPolicy:local_trusted)',
            contribution: { provenance: 'external', source: { kind: 'path' }, sourceSpec: { trustPolicy: 'local_trusted' } },
        },
        {
            name: 'local archive install (trustPolicy:local_trusted)',
            contribution: { provenance: 'external', source: { kind: 'archive' }, sourceSpec: { trustPolicy: 'local_trusted' } },
        },
        {
            name: 'remote archive (trustPolicy:prompt) — must be loadable IFF projected trusted',
            contribution: { provenance: 'external', source: { kind: 'archive' }, sourceSpec: { trustPolicy: 'prompt' } },
        },
        {
            name: 'untrusted archive',
            contribution: { provenance: 'external', source: { kind: 'archive' }, sourceSpec: { trustPolicy: 'untrusted' } },
        },
    ];

    for (const { name, contribution } of cases) {
        it(`agrees for ${name}`, async () => {
            const projectionTrusted = resolveTrustedSourceReason(contribution) !== null;
            const loadAdmits = await loadGateAdmits(contribution);
            // The core invariant: a contribution the projection marks trusted
            // (loadable) MUST be admitted by the load gate, and one the projection
            // marks untrusted MUST be rejected by the load gate. A remote archive
            // (prompt) must NOT project as loadable while the loader rejects it.
            expect(projectionTrusted).toBe(loadAdmits);
        });
    }

    it('specifically: a remote archive projects NOT-trusted AND is rejected at load (no projection↔load disagreement)', async () => {
        const remoteArchive: TrustContribution = {
            provenance: 'external',
            source: { kind: 'archive' },
            sourceSpec: { trustPolicy: 'prompt' },
        };
        expect(resolveTrustedSourceReason(remoteArchive)).toBeNull();
        expect(await loadGateAdmits(remoteArchive)).toBe(false);
    });
});
