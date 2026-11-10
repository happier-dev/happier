import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import * as neon from '../../../../../packages/plugins/deployment-neon/src/index';
import { mutationResult } from '../../../../../packages/plugins/deployment-neon/src/data/schemas';
import * as supabase from '../../../../../packages/plugins/deployment-supabase/src/index';
import { createWorkflowDataPluginRuntimeFixture } from './workflowDataPluginRuntime.testkit';
import { prepareWorkflowDataCreationResultCapture, WorkflowDataCreationResultSchema, readWorkflowDataCreationResult } from './workflowDataCreationResult';

describe('Workflow data creation result projection', () => {
    let mounted: Awaited<ReturnType<typeof createWorkflowDataPluginRuntimeFixture>>;
    beforeAll(async () => {
        mounted = await createWorkflowDataPluginRuntimeFixture();
    });
    afterAll(async () => { await mounted?.dispose(); });

    const prepare = (pluginId: string) => {
        const capture = prepareWorkflowDataCreationResultCapture(`${pluginId}/actions/branches-create`, mounted.registry.contributes);
        if (!capture) throw new Error('The actual data target must declare its create/delete role pair');
        return capture;
    };

    it('retains a known partial Neon creation but excludes connection custody, audience and unrelated result fields', () => {
        // This is the actual provider's closed result parser, not a Workflow
        // dispatcher or a replacement Action declaration.
        const output = mutationResult.parse({ status: 'provisioned', ready: false,
            providerProjectId: 'project-A', branchId: 'branch-A', endpointId: 'endpoint-A',
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'project-A', providerEnvironment: 'branch-A' },
            providerEnvironment: { kind: 'custom', id: 'branch-A' },
            connectionSave: { providerProjectId: 'project-A', branchId: 'branch-A', endpointId: 'endpoint-A',
                database: 'app', role: 'owner', secretId: 'database', audience: { accountGrants: ['account-A'] },
                status: 'partial', connections: {}, incomplete: ['DATABASE_URL', 'DIRECT_URL'],
                applicationMode: 'transaction-pooler', migrationMode: 'direct' },
            rolePassword: { role: 'owner', ref: 'opaque-password-reference', resourceRevision: 1 },
        });
        const projected = prepare(neon.manifest.id)(output);
        expect(WorkflowDataCreationResultSchema.parse(projected)).toEqual({ kind: 'deployment_data_created', v: 1,
            source: { pluginId: neon.manifest.id, localId: 'database' },
            deleteAction: { pluginId: neon.manifest.id, localId: 'branches-delete' },
            providerIdentity: output.providerIdentity, providerEnvironment: output.providerEnvironment,
            operands: { branchId: 'branch-A' },
        });
    });

    it.each(['reviewed-save', 'branch-only', 'recovered'] as const)('captures the actual Neon %s creation operands for exact paired teardown', async mode => {
        const correlation = { repository: { kind: 'gitlab', deployment: 'https://gitlab.example', repository: 'group/repo' }, pullRequestId: '17' };
        const annotation = { 'happier.environment': 'environment-A', 'happier.scm.kind': 'gitlab',
            'happier.scm.deployment': 'https://gitlab.example', 'happier.scm.repository': 'group/repo', 'happier.pullRequest': '17' };
        // Neon v2 Branch and AnnotationData boundary vectors; the real Action
        // produces the result and the real paired Action validates teardown.
        const branch = { id: 'branch-preview', project_id: 'project-A', parent_id: 'branch-main', name: 'Preview 17',
            current_state: 'ready', default: false, protected: false };
        const requests: { method: string; pathname: string; body?: unknown }[] = [];
        const kit = await createPluginTestkit({ manifest: neon.manifest, module: neon, services: {
            http: createPluginHttpFixture({ async request(request) {
                const pathname = new URL(request.url).pathname;
                requests.push({ method: request.method, pathname,
                    ...(request.body ? { body: JSON.parse(new TextDecoder().decode(request.body)) } : {}) });
                if (mode === 'recovered' && request.method === 'POST') throw new Error('constructed lost response');
                const nativeAnnotation = { object: { type: 'branch', id: branch.id }, value: annotation };
                const result = request.method === 'DELETE' ? { operations: [] }
                    : pathname.endsWith('/branches') && request.method === 'GET'
                        ? { branches: [branch], annotations: { [branch.id]: nativeAnnotation } }
                        : { branch, annotation: nativeAnnotation };
                return { status: request.method === 'POST' ? 201 : 200, headers: {},
                    body: new TextEncoder().encode(JSON.stringify(result)) };
            } }),
        } });
        const credentialRef = { service: { pluginId: neon.manifest.id, localId: 'neon' }, accountId: 'connected-A' };
        const input = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home',
            environmentId: 'environment-A', expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
            credentialRef, credentialPrincipal: { kind: 'account', accountId: 'account-A',
                purpose: { consumer: { pluginId: neon.manifest.id, localId: 'projects-link' }, purpose: 'deploy-manage' },
                target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'project-A', providerEnvironment: 'branch-main' },
            providerEnvironment: { kind: 'custom', id: 'branch-main' } });
        try {
            const output = await kit.invokeAction('branches-create', { ...input, name: branch.name, correlation, initialization: 'parent-schema',
                ...(mode === 'reviewed-save' ? { id: 'database', purpose: 'data.connection', database: 'app', role: 'owner', audience: { accountGrants: ['account-A'] },
                    labels: { DATABASE_URL: 'Application database', DIRECT_URL: 'Migration database' }, rolePasswordLabel: 'Generated password' } : {}) });
            const captured = WorkflowDataCreationResultSchema.parse(prepare(neon.manifest.id)(output));
            expect(captured.operands).toEqual({ branchId: branch.id, correlation });
            expect(await kit.invokeAction(captured.deleteAction.localId, { ...input,
                providerIdentity: captured.providerIdentity, providerEnvironment: captured.providerEnvironment, ...captured.operands }))
                .toMatchObject({ status: 'deleted', branchId: branch.id, ready: true });
            expect(requests[0]?.body).toEqual({ branch: { name: branch.name, parent_id: 'branch-main', init_source: 'parent-schema' },
                endpoints: [{ type: 'read_write' }], annotation_value: annotation });
            expect(requests.filter(request => request.method === 'DELETE').map(request => request.pathname))
                .toEqual(['/api/v2/projects/project-A/branches/branch-preview']);
        } finally { await kit.dispose(); }
    });

    it('retains the Supabase child project ref rather than its unrelated branch UUID', async () => {
        const requests: string[] = [];
        const kit = await createPluginTestkit({ manifest: supabase.manifest, module: supabase, services: {
            // Only the third-party provider HTTP boundary is replaced.
            http: createPluginHttpFixture({ async request(request) {
                requests.push(`${request.method} ${new URL(request.url).pathname}`);
                return { status: 201, headers: {}, body: new TextEncoder().encode(JSON.stringify({
                    id: 'e242cf8e-9562-4e0b-9082-a10ae56879c6', project_ref: 'child-project-A',
                    parent_project_ref: 'parent-project-A', name: 'Preview', persistent: false, status: 'CREATING',
                })) };
            } }),
        } });
        const credentialRef = { service: { pluginId: supabase.manifest.id, localId: 'supabase' }, accountId: 'connected-A' };
        try {
            const output = await kit.invokeAction('branches-create', { v: 1, serverId: 'home',
                environmentId: 'environment-A', expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
                credentialRef, credentialPrincipal: { kind: 'account', accountId: 'account-A',
                    purpose: { consumer: { pluginId: supabase.manifest.id, localId: 'projects-link' }, purpose: 'deploy-manage' },
                    target: { kind: 'account', account: credentialRef } },
                providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'parent-project-A' },
                providerEnvironment: { kind: 'custom', id: 'parent-project-A' }, name: 'Preview', withData: false,
            });
            expect(output).toMatchObject({ status: 'provisioned', ready: false, branchId: 'e242cf8e-9562-4e0b-9082-a10ae56879c6' });
            expect(WorkflowDataCreationResultSchema.parse(prepare(supabase.manifest.id)(output))).toEqual({
                kind: 'deployment_data_created', v: 1,
                source: { pluginId: supabase.manifest.id, localId: 'database' },
                deleteAction: { pluginId: supabase.manifest.id, localId: 'branches-delete' },
                providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'child-project-A' },
                providerEnvironment: { kind: 'custom', id: 'child-project-A' }, operands: {},
            });
            expect(requests).toEqual(['POST /v1/projects/parent-project-A/branches']);
        } finally { await kit.dispose(); }
    });

    it('reads exact authenticated invocation custody and rejects substituted references or Actions', () => {
        const credentialRef = { service: { pluginId: supabase.manifest.id, localId: 'supabase' }, accountId: 'connected-A' };
        const input = { v: 1, serverId: 'home', environmentId: 'environment-A', expectedRevision: 1,
            targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
            credentialPrincipal: { kind: 'account', accountId: 'account-A',
                purpose: { consumer: { pluginId: supabase.manifest.id, localId: 'projects-link' }, purpose: 'deploy-manage' },
                target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-A', providerEnvironment: 'parent-A' },
            providerEnvironment: { kind: 'custom', id: 'parent-A' }, name: 'Preview', withData: false };
        const output = { kind: 'deployment_data_created', v: 1, source: { pluginId: supabase.manifest.id, localId: 'database' },
            deleteAction: { pluginId: supabase.manifest.id, localId: 'branches-delete' }, operands: {},
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-A', providerEnvironment: 'child-A' },
            providerEnvironment: { kind: 'custom', id: 'child-A' } };
        const opened = { invocation: { index: { id: 'invocation-A', runId: 'run-A', sequence: '0', parentRecordId: null,
            memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
            createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z' },
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'create', scope: [] },
                blockKind: 'action', attempt: '0', logicalInvocationRecordId: 'invocation-A', execution: {
                    kind: 'action', actionId: 'action.invoke', actionRequestId: 'request-A', localInputId: 'local-A',
                    input: { action: { pluginId: supabase.manifest.id, localId: 'branches-create' }, input }, output } }, parentRevision: 1 } };
        const reference = { runId: 'run-A', invocationId: 'invocation-A' };
        expect(readWorkflowDataCreationResult(opened, reference)).toMatchObject({
            input: { credentialRef, credentialPrincipal: input.credentialPrincipal }, result: { providerEnvironment: { kind: 'custom', id: 'child-A' } } });
        expect(() => readWorkflowDataCreationResult(opened, { ...reference, invocationId: 'invocation-B' })).toThrow();
        expect(() => readWorkflowDataCreationResult({ ...opened, invocation: { ...opened.invocation,
            progress: { ...opened.invocation.progress, execution: { ...opened.invocation.progress.execution,
                input: { ...opened.invocation.progress.execution.input, action: { pluginId: 'other-person.plugin', localId: 'branches-create' } } } } } }, reference)).toThrow();
    });

    it('does not invent ownership from an unknown outcome or retain unrelated Action results', () => {
        const capture = prepare(neon.manifest.id);
        const unknown = mutationResult.parse({ status: 'outcome_unknown', providerProjectId: 'project-A', branchId: 'branch-A',
            correlation: { repository: { kind: 'gitlab', deployment: 'https://gitlab.example', repository: 'group/repo' }, pullRequestId: '17' },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'project-A', providerEnvironment: 'branch-A' },
            providerEnvironment: { kind: 'custom', id: 'branch-A' } });
        expect(capture(unknown)).toBeUndefined();
        expect(capture(mutationResult.parse({ status: 'provisioned', branchId: 'branch-A' }))).toBeUndefined();
        expect(prepareWorkflowDataCreationResultCapture(`${neon.manifest.id}/actions/projects-provision`, mounted.registry.contributes)).toBeUndefined();
        expect(prepareWorkflowDataCreationResultCapture('happier.channels/actions/conversation/start-v1', mounted.registry.contributes)).toBeUndefined();
    });
});
