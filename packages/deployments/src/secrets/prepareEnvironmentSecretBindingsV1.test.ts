import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { prepareEnvironmentSecretBindingsV1 } from './prepareEnvironmentSecretBindingsV1.js';
import { sealMachineSecretGrantEnvelopeV1 } from './sealMachineSecretGrantEnvelopeV1.js';

type ReferenceComponent = Extract<EnvironmentSecretBindingV1['source'], { kind: 'reference' }>['component'];
const reference = (component: ReferenceComponent): EnvironmentSecretBindingV1 => ({
    purpose: 'variable', phase: 'runtime', name: 'DATABASE_CONNECTION',
    source: { kind: 'reference', environmentId: 'database-environment', export: 'database', via: 'privateNetwork',
        ...(component ? { component } : {}) },
});

describe('Environment reference grant preparation', () => {
    it.each([
        { name: 'refreshes endpoint ciphertext when selecting host', previous: undefined, next: 'host' },
        { name: 'refreshes host ciphertext when selecting port', previous: 'host', next: 'port' },
        { name: 'retains ciphertext when the component is unchanged', previous: 'host', next: 'host' },
    ] as const)('$name', async ({ previous, next }) => {
        const key = randomBytes(32);
        // The host crypto adapter is the only substituted boundary; preparation
        // and the canonical envelope author both run unchanged.
        const sealGrant: Parameters<typeof prepareEnvironmentSecretBindingsV1>[0]['sealGrant'] = input =>
            sealMachineSecretGrantEnvelopeV1({ ...input, seal(plaintext) {
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', key, iv);
                const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
                return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
            } });
        const open = (sealedContent: string): unknown => {
            const sealed = Buffer.from(sealedContent, 'base64');
            const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
            decipher.setAuthTag(sealed.subarray(12, 28));
            return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8'));
        };
        const input = { environmentId: 'application-environment',
            runtimeInstallations: [{ machineId: 'machine', installationId: 'installation', publicKey: new Uint8Array(32) }],
            sealGrant, async assertCurrent() {} };
        const previousBindings = [reference(previous)];
        const initial = await prepareEnvironmentSecretBindingsV1({ ...input, bindings: previousBindings,
            previousBindings: [], existingGrants: [] });
        const binding = reference(next);
        const prepared = await prepareEnvironmentSecretBindingsV1({ ...input, bindings: [binding],
            previousBindings, existingGrants: initial.grants });
        expect(prepared.grants).toHaveLength(1);
        expect(open(prepared.grants[0]!.sealedContent)).toMatchObject({
            subject: { kind: 'environmentValues', environmentId: input.environmentId,
                binding: { purpose: binding.purpose, phase: 'runtime', name: 'DATABASE_CONNECTION' } },
            content: { kind: 'environmentValues', definition: binding.source },
        });
        if (previous === next) expect(prepared.grants[0]!.sealedContent).toBe(initial.grants[0]!.sealedContent);
    });
});
