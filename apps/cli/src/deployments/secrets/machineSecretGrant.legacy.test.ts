import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployments';
import { MachineSecretGrantV1Schema } from '@happier-dev/protocol/deployments/machineSecretGrantV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromEd25519PublicKey, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { openMachineSecretGrant } from './machineSecretGrant';

describe('retained named installation grants', () => {
    it('opens the pre-sealed-label Environment and authenticated old subject through real env injection without resaving', async () => {
        const seed = new Uint8Array(randomBytes(32));
        // Exact pre-SECOND producer: the name lived in the subject; content had only definition.
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'RETAINED_ENDPOINT',
            source: { kind: 'value' as const, value: 'https://retained.example.test' } };
        const subject = { v: 1 as const, kind: 'environmentValues' as const, machineId: 'machine', installationId: 'installation',
            environmentId: 'environment', binding: { purpose: binding.purpose, phase: binding.phase, name: binding.name } };
        const plaintext = new TextEncoder().encode(JSON.stringify({ subject,
            content: { kind: 'environmentValues', definition: binding.source } }));
        const grant = { ...subject, sealedContent: encodeBase64(sealBoxBundle({ plaintext,
            recipientPublicKey: deriveBoxPublicKeyFromEd25519PublicKey(ed25519.getPublicKey(seed)),
            randomBytes: length => new Uint8Array(randomBytes(length)) })) };
        plaintext.fill(0);
        const detail = createDeploymentEnvironmentDetailV1();
        const content = { ...detail.content, bindings: [binding] };
        const read = readDeploymentEnvironmentArtifactV1(detail.environment, {
            artifactId: detail.environment.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: 'deployment-environment.v1', title: 'Retained' }, body: JSON.stringify(content),
        });
        expect(read).toMatchObject({ ok: true, content });
        if (!read.ok) throw new Error(read.error);
        const input = { environmentId: 'environment', machineId: 'machine', installationId: 'installation',
            installationPrivateSeed: seed, phase: 'runtime' as const, bindings: read.content.bindings,
            grants: [grant], assertCurrent: async () => {} };
        const launch = await prepareEnvironmentSecretBindingsForLaunch(input);
        expect(launch.env).toEqual({ RETAINED_ENDPOINT: binding.source.value });
        expect(read.content.bindings).toEqual([binding]);
        launch.dispose();
        expect(openMachineSecretGrant({ ...input, grant: { ...grant, binding: { ...subject.binding, name: 'SUBSTITUTED' } } })).toBeNull();
        expect(MachineSecretGrantV1Schema.safeParse(grant).success).toBe(false);
        expect(DeploymentEnvironmentContentV1Schema.safeParse(content).success).toBe(false);
    });
});
