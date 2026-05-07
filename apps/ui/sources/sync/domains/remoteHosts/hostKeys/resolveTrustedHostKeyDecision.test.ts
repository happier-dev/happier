import { describe, expect, it } from 'vitest';

describe('resolveTrustedHostKeyDecision', () => {
    it('auto-accepts exact trusted host-key matches and prompts on changed keys', async () => {
        const loaded = await import('./resolveTrustedHostKeyDecision').catch(() => null);
        expect(loaded).not.toBeNull();

        expect(loaded!.resolveTrustedHostKeyDecision({
            event: {
                host: 'example.test',
                port: 22,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:new',
            },
            trusted: {
                hostLower: 'example.test',
                port: 22,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:new',
                trustedAtMs: 100,
                lastSeenAtMs: 100,
                source: 'remote-host',
            },
        })).toEqual({
            action: 'accept',
            verification: {
                decision: 'accept-once',
                fingerprintSha256: 'SHA256:new',
            },
        });

        expect(loaded!.resolveTrustedHostKeyDecision({
            event: {
                host: 'example.test',
                port: 22,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:new',
            },
            trusted: {
                hostLower: 'example.test',
                port: 22,
                algorithm: 'ssh-ed25519',
                fingerprintSha256: 'SHA256:old',
                trustedAtMs: 100,
                lastSeenAtMs: 100,
                source: 'remote-host',
            },
        })).toEqual({
            action: 'prompt',
            promptKind: 'ssh.replaceHostKey',
            existingFingerprintSha256: 'SHA256:old',
        });
    });
});
