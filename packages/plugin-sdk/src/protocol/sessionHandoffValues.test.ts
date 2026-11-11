import { describe, expect, expectTypeOf, it } from 'vitest';
import { SessionTargetV1Schema as canonicalTarget, ActionSessionAddressV1Schema as canonicalAddress, SessionTargetV1ProtocolSchema, ActionSessionAddressV1ProtocolSchema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionOperationActionInputSchemasV1, ActionOperationAddressV1ProtocolSchema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { ActionOperationGetV1ResponseSchema, ActionOperationGetV1ResponseProtocolSchema as canonicalOperationResponse, type ActionOperationGetV1Response } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { SessionMessageSendResultV1Schema as canonicalSend, SessionMessageSendResultV1ProtocolSchema as canonicalSendProjection } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { WorkspaceAddressV1ProtocolSchema, SessionAcceptedWorkspaceV1Schema as canonicalAcceptedWorkspace, SessionAcceptedWorkspaceV1ProtocolSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SessionStatusActionResultV1Schema as canonicalSessionStatus, SessionStatusActionResultV1ProtocolSchema } from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/listResult';
import { BackendTargetKeyV2Schema, BackendTargetKeyV2ProtocolSchema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ComposerAttachmentAuthorValueV1Schema, ComposerAttachmentAuthorValueV1ProtocolSchema, MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { PluginActionInputById, PluginActionResultById } from '../actions/index.js';
import type { ProtocolJsonValue } from './index.public.js';
import { ActionSessionAddressV1Schema, SessionMessageSendResultV1ProtocolSchema, SessionTargetV1Schema, SessionAcceptedWorkspaceV1Schema, SessionStatusActionResultV1Schema, PluginSessionInputAttachmentsV1ProtocolSchema } from '../sessions/index.public.js';
import { defineProtocolObject, embedProtocolJsonSchema, ProtocolWorkspaceAddressV1Schema, ProjectExecutionOperationRefV1ProtocolSchema, ProtocolComposerAttachmentAuthorValueV1Schema, ActionOperationGetV1ResponseProtocolSchema } from './index.public.js';
import { AgentExecutionTargetV1Schema, AgentTargetKeyV2Schema, buildAgentTargetKeyV2 } from '../agents/index.public.js';

describe('canonical values composed by Session handoffs', () => {
    it('reads the accepted checkout proof from the canonical status response without inventing absent authority', () => {
        const session = projectSessionSummaryV1({
            row: { id: 'session', createdAt: 1, updatedAt: 2, active: true, activeAt: 2 },
            metadata: null, encryption: null,
        });
        const acceptedWorkspace = canonicalAcceptedWorkspace.parse({
            checkout: { serverId: 'home', workspaceId: 'checkout', machineId: 'source-machine', rootPath: '/repo' },
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
        });
        const status = canonicalSessionStatus.parse({ session, acceptedWorkspace });
        if (!('session' in status)) throw new Error('Canonical status did not retain the admitted Session');
        expect(SessionAcceptedWorkspaceV1Schema).toBe(SessionAcceptedWorkspaceV1ProtocolSchema);
        expect(SessionStatusActionResultV1Schema).toBe(SessionStatusActionResultV1ProtocolSchema);
        expect(SessionStatusActionResultV1Schema.parse(status)).toEqual(status);
        expect(SessionAcceptedWorkspaceV1Schema.parse(status.acceptedWorkspace)).toEqual(acceptedWorkspace);
        expect(SessionStatusActionResultV1Schema.parse({ session })).not.toHaveProperty('acceptedWorkspace');
        expect(SessionStatusActionResultV1Schema.parse({ ok: false, code: 'session_not_found' })).toEqual({ ok: false, code: 'session_not_found' });
        for (const invalid of [
            { ...acceptedWorkspace, scope: 'all' },
            { ...acceptedWorkspace, checkout: { ...acceptedWorkspace.checkout, accountId: 'other' } },
            { ...acceptedWorkspace, repository: { ...acceptedWorkspace.repository, token: 'untrusted' } },
            { checkout: { machineId: 'source-machine', rootPath: '/repo' } },
        ]) {
            expect(SessionAcceptedWorkspaceV1Schema.safeParse(invalid).success).toBe(false);
            expect(SessionStatusActionResultV1Schema.safeParse({ session, acceptedWorkspace: invalid }).success).toBe(false);
        }
        const input = defineProtocolObject({ acceptedWorkspace: SessionAcceptedWorkspaceV1Schema }, { policy: 'closed' });
        const validate = compilePluginJsonSchema(input.jsonSchema);
        expect(validate({ acceptedWorkspace })).toBe(true);
        expect(validate({ acceptedWorkspace: { ...acceptedWorkspace, scope: 'all' } })).toBe(false);
    });
    it('retains metadata-only source workspace evidence independently from operation custody and incomplete observations', () => {
        const sourceWorkspace = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'source', rootPath: '/repo' };
        const address = ActionOperationActionInputSchemasV1['projects.execution.output.open'].parse({
            serverId: 'custody-home', machineId: 'custodian', operationId: 'operation',
        });
        const { operation } = ProjectCommandActionOutputV1Schema.parse({ operation: {
            version: 1, operationId: address.operationId, revision: 1, actionId: 'projects.compute.exec',
            state: 'running', scope: { accountId: 'account', machineId: address.machineId }, title: 'Run command',
            createdAt: 100, startedAt: 110, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'worker-home', machineId: 'worker',
                workspaceRefId: 'copy', cwd: '/copy', sourceWorkspace },
        } });
        const response = ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation });
        const schema = defineProtocolObject({ address: ProjectExecutionOperationRefV1ProtocolSchema, metadata: ActionOperationGetV1ResponseProtocolSchema }, { policy: 'closed' });
        expect(ActionOperationGetV1ResponseProtocolSchema).toBe(canonicalOperationResponse);
        expect(schema.parse({ address, metadata: response })).toEqual({ address, metadata: response });
        if (response.kind !== 'found' || response.operation.domainRef?.kind !== 'projectCommand') throw new Error('Project producer did not retain its source');
        expect(response.operation.domainRef.sourceWorkspace).toEqual(sourceWorkspace);
        expect(response.operation.scope.machineId).not.toBe(sourceWorkspace.machineId);
        expect(ActionOperationGetV1ResponseProtocolSchema.parse({ kind: 'not_found' })).toEqual({ kind: 'not_found' });
        const { sourceWorkspace: _source, ...unprovenSource } = response.operation.domainRef;
        const incomplete = ActionOperationGetV1ResponseProtocolSchema.parse({ ...response, operation: { ...operation, domainRef: unprovenSource } });
        expect(incomplete.kind === 'found' && incomplete.operation.domainRef).not.toHaveProperty('sourceWorkspace');
        expect(ActionOperationGetV1ResponseProtocolSchema.safeParse({ kind: 'found' }).success).toBe(false);
        expect(ActionOperationGetV1ResponseProtocolSchema.safeParse({ ...response, output: 'terminal body' }).success).toBe(false);
        const validate = compilePluginJsonSchema(schema.jsonSchema);
        expect(validate({ address, metadata: response })).toBe(true);
        expect(validate({ address, metadata: { ...response, output: 'terminal body' } })).toBe(false);
        expectTypeOf(ActionOperationGetV1ResponseProtocolSchema.parse(response)).toEqualTypeOf<ActionOperationGetV1Response>();
    });
    it('composes exact Agent selections without losing configured definition identity', () => {
        const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' };
        const input = defineProtocolObject({ agentTarget: AgentExecutionTargetV1Schema }, { policy: 'closed' });
        expect(input.parse({ agentTarget })).toEqual({ agentTarget });
        expect(input.safeParse({ agentTarget: { ...agentTarget, definitionId: undefined } }).success).toBe(false);
        expect(input.safeParse({ agentTarget: { ...agentTarget, command: 'untrusted' } }).success).toBe(false);
        expect(compilePluginJsonSchema(input.jsonSchema)({ agentTarget })).toBe(true);
    });
    it('preflights ordinary authored attachments through the exact composer value budget', () => {
        const value = ComposerAttachmentAuthorValueV1Schema.parse({
            key: 'selected-evidence', value: 'x'.repeat(MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1 - 2),
            presentation: { label: 'Selected evidence' },
        });
        expect(ProtocolComposerAttachmentAuthorValueV1Schema).toBe(ComposerAttachmentAuthorValueV1ProtocolSchema);
        const schema = defineProtocolObject({ attachment: ProtocolComposerAttachmentAuthorValueV1Schema }, { policy: 'closed' });
        expect(schema.parse({ attachment: value }).attachment).toEqual(value);
        expect(schema.safeParse({ attachment: { ...value, value: `${value.value}x` } }).success).toBe(false);
        expect(schema.safeParse({ attachment: { ...value, content: {} } }).success).toBe(false);
        expect(schema.safeParse({ attachment: { ...value, presentation: { ...value.presentation, authority: 'trusted' } } }).success).toBe(false);
        const validate = compilePluginJsonSchema(schema.jsonSchema);
        expect(validate({ attachment: value })).toBe(true);
        expect(validate({ attachment: { ...value, content: {} } })).toBe(false);
    });
    it('embeds delegated Session attachment authorship without admitting qualified or over-budget author values', () => {
        const attachment = { attachmentLocalId: 'entry', value: { key: 'entry', value: { entryId: '12' }, presentation: { label: 'PR' } } };
        const payload = defineProtocolObject({ attachments: PluginSessionInputAttachmentsV1ProtocolSchema }, { policy: 'closed' });
        const schema = { type: 'object' as const, properties: { payload: embedProtocolJsonSchema(payload.jsonSchema, ['properties', 'payload']) }, required: ['payload'], additionalProperties: false };
        const validate = compilePluginJsonSchema(schema);
        expect(validate({ payload: { attachments: [attachment] } })).toBe(true);
        for (const invalid of [[], [{ ...attachment, pluginId: 'happier.triage' }], [{ ...attachment,
            value: { ...attachment.value, value: 'x'.repeat(MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1) } }]]) {
            expect(PluginSessionInputAttachmentsV1ProtocolSchema.safeParse(invalid).success).toBe(false);
        }
        expectTypeOf(PluginSessionInputAttachmentsV1ProtocolSchema.parse([attachment]))
            .toMatchTypeOf<NonNullable<Extract<PluginActionInputById['session.message.send'], { message: string }>['attachments']>>();
    });
    it('composes canonical Agent target keys while leaving target availability with the catalog', () => {
        const targetKey = buildAgentTargetKeyV2({ kind: 'agent', identity: { pluginId: 'example.agent', localId: 'assistant' } });
        const schema = defineProtocolObject({ targetKey: AgentTargetKeyV2Schema }, { policy: 'closed' });
        expect(AgentTargetKeyV2Schema).toBe(BackendTargetKeyV2ProtocolSchema);
        expect(schema.parse({ targetKey })).toEqual({ targetKey: BackendTargetKeyV2Schema.parse(targetKey) });
        for (const invalid of ['', 'agent:missing-qualification', 'agent:example.agent/assistant:definition:%zz', 1]) {
            expect(AgentTargetKeyV2Schema.safeParse(invalid).success).toBe(false);
        }
        const validate = compilePluginJsonSchema(schema.jsonSchema);
        expect(validate({ targetKey })).toBe(true);
        expect(validate({ targetKey: 1 })).toBe(false);
        expect(validate({ targetKey, selectedMachine: 'machine' })).toBe(false);
    });
    it('composes the same admitted target and exact destination without granting selector authority to addresses', () => {
        expect(SessionTargetV1Schema).toBe(SessionTargetV1ProtocolSchema);
        expect(ActionSessionAddressV1Schema).toBe(ActionSessionAddressV1ProtocolSchema);
        const input = defineProtocolObject({ target: SessionTargetV1Schema, destination: ActionSessionAddressV1Schema }, { policy: 'closed' });
        const destination = canonicalAddress.parse({ serverId: 'home', sessionId: 'session' });
        const target = canonicalTarget.parse({ selector: 'workers', of: 'session', recursive: true });
        if (typeof target === 'string') throw new Error('Expected the canonical recursive worker selector');
        expect(input.parse({ target, destination })).toEqual({ target, destination });
        expect(input.parse({ target: ' session ', destination }).target).toBe('session');
        for (const invalid of [{ ...target, unexpected: true }, { selector: 'unknown' }]) {
            expect(input.safeParse({ target: invalid, destination }).success).toBe(false);
        }
        expect(input.safeParse({ target, destination: { ...destination, selector: 'self' } }).success).toBe(false);
        const validate = compilePluginJsonSchema(input.jsonSchema);
        expect(validate({ target, destination })).toBe(true);
        expect(validate({ target, destination: { ...destination, selector: 'self' } })).toBe(false);
    });

    it('retains the qualified workspace and operation producer contracts when embedded in feature input', () => {
        expect(ProtocolWorkspaceAddressV1Schema).toBe(WorkspaceAddressV1ProtocolSchema);
        expect(ProjectExecutionOperationRefV1ProtocolSchema).toBe(ActionOperationAddressV1ProtocolSchema);
        const workspace = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.compute.exec'].parse({
            workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' },
            executable: 'tool', argv: [], cwd: '/repo',
        }).workspace;
        const operation = ActionOperationActionInputSchemasV1['projects.execution.output.open'].parse({
            serverId: 'home', machineId: 'machine', operationId: 'operation',
        });
        const input = defineProtocolObject({ workspace: ProtocolWorkspaceAddressV1Schema, operation: ProjectExecutionOperationRefV1ProtocolSchema }, { policy: 'closed' });
        expect(input.parse({ workspace, operation })).toEqual({ workspace, operation });
        expect(input.safeParse({ workspace: { ...workspace, repository: 'other' }, operation }).success).toBe(false);
        expect(input.safeParse({ workspace, operation: { operationId: 'operation' } }).success).toBe(false);
        expect(input.safeParse({ workspace, operation: { ...operation, sessionId: 'session' } }).success).toBe(false);
        const validate = compilePluginJsonSchema(input.jsonSchema);
        expect(validate({ workspace, operation })).toBe(true);
        expect(validate({ workspace, operation: { ...operation, sessionId: 'session' } })).toBe(false);
        expectTypeOf(ProtocolWorkspaceAddressV1Schema.parse(workspace)).toEqualTypeOf<PluginActionInputById['projects.compute.exec']['workspace']>();
        expectTypeOf(ProjectExecutionOperationRefV1ProtocolSchema.parse(operation)).toEqualTypeOf<PluginActionInputById['projects.execution.output.open']>();
    });

    it('embeds the complete send outcome without treating admission, a hold or uncertainty as completion', () => {
        expect(SessionMessageSendResultV1ProtocolSchema).toBe(canonicalSendProjection);
        const result = defineProtocolObject({ result: SessionMessageSendResultV1ProtocolSchema }, { policy: 'closed' });
        const sent = canonicalSend.parse({ status: 'accepted', localId: 'input' });
        const values = [sent, canonicalSend.parse({ status: 'held', localId: 'input', code: 'session_input_target_unavailable' }), canonicalSend.parse({ status: 'outcomeUnknown', localId: 'input', code: 'transport_lost' })];
        for (const value of values) expect(result.parse({ result: value }).result).toEqual(value);
        const fanout = { kind: 'fanout', results: [{ target: { serverId: 'home', sessionId: 'session' }, result: { ok: true, result: sent } }] };
        expect(result.parse({ result: fanout }).result).toEqual(fanout);
        const failedFanout = { kind: 'fanout', results: [{ target: { serverId: 'home', sessionId: 'session' },
            result: ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'unavailable', error: 'unavailable',
                details: { opaque: [null, false, 7, { nativeCode: 'unavailable' }] } }) }] };
        expect(result.parse({ result: failedFanout }).result).toEqual(failedFanout);
        expect(result.safeParse({ result: { ...failedFanout, results: [{ ...failedFanout.results[0],
            result: { ...failedFanout.results[0].result, details: { nativeValue: new Date(0) } } }] } }).success).toBe(false);
        expect(result.safeParse({ result: { ...sent, completed: true } }).success).toBe(false);
        expect(result.safeParse({ result: { ...fanout, results: [{ ...fanout.results[0], target: { ...fanout.results[0].target, selector: 'self' } }] } }).success).toBe(false);
        const validate = compilePluginJsonSchema(result.jsonSchema);
        expect(validate({ result: fanout })).toBe(true);
        expect(validate({ result: { ...sent, completed: true } })).toBe(false);
        expectTypeOf(SessionMessageSendResultV1ProtocolSchema.parse(sent)).toEqualTypeOf<ReturnType<typeof canonicalSendProjection.parse>>();
        expectTypeOf(SessionMessageSendResultV1ProtocolSchema.parse(failedFanout)).toMatchTypeOf<ProtocolJsonValue>();
    });
});
