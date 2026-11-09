import { describe, expect, expectTypeOf, it } from 'vitest';
import { WorkspaceAddressV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { WorkspaceWorkerPreferenceSetInputV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { PROJECT_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { EnvVarRequirementSchema, type EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';

import {
    defineProtocolObject,
    ProtocolProjectComputeExecResultV1Schema,
    ProtocolProjectDefinitionInspectOutputSchema,
    ProtocolSecretReferenceOverlayV1Schema,
    ProtocolWorkspaceAddressV1Schema,
    ProtocolWorkspaceExecutionConfigAddressV1Schema,
    ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema,
    ProtocolWorkspaceWorkerPreferenceReadResultV1Schema,
    ProtocolWorkspaceWorkerPreferenceSetInputV1Schema,
    ProtocolActionApprovalRequestCreatedResultSchema,
    defineProtocolUnion,
    ProtocolEnvVarRequirementV1Schema,
    type ProtocolJsonValue,
} from './index.public.js';

describe('Project execution values embedded in plugin protocols', () => {
    it('uses the requirement owner defaults and name grammar without admitting secret values', () => {
        const schema = defineProtocolObject({ requirement: ProtocolEnvVarRequirementV1Schema }, { policy: 'closed' });
        for (const input of [{ name: 'WORKFLOW_TOKEN' }, { name: 'OPTIONAL_TOKEN', kind: 'secret', required: false }, { name: 'CONFIG', kind: 'config' }]) {
            expect(schema.parse({ requirement: input }).requirement).toEqual(EnvVarRequirementSchema.parse(input));
        }
        expect(schema.parse({ requirement: { name: 'WORKFLOW_TOKEN' } }).requirement).toEqual({
            name: 'WORKFLOW_TOKEN', kind: 'secret', required: true,
        });
        for (const input of [{ name: 'lowercase' }, { name: 'TOKEN', value: 'raw-secret' }, { name: 'TOKEN', kind: 'ambient' }]) {
            expect(schema.safeParse({ requirement: input }).success).toBe(false);
        }
        expectTypeOf(ProtocolEnvVarRequirementV1Schema.parse({ name: 'TOKEN' })).toEqualTypeOf<EnvVarRequirement>();
    });

    it('preserves a canonical deferred approval beside a domain result without claiming launch', () => {
        const approval = ActionApprovalRequestCreatedResultSchema.parse({
            kind: 'approval_request_created', artifactId: 'approval', actionId: 'projects.compute.exec',
        });
        const result = defineProtocolUnion([
            ProtocolProjectComputeExecResultV1Schema,
            ProtocolActionApprovalRequestCreatedResultSchema,
        ]);
        expect(result.parse(approval)).toEqual(approval);
        expect(ProtocolProjectComputeExecResultV1Schema.safeParse(approval).success).toBe(false);
        expect(result.safeParse({ kind: 'approval_request_created' }).success).toBe(false);
        expect(result.safeParse({ ...approval, accepted: true }).success).toBe(false);
    });

    it('retains canonical checkout normalization and value-free secret admission when composed', () => {
        const schema = defineProtocolObject({
            workspace: ProtocolWorkspaceAddressV1Schema,
            environmentBindings: ProtocolSecretReferenceOverlayV1Schema.optional(),
        }, { policy: 'closed' });
        const workspace = { serverId: ' home ', workspaceId: ' checkout ', machineId: ' primary ', rootPath: ' /repo ' };
        const environmentBindings = { v: 1, bindings: { TOKEN: { ref: 'happier:shared-secret:v1:token', revision: 2 } } };
        expect(schema.parse({ workspace, environmentBindings })).toEqual({
            workspace: WorkspaceAddressV1Schema.parse(workspace),
            environmentBindings: SecretReferenceOverlayV1Schema.parse(environmentBindings),
        });
        expect(schema.safeParse({ workspace: { ...workspace, workerMachineId: 'other' } }).success).toBe(false);
        for (const binding of [
            { ref: 'happier:shared-secret:v1:token' },
            { ref: 'personal-token', revision: 2 },
            { ref: 'personal-token', value: 'raw-secret' },
        ]) {
            expect(schema.safeParse({ workspace, environmentBindings: { v: 1, bindings: { TOKEN: binding } } }).success).toBe(false);
        }
    });

    it('keeps preference addresses and semantic mutation outcomes distinct from permission', () => {
        const preference = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } as const;
        const workspace = { serverId: 'home', refId: 'checkout' };
        const input = { workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next: { ...preference, allowAdHoc: true } };
        expect(ProtocolWorkspaceWorkerPreferenceSetInputV1Schema.parse(input)).toEqual(WorkspaceWorkerPreferenceSetInputV1Schema.parse(input));
        expect(ProtocolWorkspaceWorkerPreferenceSetInputV1Schema.safeParse({ ...input, next: { ...input.next, services: {} } }).success).toBe(false);
        expect(ProtocolWorkspaceExecutionConfigAddressV1Schema.parse(workspace)).toEqual(workspace);
        expect(ProtocolWorkspaceExecutionConfigAddressV1Schema.safeParse({ serverId: 'home', workspaceId: 'checkout' }).success).toBe(false);
        const response = defineProtocolObject({
            workspace: ProtocolWorkspaceExecutionConfigAddressV1Schema,
            observation: ProtocolWorkspaceWorkerPreferenceReadResultV1Schema,
        }, { policy: 'closed' });
        for (const status of ['locked', 'invalid', 'unavailable'] as const) {
            expect(response.parse({ workspace, observation: { status } }).observation).toEqual({ status });
            expect(response.safeParse({ workspace, observation: { status, preference } }).success).toBe(false);
        }
        const ready = { status: 'ready', preference, provenance: 'default', revision: 'absent' };
        expect(response.parse({ workspace, observation: ready }).observation).toEqual(ready);
        expect(ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema.parse({ status: 'outcomeUnknown' })).toEqual({ status: 'outcomeUnknown' });
        expect(ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema.safeParse({ status: 'applied' }).success).toBe(false);
        expect(ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema.parse({ ...ready, status: 'conflict' })).toEqual({ ...ready, status: 'conflict' });
    });

    it('composes real Project inspection and finite setup-hold results without inventing launch evidence', () => {
        const inspection = ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
            importCandidates: [],
        });
        const response = defineProtocolObject({ project: ProtocolProjectDefinitionInspectOutputSchema }, { policy: 'closed' });
        expect(response.parse({ project: inspection }).project).toEqual(inspection);
        expect(response.safeParse({ project: { ...inspection, launched: true } }).success).toBe(false);
        const hold = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.compute.exec'].parse({
            kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed-effect',
        });
        expect(ProtocolProjectComputeExecResultV1Schema.parse(hold)).toEqual(hold);
        expectTypeOf<ReturnType<typeof ProtocolProjectComputeExecResultV1Schema.parse>>().toMatchTypeOf<ProtocolJsonValue>();
        expect(ProtocolProjectComputeExecResultV1Schema.safeParse({ kind: 'success' }).success).toBe(false);
    });
});
