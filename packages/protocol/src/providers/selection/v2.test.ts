import { describe, expect, it } from 'vitest';

import {
  createSessionActiveModelSelection,
  SessionActiveModelSelectionSchema,
  SessionModelSelectionV2Schema,
  projectSessionModelSelectionV2ToV1,
  sessionModelSelectionV2TeamBindingIntent,
} from './v2.js';
import { readExactSessionActiveModelSelection, readExactSessionActiveModelSelectionV1 } from './activeSelectionValidationV1.js';
import { SessionActiveModelSelectionV1Schema } from './v1.js';
import { SessionOwnerMetadataV1Schema, createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '../../sessions/metadata/sessionMetadataSchemasV1.js';

describe('SessionModelSelectionV2', () => {
  it('retains native references only on the native Team route and carries accepted source comparisons', () => {
    const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller', guestInstallationId: 'guest',
      bindingKey: 'binding', placeholderRef: 'reference', sourceRevision: 'source:1', providerTicket: 'a'.repeat(43) };
    const input = { v: 2, updatedAt: 1, ref: { source: 'team_resource', resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 0, deliveryMode: 'vendor-native', agentTargetKey: 'backend:codex', modelId: 'model', nativeDelivery } };
    const selection = SessionModelSelectionV2Schema.parse(input);
    expect(sessionModelSelectionV2TeamBindingIntent(selection, {
      application: { agentTargetKey: 'backend:codex', implementationIdentity: { pluginId: 'example.gateway', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' }, executionMachineId: 'guest-machine',
      nativeSource: { sourceRevision: 'source:1', providerTicket: nativeDelivery.providerTicket },
    })).toMatchObject({ nativeDelivery, providerModelSelection: { agentTargetKey: 'backend:codex', modelId: 'model',
      executionMachineId: 'guest-machine', nativeSource: { sourceRevision: 'source:1', providerTicket: nativeDelivery.providerTicket } } });
    expect(SessionModelSelectionV2Schema.safeParse({ ...input, ref: { ...input.ref, deliveryMode: 'brokered' } }).success).toBe(false);
    expect(SessionModelSelectionV2Schema.safeParse({ ...input, ref: { ...input.ref,
      nativeDelivery: { ...nativeDelivery, placeholder: 'private-value' } } }).success).toBe(false);
  });

  it('keeps accepted Team source proof closed, runner-bound and distinct from V1 native proof', () => {
    const teamCredentialModel = { kind: 'team_credential_provider_model' as const, teamId: 'team', resourceId: 'resource',
      expectedResourceRevision: 0, deliveryMode: 'brokered' as const, agentTargetKey: 'backend:codex', modelId: 'shared-model' };
    const input = { selection: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'shared-model' },
      source: 'runtime_apply' as const, runner: { pid: 42, processStartTimeMs: 1 }, teamCredentialModel };
    const fact = createSessionActiveModelSelection(input);
    expect(fact).toMatchObject({ v: 2, teamCredentialModel });
    const metadata = { sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 2, currentModelId: 'shared-model',
      availableModels: [{ id: 'shared-model', name: 'Shared model' }], activeSelectionV1: fact } };
    const params = { metadata, agentId: 'codex', agentTargetKey: 'backend:codex', currentRunnerProcessIdentity: input.runner };
    expect(readExactSessionActiveModelSelection(params)).toEqual(fact);
    expect(readExactSessionActiveModelSelectionV1(params)).toBeNull();
    expect(SessionActiveModelSelectionV1Schema.safeParse(fact).success).toBe(false);
    expect(readExactSessionActiveModelSelection({ ...params, currentRunnerProcessIdentity: { pid: 43, processStartTimeMs: 1 } })).toBeNull();
    const owner = createSessionOwnerMetadataV1({ metadata });
    expect(owner).toMatchObject({ ok: true });
    if (!owner.ok) throw new Error('Expected owner metadata');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1(metadata),
      ownerMetadata: SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata) }).sessionModelsV1?.activeSelectionV1).toEqual(fact);
    expect(SessionActiveModelSelectionSchema.safeParse({ ...fact, secret: 'unexpected' }).success).toBe(false);
    expect(createSessionActiveModelSelection({ ...input, teamCredentialModel: undefined })).toBeNull();
    expect(createSessionActiveModelSelection({ ...input, selection: { ...input.selection, modelId: 'other' } })).toBeNull();
    expect(createSessionActiveModelSelection({ ...input, teamCredentialModel: null })).toMatchObject({ v: 1, selection: input.selection });
  });

  it('represents Team credential resources without fabricating a Provider Connection', () => {
    const selection = SessionModelSelectionV2Schema.parse({
      v: 2,
      ref: {
        source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
        expectedResourceRevision: 7, deliveryMode: 'direct', agentTargetKey: 'backend:claude', modelId: 'claude-sonnet',
      },
      updatedAt: 123,
    });

    expect(selection.ref).toEqual({
      source: 'team_resource',
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      deliveryMode: 'direct',
      agentTargetKey: 'backend:claude',
      modelId: 'claude-sonnet',
    });
    expect(projectSessionModelSelectionV2ToV1(selection)).toBeNull();
    expect(sessionModelSelectionV2TeamBindingIntent(selection)).toEqual({
      v: 1,
      slot: { kind: 'provider_model' },
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      deliveryMode: 'direct',
      teamId: 'team-1',
      providerModelSelection: { agentTargetKey: 'backend:claude', modelId: 'claude-sonnet' },
    });
  });

  it('projects native and Account Provider Connection selections to the released V1 shape', () => {
    expect(projectSessionModelSelectionV2ToV1(SessionModelSelectionV2Schema.parse({
      v: 2,
      ref: { source: 'native', agentTargetKey: 'claude', modelId: 'opus' },
      updatedAt: 123,
    }))).toEqual({
      v: 1,
      ref: { agentTargetKey: 'claude', providerConnectionId: null, modelId: 'opus' },
      updatedAt: 123,
    });
    expect(projectSessionModelSelectionV2ToV1(SessionModelSelectionV2Schema.parse({
      v: 2,
      ref: {
        source: 'account_provider_connection',
        agentTargetKey: 'claude',
        providerConnectionId: 'connection-1',
        modelId: 'opus',
      },
      updatedAt: 123,
    }))).toEqual({
      v: 1,
      ref: {
        agentTargetKey: 'claude',
        providerConnectionId: 'connection-1',
        modelId: 'opus',
      },
      updatedAt: 123,
    });
  });

  it('requires an exact catalog revision when deriving a Team binding', () => {
    const selection = SessionModelSelectionV2Schema.parse({
      v: 2,
      ref: {
        source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
        expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'backend:claude', modelId: 'opus',
      },
      updatedAt: 123,
    });
    expect(sessionModelSelectionV2TeamBindingIntent(selection).expectedResourceRevision).toBe(7);
    expect(SessionModelSelectionV2Schema.safeParse({
      v: 2,
      ref: { source: 'native', agentTargetKey: 'claude', modelId: 'opus' },
      resourceRevision: 1,
      updatedAt: 123,
    }).success).toBe(false);
  });

  it('turns a non-Team selection into an explicit binding clear', () => {
    expect(sessionModelSelectionV2TeamBindingIntent(SessionModelSelectionV2Schema.parse({
      v: 2,
      ref: { source: 'native', agentTargetKey: 'agent:codex', modelId: 'gpt-5' },
      updatedAt: 1,
    }))).toEqual({ v: 1, slot: { kind: 'provider_model' }, resourceId: null });
  });
});
