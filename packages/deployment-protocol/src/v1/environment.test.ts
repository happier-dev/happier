import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentV1, createDeploymentTargetLinkV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentHeaderV1Schema, EnvironmentSecretBindingV1Schema,
    createOwnServerEnvironmentConfigurationV1 } from './environment.js';
import { DeploymentV1Schema, OwnServerDeploymentInputBasisV1Schema } from './deployment.js';
import { DeploymentTargetLinkV1Schema } from './target.js';

describe('multi-Machine deployment contracts', () => {
    it('rejects explicit null instead of authoring a default for an invalid own-server choice', () => {
        for (const field of ['rollout', 'autoRestorePreviousRelease', 'backupBeforeMigration', 'migrationFailurePolicy', 'serviceExports']) {
            // Exercise the exported JavaScript boundary with malformed external input.
            expect(() => Reflect.apply(createOwnServerEnvironmentConfigurationV1, undefined, [{ [field]: null }])).toThrow();
        }
    });

    it('never persists an unresolved person selection in any binding purpose', () => {
        const pending = { kind: 'secret', ref: 'person_selects' };
        const bindings = [
            { purpose: 'variable', name: 'API_TOKEN', phase: 'runtime', source: pending },
            { purpose: 'registry', targetLinkId: 'link', registryOrigin: 'https://registry.example', access: 'pull', source: pending },
            { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: pending },
            { purpose: 'domainCredential', domainId: 'domain', role: 'privateKey', source: pending },
            { purpose: 'dataRole', service: 'database', role: 'readOnlyPassword', source: pending },
            { purpose: 'dataRole', targetLinkId: 'managed-database', role: 'readOnlyPassword', source: pending },
        ];
        const environment = createDeploymentEnvironmentDetailV1();
        for (const binding of bindings) {
            expect(EnvironmentSecretBindingV1Schema.safeParse(binding).success).toBe(false);
            expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source: { ...pending, resourceRevision: 1 } }).success).toBe(false);
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content, bindings: [binding] }).success).toBe(false);
        }
    });

    it('preserves declared service exports without inventing exports on reload', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const serviceExports = [
            { key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'network-a' },
            { key: 'web', service: 'web', containerPort: 3000, scheme: 'http', exposure: 'public' },
            { key: 'admin', service: 'web', containerPort: 3001, scheme: 'http', exposure: 'loopback' },
        ];
        const ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false, serviceExports };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, ownServer }).ownServer).toEqual(ownServer);
        const withoutExports = { rollout: 'startFirst', autoRestorePreviousRelease: true };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, ownServer: withoutExports }).ownServer).toEqual(withoutExports);
        const privateExport = serviceExports[0];
        for (const invalid of [
            [...serviceExports, { ...privateExport }],
            [{ ...privateExport, privateNetwork: undefined }],
            [{ ...serviceExports[1], privateNetwork: 'network-a' }],
            [{ ...privateExport, containerPort: 0 }],
            [{ ...privateExport, containerPort: 65536 }],
            [{ ...privateExport, scheme: 'postgres://credentials' }],
        ]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content,
                ownServer: { ...ownServer, serviceExports: invalid } }).success).toBe(false);
        }
    });
    it('retains preview provenance only in protected Environment content, without a copied approval mode', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const repository = { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' };
        const previewProvenance = { v: 1, templateEnvironmentId: 'template', runtimeTargetLinkId: 'template-runtime',
            repository, pullRequestId: 'pull-request-17', pullRequestNumber: 17,
            author: { id: 'author-4', login: 'contributor' }, headRepository: { ...repository, repository: 'contributor/app' } };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, previewProvenance }))
            .toEqual({ ...environment.content, previewProvenance });
        for (const invalid of [{ ...previewProvenance, approvalMode: 'waived' },
            { ...previewProvenance, headRepository: null }, { ...previewProvenance, pullRequestNumber: 0 },
            { ...previewProvenance, repository: { ...repository, deployment: 'not-an-origin' } }]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content, previewProvenance: invalid }).success).toBe(false);
        }
        expect(DeploymentEnvironmentHeaderV1Schema.safeParse({ ...environment.environment, previewProvenance }).success).toBe(false);
    });
    it('retains pinned template provenance without making it another Compose or secret owner', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const template = { templateRef: { sourceId: 'data', itemId: 'postgres', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            definition: { kind: 'stored', contentRevision: 2, composeDigest: `sha256:${'b'.repeat(64)}` }, services: ['db'],
            data: { engine: 'postgres', service: 'db', port: 5432 },
            exports: { database: { service: 'db', port: 5432, defaultExposure: 'internal', env: { DATABASE_URL: 'postgres://${DB_USER}:${DB_PASSWORD}@db:5432/app' } } } };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, template })).toEqual({ ...environment.content, template });
        for (const invalid of [{ ...template, document: 'second-compose-owner' }, { ...template, password: 'inline-secret' }]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content, template: invalid }).success).toBe(false);
        }
    });
    it('round-trips the declared migration and reviewed recovery choice without applying read defaults', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
            migration: { service: 'app', argv: ['migrate', ''], pendingCheck: { argv: ['pending'] } },
            backupBeforeMigration: false, migrationFailurePolicy: 'rollbackCodeOnly' };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, ownServer }).ownServer).toEqual(ownServer);
        expect(DeploymentEnvironmentContentV1Schema.parse(environment.content)).toEqual(environment.content);
        expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content,
            ownServer: { ...ownServer, migration: { ...ownServer.migration, argv: [] } } }).success).toBe(false);
        expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content,
            ownServer: { ...ownServer, migrationFailurePolicy: 'rollbackAll' } }).success).toBe(false);
    });
    it('retains ordered joining members and mixed-platform image identities with reviewed ingress', () => {
        const link = createDeploymentTargetLinkV1();
        const members = [...link.members, { machineId: 'machine-b', installationId: 'installation-b', state: 'joining' }];
        expect(DeploymentTargetLinkV1Schema.parse({ ...link, machines: ['machine-a', 'machine-b'], members }).members).toEqual(members);

        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened fixture content');
        const content = { ...receipt.content.v, machines: ['machine-a', 'machine-b'], buildMachineId: 'builder',
            ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' }, onFailure: 'keepPartial',
            images: [...receipt.content.v.images, { ...receipt.content.v.images[0], platform: 'linux/arm64',
                configDigest: `sha256:${'c'.repeat(64)}`, manifestDigest: `sha256:${'d'.repeat(64)}` }] };
        expect(DeploymentV1Schema.parse({ ...receipt, content: { t: 'plain', v: content } }).content).toEqual({ t: 'plain', v: content });
        const header = createDeploymentEnvironmentHeaderV1();
        expect(DeploymentEnvironmentHeaderV1Schema.parse({ ...header, ingress: content.ingress }).ingress).toEqual(content.ingress);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...content, machines: ['machine-a'] } } }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...content,
            ingress: { kind: 'cloudflareTunnel', edgeMachineId: 'edge' } } } }).success).toBe(false);
    });

    it('rejects duplicate Machine or image identities in the exact retained approval basis', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened fixture content');
        const basis = { v: 1, environmentId: receipt.environmentId, environmentRevision: 1,
            targetLinkId: receipt.targetLinkId, targetLinkRevision: 1, sourceIntent: receipt.content.v.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'app', toolVersion: '2.39.4',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: receipt.content.v.images };
        expect(OwnServerDeploymentInputBasisV1Schema.safeParse(basis).success).toBe(true);
        expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...basis, members: [] }).success).toBe(false);
        expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...basis, members: [...basis.members, ...basis.members] }).success).toBe(false);
        expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...basis, images: [...basis.images, ...basis.images] }).success).toBe(false);
    });
    it('retains each runtime projection under the same approval and rejects missing, reordered or substituted installations', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened fixture content');
        const members = [{ machineId: 'machine-a', installationId: 'installation-a' },
            { machineId: 'machine-b', installationId: 'installation-b' }];
        const projection = { manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'app',
            toolVersion: '2.39.4', services: ['app'], profiles: [] };
        const runtimeProjections = members.map((member, index) => ({ ...member, ...projection, platform: 'linux/amd64',
            toolVersion: index ? '2.40.0' : projection.toolVersion }));
        const basis = { v: 1, environmentId: receipt.environmentId, environmentRevision: 1,
            targetLinkId: receipt.targetLinkId, targetLinkRevision: 1, sourceIntent: receipt.content.v.sourceIntent,
            ...projection, members, bindings: [], images: receipt.content.v.images, runtimeProjections, buildServices: ['app'] };
        expect(OwnServerDeploymentInputBasisV1Schema.parse(basis)).toEqual(basis);
        const servicePlatforms = [{ service: 'app', platform: 'linux/arm64' }, { service: 'worker', platform: 'linux/amd64' }];
        const reviewed = { ...basis, services: ['app', 'worker'], servicePlatforms,
            runtimeProjections: runtimeProjections.map(value => ({ ...value, services: ['app', 'worker'], servicePlatforms })) };
        expect(OwnServerDeploymentInputBasisV1Schema.parse(reviewed)).toEqual(reviewed);
        for (const invalid of [[], servicePlatforms.slice(0, 1), [...servicePlatforms].reverse(),
            [servicePlatforms[0], servicePlatforms[0]], [servicePlatforms[0], { service: 'unselected', platform: 'linux/amd64' }]]) {
            expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...reviewed, servicePlatforms: invalid }).success).toBe(false);
            expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...reviewed,
                runtimeProjections: [{ ...reviewed.runtimeProjections[0], servicePlatforms: invalid }, reviewed.runtimeProjections[1]] }).success).toBe(false);
        }
        expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...basis, buildServices: ['app', 'app'] }).success).toBe(false);
        for (const invalid of [[], runtimeProjections.slice(0, 1), [...runtimeProjections].reverse(),
            [runtimeProjections[0], runtimeProjections[0]], [runtimeProjections[0], { ...runtimeProjections[1], installationId: 'retired' }],
            [{ ...runtimeProjections[0], interpolatedModel: {} }, runtimeProjections[1]]]) {
            expect(OwnServerDeploymentInputBasisV1Schema.safeParse({ ...basis, runtimeProjections: invalid }).success).toBe(false);
        }
    });
});
