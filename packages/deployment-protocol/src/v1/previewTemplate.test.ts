import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentDetailV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentHeaderV1Schema } from './environment.js';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol';
import { DeploymentEnvironmentUpdateStorageInputV1Schema } from './operations.js';

describe('P44 preview template private content', () => {
    it('retains fresh destination backup authoring without borrowing source ownership or inline credentials', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const configuration = { configRevision: 1,
            destinationRef: { pluginId: 'example.backups', localId: 'open' }, occurrenceId: 'backup-occurrence', config: {},
            credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }],
            retention: { kind: 'keepEverything' } };
        const destinationBackup = { configuration, prefix: 'previews', bindings: [
            { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
                source: { kind: 'secret', ref: 'person_selects' } },
        ] };
        const selection = { kind: 'template', templateRef: { sourceId: 'data', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, dataExportNames: ['database'], destinationBackup };
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [selection] };
        const content = { ...environment.content, previewTemplate };
        expect(DeploymentEnvironmentContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content);
        for (const invalid of [
            { ...destinationBackup, configuration: { ...configuration, ownership: { environmentId: 'source', prefix: 'source' } } },
            { ...destinationBackup, bindings: [{ ...destinationBackup.bindings[0], purpose: 'variable', name: 'PASSWORD', phase: 'runtime' }] },
            { ...destinationBackup, bindings: [{ ...destinationBackup.bindings[0], source: { kind: 'public', value: 'secret' } }] },
        ]) expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...content, previewTemplate: { ...previewTemplate,
            data: [{ ...selection, destinationBackup: invalid }] } }).success).toBe(false);
    });

    it('preserves template inventory provenance for an exact repository definition', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const definition = { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } };
        const template = { templateRef: { sourceId: 'data', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, definition, services: ['db'],
            data: [{ engine: 'postgres', service: 'db', port: 5432 }],
            volumes: [{ id: 'database-data', service: 'db', target: '/var/lib/postgresql/data', persistent: true, backup: true }] };
        const content = { ...environment.content, definition, template };
        expect(DeploymentEnvironmentContentV1Schema.parse(content)).toEqual(content);
    });
    it('retains an exact captured backup source for a fresh template without source credentials', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const selection = { kind: 'template', templateRef: { sourceId: 'data', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, dataExportNames: ['database'],
            copyFrom: { environmentId: 'source-environment', targetLinkId: 'source-target', deploymentId: 'source-deployment',
                backupOperationId: 'captured-operation', snapshotId: 'captured-backup' } };
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [selection] };
        const content = { ...environment.content, previewTemplate };
        expect(DeploymentEnvironmentContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content);
        const { backupOperationId: _operation, ...withoutOperation } = selection.copyFrom;
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...content, previewTemplate: { ...previewTemplate,
                data: [{ ...selection, copyFrom: withoutOperation }] } })).toHaveProperty('previewTemplate.data.0.copyFrom.snapshotId', 'captured-backup');
        const { snapshotId: _capture, ...withoutCapture } = selection.copyFrom;
        for (const copyFrom of [withoutCapture, { ...selection.copyFrom, snapshotId: '' },
            { ...selection.copyFrom, credentialPrincipal: { kind: 'account', accountId: 'owner' } }]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...content, previewTemplate: { ...previewTemplate,
                data: [{ ...selection, copyFrom }] } }).success).toBe(false);
        }
    });

    it('admits a preview template edit only through private content preparation before storage', () => {
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
        const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
            contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
            patch: { buildMachineId: 'builder', previewTemplate } };
        expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse(input).success).toBe(true);
        expect(DeploymentEnvironmentUpdateStorageInputV1Schema.safeParse(input).success).toBe(false);
        expect(DeploymentEnvironmentUpdateStorageInputV1Schema.safeParse({ ...input,
            patch: { buildMachineId: 'builder' } }).success).toBe(true);
        expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ ...input,
            patch: { previewTemplate: null } }).success).toBe(true);
    });
    it('preserves public defaults preview constraints in the storage projection', () => {
        const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
            contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const preview = { ...input, mode: 'preview', defaultsFor: 'backups' };
        for (const schema of [DeploymentEnvironmentUpdateInputV1Schema, DeploymentEnvironmentUpdateStorageInputV1Schema]) {
            expect(schema.safeParse(input).success).toBe(true);
            expect(schema.safeParse(preview).success).toBe(true);
            expect(schema.safeParse({ ...input, mode: 'preview' }).success).toBe(false);
            expect(schema.safeParse({ ...input, defaultsFor: 'backups' }).success).toBe(false);
            expect(schema.safeParse({ ...preview, patch: { buildMachineId: 'builder' } }).success).toBe(false);
        }
    });
    it('retains strict preview template choices in private content without admitting operational bindings or approval authority', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const repository = { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' };
        const variable = { purpose: 'variable', name: 'PUBLIC_API_ORIGIN', phase: 'runtime',
            source: { kind: 'deploymentFact', fact: 'primaryUrl' } };
        const templateRef = { sourceId: 'data', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } };
        const previewTemplate = { v: 1, enabled: false, forkPreviews: 'off', repository,
            runtimeTargetLinkId: 'template-runtime',
            domain: { domainId: 'wildcard', templateSlug: 'app', hostnamePattern: 'pr-{number}-{template-slug}' },
            bindingBlueprints: [variable], data: [{ kind: 'template', templateRef,
                dataExportNames: ['database'], connectTo: { service: 'app' } }] };
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content, previewTemplate }))
            .toEqual({ ...environment.content, previewTemplate });
        expect(DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
            previewTemplate: { ...previewTemplate, enabled: true, forkPreviews: 'approveEachCommit', domain: null, data: [] } }))
            .toHaveProperty('previewTemplate.forkPreviews', 'approveEachCommit');
        for (const invalid of [
            { ...previewTemplate, approvalMode: 'allow' },
            { ...previewTemplate, repository: { ...repository, deployment: 'not-a-deployment-url' } },
            { ...previewTemplate, forkPreviews: 'always' },
            { ...previewTemplate, bindingBlueprints: [{ purpose: 'registry', targetLinkId: 'runtime',
                registryOrigin: 'https://registry.example', access: 'pull',
                source: { kind: 'secret', ref: 'saved-secret', resourceRevision: 1 } }] },
            { ...previewTemplate, data: [{ ...previewTemplate.data[0], password: 'inline-secret' }] },
            { ...previewTemplate, domain: { ...previewTemplate.domain, reservedHostname: 'pr-1-app.example' } },
        ]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content, previewTemplate: invalid }).success).toBe(false);
        }
        expect(DeploymentEnvironmentHeaderV1Schema.safeParse({ ...environment.environment, previewTemplate }).success).toBe(false);
    });

    it('round-trips exact managed-data references and rejects incomplete or mixed data selections', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const managed = { kind: 'managed', dataTargetLinkId: 'neon', ownership: 'providerNative',
            parentBranchRef: { providerProjectId: 'project', branchId: 'parent' } };
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'gitlab', deployment: 'https://forge.example/enterprise', repository: 'group/app' },
            runtimeTargetLinkId: 'vercel', domain: null, bindingBlueprints: [], data: [managed] };
        for (const ownership of ['happierManaged', 'providerNative']) for (const displayName of [undefined, 'Production database']) {
            const content = { ...environment.content, previewTemplate: { ...previewTemplate,
                data: [{ ...managed, ownership, parentBranchRef: { ...managed.parentBranchRef,
                    ...(displayName ? { displayName } : {}) } }] } };
            expect(DeploymentEnvironmentContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content);
        }
        for (const invalid of [
            { ...managed, parentBranchRef: { branchId: 'parent' } },
            { ...managed, parentBranchRef: { ...managed.parentBranchRef, credential: 'inline-secret' } },
            { ...managed, ownership: 'external' },
            { ...managed, templateRef: { sourceId: 'catalog' } },
            { kind: 'template', templateRef: { sourceId: 'catalog' }, dataExportNames: ['database'] },
            { kind: 'arbitrary', provider: 'neon' },
        ]) expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content,
            previewTemplate: { ...previewTemplate, data: [invalid] } }).success).toBe(false);
        expect(DeploymentEnvironmentContentV1Schema.parse(environment.content)).toEqual(environment.content);
    });
});
