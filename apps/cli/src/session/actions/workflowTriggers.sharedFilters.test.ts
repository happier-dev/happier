import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionAutomationPrivateMatchingV1 } from '@happier-dev/protocol/actions/executor/actionAutomationPrivateMatching';
import { AutomationActionTriggerSchema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { openAutomationTriggerDefinitionStoredEnvelopeV1, AutomationTriggerDefinitionStoredPayloadV1Schema, AutomationTriggerDefinitionBindingV1Schema } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, getRandomBytes } from '@/api/encryption';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('evaluates a shared filtered check with the Workflow recipient codec (%s)', async mode => {
  const credentials = (seed: number) => {
    const machineKey = new Uint8Array(32).fill(seed);
    return { token: String(seed), encryption: { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
  };
  const author = credentials(41);
  const actor = credentials(42);
  const resource = await createResourceDataKey({ credentials: author, mode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const artifactId = '11111111-1111-4111-8111-111111111111';
  const stored = { id: artifactId, ownerAccountId: 'author', access: 'view', publicAudience: 'none', encryptionMode: mode,
    header: encode({ kind: 'workflow-definition.v1' }), body: encode({ body: '{}' }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  // HTTP is the real Artifact storage/key-delivery boundary; all crypto and matching stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
    const recipient = config?.headers?.Authorization === `Bearer ${actor.token}` ? actor : author;
    return { status: 200, data: { ...stored, access: recipient === author ? 'owner' : 'view',
      dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
        : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: resource.dataKey,
          recipientPublicKey: recipient.encryption.publicKey, randomBytes: getRandomBytes })) } };
  });
  const authorStore = createAccountArtifactStore({ credentials: author, getAccountEncryptionMode: async () => mode });
  const actorStore = createAccountArtifactStore({ credentials: actor, getAccountEncryptionMode: async () => mode });
  const readOptions = { prepareRecipients: false, includeSharedAudience: false };
  const authored = await authorStore.readForUpdate(artifactId, readOptions);
  if (!authored) throw new Error('Workflow author content unavailable');
  const binding = { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
  const triggerBinding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: 'source', triggerId: 'source-trigger', triggerRevision: 1, triggerKind: 'action' });
  const definition = AutomationActionTriggerSchema.parse({ kind: 'action', phase: 'after', actionIds: ['notifications.notify_me'],
    filter: { v: 1, all: [{ field: '/requestId', op: 'eq', value: 'private-filter-match' }] } });
  const sharedDefinitionEnvelope = authored.sealAssociatedContent({ ...binding,
    value: AutomationTriggerDefinitionStoredPayloadV1Schema.parse({ v: 1, binding: triggerBinding, definition }) });
  if (mode === 'e2ee') expect(JSON.stringify(sharedDefinitionEnvelope)).not.toContain('private-filter-match');
  else expect(sharedDefinitionEnvelope.t).toBe('plain');
  const reference = { automationId: 'source', triggerId: triggerBinding.triggerId, triggerRevision: 1, workflowId: artifactId,
    workflowRevision: 1, ownerAccountId: 'author', phase: 'after' as const, actionIds: definition.actionIds,
    reachesOthers: true, sharedDefinitionEnvelope };
  const options = { accountId: 'actor', readDefinition: async () => { throw new Error('No author Account read'); },
    openTrigger: async () => { throw new Error('No actor-key opening of author content'); },
    readSharedDefinition: async () => {
      const received = await actorStore.readForUpdate(artifactId, readOptions);
      if (!received) throw new Error('Shared Workflow unavailable');
      const payload = received.openAssociatedContent({ ...binding, content: sharedDefinitionEnvelope });
      const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: triggerBinding,
        envelope: { t: 'plain', v: payload } });
      if (opened.kind !== 'available') throw new Error(opened.kind);
      return AutomationActionTriggerSchema.parse(opened.definition);
    } };
  const match = await createActionAutomationPrivateMatchingV1(options)({ status: 'ready', subjects: [], before: [], after: [reference] }, {});
  const evidence = { v: 1 as const, kind: 'action' as const, actionId: definition.actionIds[0]!, requestId: 'invocation',
    phase: 'after' as const, status: 'succeeded' as const, occurredAt: 1, subjects: [] };
  expect(await match({ ...evidence, requestId: 'private-filter-match' }, [reference])).toEqual({ matched: [reference], notices: [] });
  expect(await match({ ...evidence, requestId: 'other' }, [reference])).toEqual({ matched: [], notices: [] });
});
