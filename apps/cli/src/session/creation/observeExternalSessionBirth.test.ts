import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import { createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { observeExternalSessionBirth } from './observeExternalSessionBirth';

const credentials = { token: 'account-token', encryption: null };
const actionInput = { creationKey: 'start-key', executionTarget: { serverId: 'srv_home', machineId: 'guest' },
  directory: { kind: 'managed' }, agentTarget: { kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  initialInput: { text: 'send once' } } as const;
const digest = 'a'.repeat(43);
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-root', binding: {
  accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 }, actionId: 'session.spawn_new',
  serverIdentityId: actionInput.executionTarget.serverId, machineId: actionInput.executionTarget.machineId,
  custodianAccountId: 'account', installationId: 'install', admittedMachineRole: 'manage', accountEncryptionMode: 'plain',
  target: { kind: 'machine', machineId: actionInput.executionTarget.machineId }, requestId: 'request', requestEnvelopeDigest: digest,
} });
const correspondence = buildSessionCreationCorrespondence({
  identity: { callerCreationNamespace: 'user', creationKey: actionInput.creationKey },
  recipe: { execution: { machineId: actionInput.executionTarget.machineId, directory: actionInput.directory },
    organization: { folderId: null, tagIds: [] }, agentTarget: actionInput.agentTarget },
});

describe('observeExternalSessionBirth', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['different submission', 'matching submission', 'unstarted configured sandbox', 'started configured sandbox', 'no Session', 'unknown Account mode'] as const)('settles %s using only the committed row', async scenario => {
    const sandbox = scenario === 'unstarted configured sandbox' || scenario === 'started configured sandbox';
    const observedInput = sandbox ? { ...actionInput, sessionPlacement: {
      kind: 'machine', target: actionInput.executionTarget, configuredSandbox: {
        kind: 'sandbox', configuredSandboxId: 'test-sandbox', lifecycle: 'fresh',
        provisioner: { pluginId: 'happier.machine.lima', localId: 'lima' }, presetId: 'test-preset',
      },
    } } : actionInput;
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', agentState: null, metadata: { path: '/guest/session', host: 'guest', machineId: 'guest',
        sessionCreationCorrespondenceV1: { ...correspondence,
          externalActionRequestDigest: scenario === 'different submission' ? 'b'.repeat(43) : digest } } });
    const session = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture('committed-session'),
      encryptionMode: 'plain', share: null, active: false, archivedAt: null, dataEncryptionKey: null,
      runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0, runtimeActivityObservedAt: null,
      runtimeActivityRevision: scenario === 'started configured sandbox' ? 1 : 0,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata });
    const request = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(url).toMatch(/\/v2\/sessions\/lookup-by-tags$/u);
      expect(body).toEqual({ tags: [correspondence.sessionCreationTag] });
      return { status: 200, data: { sessions: scenario === 'no Session' ? [] : [session] } };
    });
    const externalActionExecutionAuthorization = scenario === 'unknown Account mode'
      ? { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: undefined } }
      : authorization;
    const result = await observeExternalSessionBirth({ credentials, actionInput: observedInput,
      context: { authority: 'present_user', externalActionExecutionAuthorization } });
    if (scenario === 'different submission') expect(result).toBeNull();
    if (scenario === 'unstarted configured sandbox') expect(result).toEqual({
      type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true, sessionId: 'committed-session',
    });
    if (scenario === 'matching submission' || scenario === 'started configured sandbox') expect(result).toMatchObject({ type: 'success', sessionId: 'committed-session',
      initialInput: { status: 'outcomeUnknown', localId: expect.any(String) } });
    if (scenario === 'no Session') expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: true,
      failureCause: { nativeErrorReason: 'daemon_reconnected_before_session_birth_confirmed' } });
    if (scenario === 'unknown Account mode') expect(result).toBeNull();
    expect(request).toHaveBeenCalledTimes(scenario === 'unknown Account mode' ? 0 : 1);
  });
});
