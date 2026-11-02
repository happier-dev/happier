import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentDetailV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentHeaderV1Schema } from './environment.js';

describe('P44 preview template private content', () => {
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
        ]) expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content, previewTemplate: invalid }).success).toBe(false);
        expect(DeploymentEnvironmentHeaderV1Schema.safeParse({ ...environment.environment, previewTemplate }).success).toBe(false);
    });

    it('round-trips exact managed-data references and rejects incomplete or mixed data selections', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const managed = { kind: 'managed', dataTargetLinkId: 'neon', ownership: 'providerNative',
            parentBranchRef: { providerProjectId: 'project', branchId: 'parent' } };
        const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'gitlab', deployment: 'https://forge.example/enterprise', repository: 'group/app' },
            runtimeTargetLinkId: 'vercel', domain: null, bindingBlueprints: [], data: [managed] };
        for (const ownership of ['happierManaged', 'providerNative']) {
            const content = { ...environment.content, previewTemplate: { ...previewTemplate,
                data: [{ ...managed, ownership }] } };
            expect(DeploymentEnvironmentContentV1Schema.parse(content)).toEqual(content);
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
