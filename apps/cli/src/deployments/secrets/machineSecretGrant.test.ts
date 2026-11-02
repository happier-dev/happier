import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { EnvironmentVariableBindingV1Schema } from '@happier-dev/deployment-protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromEd25519PublicKey, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';

describe('installed Machine grant custody', () => {
    it('round-trips every canonical nonsecret source through the authenticated installation decoder', async () => {
        const custody = await import('./machineSecretGrant.js');
        const seed = new Uint8Array(randomBytes(32));
        const definitions: unknown[] = [
            { kind: 'value', value: '3000' },
            { kind: 'reference', environmentId: 'data', export: 'db', via: 'privateNetwork' },
            ...['primaryUrl', 'commitSha', 'deploymentId', 'environmentName'].map(fact => ({ kind: 'deploymentFact', fact })),
            { kind: 'deploymentFact', fact: 'domainUrl', domainId: 'domain' },
        ];
        for (const source of definitions) {
            const binding = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', phase: 'runtime', name: 'FACT', source });
            if (binding.source.kind === 'secret') throw new Error('Expected nonsecret fixture source');
            const content = { kind: 'environmentValues' as const, definition: binding.source };
            const grant = custody.sealMachineSecretGrant({
                subject: { v: 1, kind: 'environmentValues', machineId: 'machine', installationId: 'installation',
                    environmentId: 'environment', binding: { purpose: binding.purpose, phase: binding.phase, name: binding.name } },
                installationPublicKey: ed25519.getPublicKey(seed), content,
            });
            const identity = { machineId: 'machine', installationId: 'installation', installationPrivateSeed: seed };
            if (grant.kind !== 'environmentValues') throw new Error('Expected an Environment values grant');
            expect(custody.openMachineSecretGrant({ ...identity, grant })).toEqual(content);
            expect(custody.openMachineSecretGrant({ ...identity, grant: { ...grant, environmentId: 'other' } })).toBeNull();
        }
    });

    it('authenticates exact resource and installation without binding names or phases in the seal', async () => {
        const custody = await import('./machineSecretGrant.js').catch(() => null);
        expect(custody, 'installed-key grant custody must exist').not.toBeNull();
        if (!custody) return;
        const seed = new Uint8Array(randomBytes(32));
        const content = { kind: 'secret' as const, value: 'grant-custody-sentinel' };
        const grant = custody.sealMachineSecretGrant({
            subject: { v: 1, kind: 'secret', machineId: 'machine', installationId: 'installation',
                environmentId: 'environment', resourceId: 'resource', resourceRevision: 2 },
            installationPublicKey: ed25519.getPublicKey(seed), content,
        });
        if (grant.kind !== 'secret') throw new Error('Expected a saved secret grant');
        const open = { grant, machineId: 'machine', installationId: 'installation', installationPrivateSeed: seed };
        expect(custody.openMachineSecretGrant(open)).toEqual(content);
        expect(JSON.stringify(grant)).not.toContain(content.value);
        expect(custody.openMachineSecretGrant({ ...open, grant: { ...grant, resourceRevision: 3 } })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, grant: { ...grant, environmentId: 'other' } })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, installationId: 'replacement' })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, installationPrivateSeed: ed25519.getPublicKey(seed) })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, installationPrivateSeed: new Uint8Array(randomBytes(32)) })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, grant: { ...grant, resourceId: 'another-resource' } })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...open, grant: { ...grant, sealedContent: grant.sealedContent.slice(0, -8) } })).toBeNull();
    });

    it('reads retained pre-O2 ciphertext while discarding its historical use list', async () => {
        const custody = await import('./machineSecretGrant.js');
        const seed = new Uint8Array(randomBytes(32));
        const subject = { v: 1 as const, kind: 'secret' as const, machineId: 'machine', installationId: 'installation',
            environmentId: 'environment', resourceId: 'resource', resourceRevision: 2 };
        // Captured pre-O2 plaintext shape: the old writer authenticated subject
        // and content, including this use list. Current admission owns its use.
        const plaintext = new TextEncoder().encode(JSON.stringify({ subject, content: {
            kind: 'secret', value: 'retained-grant-sentinel', uses: [{ purpose: 'variable', phase: 'runtime', name: 'OLD_NAME',
                source: { kind: 'secret', ref: 'happier:shared-secret:v1:resource', resourceRevision: 2 } }],
        } }));
        const grant = { ...subject, sealedContent: encodeBase64(sealBoxBundle({ plaintext,
            recipientPublicKey: deriveBoxPublicKeyFromEd25519PublicKey(ed25519.getPublicKey(seed)),
            randomBytes: length => new Uint8Array(randomBytes(length)),
        })) };
        plaintext.fill(0);
        const identity = { machineId: 'machine', installationId: 'installation', installationPrivateSeed: seed };
        expect(custody.openMachineSecretGrant({ ...identity, grant })).toEqual({ kind: 'secret', value: 'retained-grant-sentinel' });
        expect(custody.openMachineSecretGrant({ ...identity, grant: { ...grant, resourceId: 'substituted-resource' } })).toBeNull();
    });

    it('opens non-secret definitions and Machine connectors only under their own authenticated subjects', async () => {
        const custody = await import('./machineSecretGrant.js').catch(() => null);
        expect(custody).not.toBeNull();
        if (!custody) return;
        const seed = new Uint8Array(randomBytes(32));
        const values = custody.sealMachineSecretGrant({
            subject: { v: 1, kind: 'environmentValues', machineId: 'machine', installationId: 'installation',
                environmentId: 'environment', binding: { purpose: 'variable', phase: 'runtime', name: 'PORT' } },
            installationPublicKey: ed25519.getPublicKey(seed),
            content: { kind: 'environmentValues', definition: { kind: 'value', value: '3000' } },
        });
        if (values.kind !== 'environmentValues') throw new Error('Expected an Environment values grant');
        const identity = { machineId: 'machine', installationId: 'installation', installationPrivateSeed: seed };
        expect(custody.openMachineSecretGrant({ ...identity, grant: values })).toEqual({ kind: 'environmentValues', definition: { kind: 'value', value: '3000' } });
        expect(custody.openMachineSecretGrant({ ...identity, grant: { ...values,
            binding: { purpose: 'variable', phase: 'build', name: 'PORT' } } })).toBeNull();
        const connector = custody.sealMachineSecretGrant({
            subject: { v: 1, kind: 'connectorToken', machineId: 'machine', installationId: 'installation',
                provider: { pluginId: 'example.tunnel', localId: 'tunnel' }, connectorId: 'connector' },
            installationPublicKey: ed25519.getPublicKey(seed), content: { kind: 'connectorToken', token: 'connector-token-sentinel' },
        });
        if (connector.kind !== 'connectorToken') throw new Error('Expected a connector token grant');
        expect(custody.openMachineSecretGrant({ ...identity, grant: connector })).toEqual({ kind: 'connectorToken', token: 'connector-token-sentinel' });
        expect(custody.openMachineSecretGrant({ ...identity, grant: { ...connector, connectorId: 'another' } })).toBeNull();
        expect(custody.openMachineSecretGrant({ ...identity, grant: { ...connector,
            provider: { pluginId: 'another.tunnel', localId: 'tunnel' } } })).toBeNull();
    });
});
