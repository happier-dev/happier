import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
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
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'project-A', providerEnvironment: 'branch-A' },
            providerEnvironment: { kind: 'custom', id: 'branch-A' } });
        expect(capture(unknown)).toBeUndefined();
        expect(capture(mutationResult.parse({ status: 'provisioned', branchId: 'branch-A' }))).toBeUndefined();
        expect(prepareWorkflowDataCreationResultCapture(`${neon.manifest.id}/actions/projects-provision`, mounted.registry.contributes)).toBeUndefined();
        expect(prepareWorkflowDataCreationResultCapture('happier.channels/actions/conversation/start-v1', mounted.registry.contributes)).toBeUndefined();
    });
});
