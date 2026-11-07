import { describe, expect, it } from 'vitest';
import { DeploymentApprovalReviewV1Schema } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { projectOwnServerDeploymentReview } from '@/deployments/targets/ownServer/ownServerDeploymentReview';

import { projectNativeComposeReview } from './nativeComposeReview';

/** The deploy approval page reads this projection through the Protocol reader; the two must not drift. */
describe('native Compose review projection', () => {
    it('is the exact shape the deployment approval reader accepts, with redacted values and risks kept', () => {
        const review = projectNativeComposeReview({ services: {
            web: { restart: 'unless-stopped', healthcheck: { test: ['CMD', 'true'] },
                ports: [{ target: 3000, published: '3000', host_ip: '0.0.0.0', protocol: 'tcp' }] },
            worker: { scale: 2, restart: 'no', volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] },
        } }, '/srv/release', value => value.replaceAll('hunter2', '***'));

        const parsed = DeploymentApprovalReviewV1Schema.parse({
            ...review,
            target: { engine: 'native', requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' },
            runtimeMachines: [{ machineId: 'machine-a', review: { ...review,
                target: { engine: 'dockerDesktop', requiresAwakeComputerAndDockerDesktop: true, domains: 'unavailableDockerDesktop' } } }],
        });

        expect(parsed).toMatchObject({ inspection: 'complete', services: [{ name: 'web' }, { name: 'worker', replicas: 2 }] });
        expect(parsed).toMatchObject({ risks: expect.arrayContaining([{ kind: 'docker_socket', service: 'worker' },
            { kind: 'non_loopback_publish', service: 'web' }]) });
    });

    it('projects stored revisions and phase-bound secret names without disclosing documents, values or references', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: true };
        environment.content.retainPreviousDeployments = 3;
        environment.content.ingress = { kind: 'edgeCaddy', edgeMachineId: 'edge-machine' };
        environment.content.bindings = [
            createDeploymentSecretVariableBindingV1({ name: 'RUNTIME_SECRET', phase: 'runtime', resourceId: 'runtime', resourceRevision: 1 }),
            createDeploymentSecretVariableBindingV1({ name: 'BUILD_SECRET', phase: 'build', resourceId: 'build', resourceRevision: 1 }),
            { purpose: 'variable', name: 'PLAIN_SETTING', phase: 'runtime', source: { kind: 'value', value: 'private-nonsecret-sentinel' } },
        ];
        const receipt = createDeploymentReceiptDetailV1();
        const sourceIntent = { kind: 'stored' as const, contentRevision: 7, composeDigest: `sha256:${'c'.repeat(64)}` as const,
            document: 'private-stored-document-sentinel', profiles: [], services: ['web'] };
        const input = { machineId: 'machine-a', environment, servingReceipt: receipt,
            inputBasis: { v: 1 as const, environmentId: environment.environment.id, environmentRevision: 1,
                targetLinkId: 'target-link', targetLinkRevision: 1, sourceIntent, manifestFingerprint: 'manifest',
                configInputDigests: [], physicalProjectName: 'review', toolVersion: '2.39.4', services: ['web'], profiles: [],
                members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: environment.content.bindings, images: [] },
            nativeReview: projectNativeComposeReview({ services: { web: {} } }, '/srv/release', value => value),
            target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const } };
        const review = projectOwnServerDeploymentReview(input);
        expect.soft(review, 'the real recreate owner stops the serving generation before starting its replacement')
            .toMatchObject({ downtime: 'stopThenStart' });
        expect.soft(review, 'retention is the configured policy, never a fabricated kept count or disk measurement')
            .toMatchObject({ rollbackStorage: { keepPreviousDeployments: 3 } });
        expect(DeploymentApprovalReviewV1Schema.parse(review)).toEqual(review);
        expect(review).toMatchObject({ environment: { name: environment.content.name, ingress: environment.content.ingress },
            revision: { kind: 'stored', contentRevision: 7, composeDigest: sourceIntent.composeDigest },
            replaces: { deploymentId: receipt.deployment.id, revision: { kind: 'repository' } }, secretBindingNames: ['RUNTIME_SECRET'] });
        expect(projectOwnServerDeploymentReview({ ...input, onFailure: 'keepPartial' })).toMatchObject({ onFailure: 'keepPartial' });
        expect(JSON.stringify(review)).not.toMatch(/private-stored-document-sentinel|private-nonsecret-sentinel|shared-resource|PLAIN_SETTING/);
        const firstBuild = projectOwnServerDeploymentReview({ ...input, servingReceipt: null,
            inputBasis: { ...input.inputBasis, buildServices: ['web'] } });
        expect(firstBuild.replaces).toBeNull();
        expect(firstBuild).not.toHaveProperty('downtime');
        expect(firstBuild.secretBindingNames).toEqual(['RUNTIME_SECRET', 'BUILD_SECRET']);
        environment.content.retainPreviousDeployments = 0;
        environment.content.ownServer.rollout = 'startFirst';
        const notYetProduced = projectOwnServerDeploymentReview(input);
        expect(notYetProduced).not.toHaveProperty('downtime');
        expect(notYetProduced).toMatchObject({ rollbackStorage: { keepPreviousDeployments: 0 } });
        for (const row of [review, firstBuild, notYetProduced]) {
            expect(row).not.toHaveProperty('domains');
            expect(row).not.toHaveProperty('tls');
            expect(row).not.toHaveProperty('rollbackStorage.keptBytes');
            expect(row).not.toHaveProperty('rollbackStorage.freeBytes');
        }
    });
});
