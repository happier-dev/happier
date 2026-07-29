import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

function sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('resolveIosSimulatorHelperArtifact', () => {
    it('fails closed when the helper artifact is missing', async () => {
        const mod = await import('./helperArtifact').catch(() => null);

        expect(mod?.resolveIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorHelperArtifact) return;

        await expect(mod.resolveIosSimulatorHelperArtifact({
            expectedVersion: '1.2.3',
            expectedDigest: 'sha256:expected',
            resolveArtifactPath: () => '/tmp/missing-helper',
            readFile: async () => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            readMetadata: async () => ({ version: '1.2.3' }),
            verifySignature: async () => ({ ok: true }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_artifact_missing',
        });
    });

    it('verifies digest, signature, and helper version before returning a helper path', async () => {
        const mod = await import('./helperArtifact').catch(() => null);

        expect(mod?.resolveIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorHelperArtifact) return;

        const bytes = new TextEncoder().encode('signed-helper');
        const verifySignature = vi.fn(async () => ({ ok: true as const }));
        await expect(mod.resolveIosSimulatorHelperArtifact({
            expectedVersion: '1.2.3',
            expectedDigest: sha256(bytes),
            resolveArtifactPath: () => '/tmp/happier-ios-simulator-helper',
            readFile: async () => bytes,
            readMetadata: async () => ({ version: '1.2.3' }),
            verifySignature,
        })).resolves.toEqual({
            ok: true,
            path: '/tmp/happier-ios-simulator-helper',
            version: '1.2.3',
            digest: sha256(bytes),
        });
        expect(verifySignature).toHaveBeenCalledWith('/tmp/happier-ios-simulator-helper');
    });

    it('fails closed through the real default signature verifier on an unsigned artifact', async () => {
        const mod = await import('./helperArtifact').catch(() => null);

        expect(mod?.resolveIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorHelperArtifact) return;

        const bytes = new TextEncoder().encode('unsigned-helper');

        // No verifySignature override: the default delegates to the real Gatekeeper verifier
        // (codesign/spctl). The fixture path is not a signed Mach-O, so the verifier rejects it
        // and the resolver downgrades to helper_artifact_unsigned. The fail-closed posture holds
        // regardless of host (non-macOS → signature_verifier_unsupported_host).
        await expect(mod.resolveIosSimulatorHelperArtifact({
            expectedVersion: '1.2.3',
            expectedDigest: sha256(bytes),
            resolveArtifactPath: () => '/tmp/happier-ios-simulator-helper',
            readFile: async () => bytes,
            readMetadata: async () => ({ version: '1.2.3' }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_artifact_unsigned',
            diagnostics: [expect.objectContaining({
                code: 'helper_artifact_signature_failed',
            })],
        });
    });

    it('fails closed before touching disk when the pinned digest is the placeholder', async () => {
        const mod = await import('./helperArtifact').catch(() => null);

        expect(mod?.resolveIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorHelperArtifact) return;

        const readFile = vi.fn(async () => new TextEncoder().encode('helper'));
        const verifySignature = vi.fn(async () => ({ ok: true as const }));

        await expect(mod.resolveIosSimulatorHelperArtifact({
            expectedVersion: '0.0.0-unavailable',
            expectedDigest: `sha256:${'0'.repeat(64)}`,
            resolveArtifactPath: () => '/tmp/happier-ios-simulator-helper',
            readFile,
            readMetadata: async () => ({ version: '0.0.0-unavailable' }),
            verifySignature,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_artifact_missing',
            diagnostics: [expect.objectContaining({
                code: 'helper_artifact_placeholder_digest',
            })],
        });
        expect(readFile).not.toHaveBeenCalled();
        expect(verifySignature).not.toHaveBeenCalled();
    });

    it('fails closed for digest, signature, and version mismatches', async () => {
        const mod = await import('./helperArtifact').catch(() => null);

        expect(mod?.resolveIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorHelperArtifact) return;

        const bytes = new TextEncoder().encode('helper');
        const base = {
            expectedVersion: '1.2.3',
            expectedDigest: sha256(bytes),
            resolveArtifactPath: () => '/tmp/happier-ios-simulator-helper',
            readFile: async () => bytes,
        };

        await expect(mod.resolveIosSimulatorHelperArtifact({
            ...base,
            expectedDigest: 'sha256:other',
            readMetadata: async () => ({ version: '1.2.3' }),
            verifySignature: async () => ({ ok: true }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_artifact_digest_mismatch',
        });
        await expect(mod.resolveIosSimulatorHelperArtifact({
            ...base,
            readMetadata: async () => ({ version: '1.2.3' }),
            verifySignature: async () => ({ ok: false, reasonCode: 'not_signed' }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_artifact_unsigned',
        });
        await expect(mod.resolveIosSimulatorHelperArtifact({
            ...base,
            readMetadata: async () => ({ version: '1.2.4' }),
            verifySignature: async () => ({ ok: true }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'helper_version_mismatch',
        });
    });

    it('keeps the packaged helper manifest blocked until a signed notarized helper is pinned', () => {
        const manifest = JSON.parse(
            readFileSync(new URL('../../../../../assets/ios/simulator-helper/manifest.json', import.meta.url), 'utf8'),
        ) as { status?: unknown; sha256?: unknown; signature?: unknown; version?: unknown };

        expect(manifest).toMatchObject({
            status: 'blocked_missing_signed_notarized_helper',
            signature: 'developer_id_notarized_required',
            version: '0.0.0-unavailable',
            sha256: null,
        });
    });
});
