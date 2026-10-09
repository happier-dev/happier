import { describe, expect, it } from 'vitest';

import { SessionMessageProvenanceV1Schema as publicSessionMessageProvenanceV1Schema } from '../general.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '../../runtime/input/composerAttachmentV1.js';
import * as sessionInputAdmission from './sessionInputAdmission.js';
import { SessionMessageMetaSchema } from './sessionMessageMeta.js';
import {
  normalizeParticipantRecipientRoutingIdentityV1,
  ParticipantRecipientRoutingIdentityV1Schema,
  withParticipantRecipientV1,
} from '../../messages/structured/participantMessageV1.js';

const protocol = { ...sessionInputAdmission, SessionMessageMetaSchema };

describe('session input admission metadata', () => {
  it('preserves a strict server-admitted exact Machine target without admitting content or credentials', () => {
    const target = { homeId: 'home', accountId: 'requester', sessionId: 'session', machineId: 'machine', installationId: 'installation' };
    const receipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'requester', sessionRelationship: 'owner', admittedTarget: target };
    expect(protocol.SessionInputAdmissionReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(protocol.SessionInputAdmissionReceiptV1Schema.safeParse({ ...receipt, admittedTarget: { ...target, prompt: 'private' } }).success).toBe(false);
    expect(protocol.SessionInputAdmissionReceiptV1Schema.safeParse({ ...receipt, admittedTarget: { ...target, installationId: '' } }).success).toBe(false);
  });
  it('preserves supported context envelopes for a Run whose destination is the canonical Pending target', () => {
    const recipient = { kind: 'execution_run' as const, runId: 'writer' };
    const comments = { happier: { kind: 'review_comments.v1', payload: { sessionId: 'session-1', comments: [] } } };
    const attachment = { happier: { kind: 'attachments.v1', payload: { attachments: [] } } };
    expect(withParticipantRecipientV1(comments, recipient)).toEqual(comments);
    expect(withParticipantRecipientV1(attachment, recipient)).toEqual(attachment);
    expect(() => withParticipantRecipientV1(comments, { kind: 'agent_team_member', teamId: 'team', memberId: 'member' })).toThrow();
    expect(() => withParticipantRecipientV1({ happier: { kind: 'unsupported.v1' } }, recipient)).toThrow();
  });
  it('admits an execution-run recipient only on plugin user-text input', () => {
    const userText = {
      kind: 'userText',
      text: 'Continue the review',
      idempotencyKey: 'plugin-message-1',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    } as const;

    expect(protocol.PluginSessionInputRequestV1Schema.parse(userText)).toEqual(userText);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'sessionSubagentLaunch',
      launch: {
        kind: 'agent_team_create',
        teamId: 'reviewers',
        description: 'Review the current change.',
      },
      idempotencyKey: 'plugin-launch-1',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    }).success).toBe(false);
  });

  it('derives label-free routing into authored content while preserving omitted main metadata', () => {
    const meta = { sentFrom: 'cli' };
    expect(withParticipantRecipientV1(meta, undefined)).toBe(meta);
    const run = { kind: 'execution_run', runId: ' run-a ', label: 'Friendly title' } as const;
    expect(normalizeParticipantRecipientRoutingIdentityV1(run)).toEqual({ kind: 'execution_run', runId: 'run-a' });
    expect(ParticipantRecipientRoutingIdentityV1Schema.safeParse(run).success).toBe(false);
    const authored = withParticipantRecipientV1(meta, run);
    expect(authored).toEqual({ ...meta, happier: { kind: 'participant_message.v1', payload: { recipient: { kind: 'execution_run', runId: 'run-a' } } } });
    expect(() => withParticipantRecipientV1(authored, { kind: 'execution_run', runId: 'run-b' })).toThrow();
    expect(() => normalizeParticipantRecipientRoutingIdentityV1({ ...run, authority: 'owner' })).toThrow();
    expect(() => normalizeParticipantRecipientRoutingIdentityV1({ kind: 'execution_run', runId: ' ' })).toThrow();
  });

  it('retains Agent-team routing as strict parent-runtime metadata', () => {
    expect(normalizeParticipantRecipientRoutingIdentityV1({ kind: 'agent_team_member', teamId: ' team ', memberId: ' member ', memberLabel: 'Name' })).toEqual({ kind: 'agent_team_member', teamId: 'team', memberId: 'member' });
    expect(normalizeParticipantRecipientRoutingIdentityV1({ kind: 'agent_team_broadcast', teamId: ' team ' })).toEqual({ kind: 'agent_team_broadcast', teamId: 'team' });
  });
  const pluginSource = {
    mediatorPluginId: 'example.channels',
    sourceRef: 'binding-1',
    sourceRevisionOrEpoch: 'rev-1',
    remoteApprovalMaxScope: 'session',
  } as const;

  it('classifies exact pre-effect cancellation as a strict admission rejection', () => {
    expect(protocol.SessionInputAdmissionResultV1Schema.parse({
      status: 'rejected',
      code: 'session_input_cancelled',
    })).toEqual({
      status: 'rejected',
      code: 'session_input_cancelled',
    });
  });

  it('keeps admitted permission ceilings terminal-only and rejects unknown authority fields', () => {
    expect(protocol.SessionInputRequestV1Schema.safeParse({
      v: 1,
      producer: 'pluginSession',
      caller: {
        kind: 'plugin',
        pluginId: 'example.channels',
        contributionLocalId: 'inbound',
      },
      permission: {
        requestedPermissionCeiling: 'safe-yolo',
        admittedPermissionCeiling: 'yolo',
      },
      sourceAuthority: pluginSource,
    }).success).toBe(false);

    expect(protocol.SessionInputAuthorityV1Schema.safeParse({
      v: 1,
      producer: 'pluginSession',
      caller: {
        kind: 'plugin',
        pluginId: 'example.channels',
        contributionLocalId: 'inbound',
      },
      permission: {
        requestedPermissionCeiling: 'safe-yolo',
        admittedPermissionCeiling: 'safe-yolo',
      },
      sourceAuthority: pluginSource,
      unexpected: true,
    }).success).toBe(false);
  });

  it('accepts only one protected lifecycle arm in session message metadata', () => {
    const request = {
      v: 1,
      producer: 'cli',
      caller: { kind: 'host' },
      permission: {},
    } as const;
    const authority: {
      kind: 'admittedSessionInputV1';
      admittedPermissionCeiling: 'read-only' | 'yolo';
      sourceAuthority: {
        kind: 'mediatedExternal';
        mediatorPluginId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
        remoteApprovalMaxScope: 'session';
        admittedPermissionCeiling: 'read-only' | 'yolo';
      };
    } = {
      v: 1,
      producer: 'cli',
      caller: { kind: 'host' },
      permission: { admittedPermissionCeiling: 'default' },
    } as const;

    expect(protocol.SessionMessageMetaSchema.safeParse({
      happierInputRequestV1: request,
    }).success).toBe(true);
    expect(protocol.SessionMessageMetaSchema.safeParse({
      happierInputAuthorityV1: authority,
    }).success).toBe(true);
    expect(protocol.SessionMessageMetaSchema.safeParse({
      happierInputRequestV1: request,
      happierInputAuthorityV1: authority,
    }).success).toBe(false);
  });

  it('projects predecessor modality source only when new provenance is absent', () => {
    const predecessorMeta = {
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'voice',
          source: {
            pluginId: 'example.channels',
            contributionId: 'inbound',
          },
        },
      },
    };

    expect(protocol.readSessionMessageProvenanceV1(predecessorMeta)).toEqual({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'example.channels',
      contributionLocalId: 'inbound',
      surface: 'unspecified',
    });

    const explicit = {
      v: 1,
      kind: 'voice',
    } as const;
    expect(protocol.readSessionMessageProvenanceV1({
      ...predecessorMeta,
      happierProvenanceV1: explicit,
    })).toEqual(explicit);
  });

  it('exposes mediated source authority only from valid final authority', () => {
    const authority = {
      v: 1,
      producer: 'pluginSession',
      caller: {
        kind: 'plugin',
        pluginId: 'example.channels',
        contributionLocalId: 'inbound',
      },
      permission: {
        requestedPermissionCeiling: 'safe-yolo',
        admittedPermissionCeiling: 'read-only',
      },
      sourceAuthority: pluginSource,
    } as const;

    expect(protocol.readSessionPermissionSourceAuthorityV1({
      happierInputAuthorityV1: authority,
    })).toEqual({
      kind: 'mediatedExternal',
      ...pluginSource,
      admittedPermissionCeiling: 'read-only',
    });
    expect(protocol.readSessionPermissionSourceAuthorityV1({
      happierInputRequestV1: {
        ...authority,
        permission: { requestedPermissionCeiling: 'safe-yolo' },
      },
    })).toBeNull();
  });

  it('derives one explicit causal permission authority only from terminal metadata', () => {
    const authority = {
      v: 1,
      producer: 'pluginSession',
      caller: {
        kind: 'plugin',
        pluginId: 'example.channels',
        contributionLocalId: 'inbound',
      },
      permission: {
        admittedPermissionCeiling: 'read-only',
      },
      sourceAuthority: pluginSource,
    } as const;

    const mediatedSourceAuthority = {
      kind: 'mediatedExternal',
      ...pluginSource,
      admittedPermissionCeiling: 'read-only',
    } as const;
    expect(protocol.SessionPermissionSourceAuthorityV1Schema.safeParse(mediatedSourceAuthority).success).toBe(true);
    expect(protocol.SessionPermissionSourceAuthorityV1Schema.safeParse({
      ...mediatedSourceAuthority,
      unexpected: true,
    }).success).toBe(false);

    expect(protocol.SessionInputCausalPermissionAuthorityV1Schema.safeParse({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'read-only',
      sourceAuthority: {
        kind: 'mediatedExternal',
        ...pluginSource,
        admittedPermissionCeiling: 'safe-yolo',
      },
    }).success).toBe(false);

    expect(protocol.readSessionInputCausalPermissionAuthorityV1({
      happierInputAuthorityV1: authority,
    })).toEqual({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'read-only',
      sourceAuthority: {
        kind: 'mediatedExternal',
        ...pluginSource,
        admittedPermissionCeiling: 'read-only',
      },
    });
    expect(protocol.readSessionInputCausalPermissionAuthorityV1({
      happierInputRequestV1: {
        ...authority,
        permission: {},
      },
    })).toBeNull();
  });

  it('materializes an independently frozen causal permission snapshot', () => {
    const authority = {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
      sourceAuthority: {
        kind: 'mediatedExternal' as const,
        ...pluginSource,
        admittedPermissionCeiling: 'read-only' as const,
      },
    };

    const snapshot = protocol.materializeSessionInputCausalPermissionAuthorityV1(authority);
    expect(snapshot).toEqual(authority);
    expect(snapshot).not.toBe(authority);
    expect(snapshot?.sourceAuthority).not.toBe(authority.sourceAuthority);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.sourceAuthority)).toBe(true);

    authority.admittedPermissionCeiling = 'yolo';
    authority.sourceAuthority.admittedPermissionCeiling = 'yolo';
    expect(snapshot).toMatchObject({
      admittedPermissionCeiling: 'read-only',
      sourceAuthority: { admittedPermissionCeiling: 'read-only' },
    });
    expect(protocol.materializeSessionInputCausalPermissionAuthorityV1({
      ...authority,
      admittedPermissionCeiling: 'not-a-mode',
    })).toBeNull();
  });

  it('serializes equality input canonically without turning ciphertext into an equality contract', () => {
    const left = protocol.serializeSessionInputRequestEqualityIntentV1({
      requestEnvelope: {
        v: 1,
        content: { t: 'plain', v: { beta: 2, alpha: 1 } },
      },
      requestedAction: { v: 1, kind: 'enqueue' },
    });
    const right = protocol.serializeSessionInputRequestEqualityIntentV1({
      requestEnvelope: {
        content: { v: { alpha: 1, beta: 2 }, t: 'plain' },
        v: 1,
      },
      requestedAction: { kind: 'enqueue', v: 1 },
    });
    const changedAction = protocol.serializeSessionInputRequestEqualityIntentV1({
      requestEnvelope: {
        v: 1,
        content: { t: 'plain', v: { alpha: 1, beta: 2 } },
      },
      requestedAction: { v: 1, kind: 'send_now' },
    });

    expect(left).toBe(right);
    expect(changedAction).not.toBe(left);
    expect(() => protocol.serializeSessionInputRequestEqualityIntentV1({
      requestEnvelope: { invalid: undefined },
      requestedAction: { v: 1, kind: 'enqueue' },
    })).toThrow('canonical JSON');
  });

  it('accepts one bounded plugin Session input request and rejects caller-owned authority', () => {
    const request = {
      kind: 'userText',
      text: 'Deploy the preview',
      idempotencyKey: 'discord-message-42',
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
        externalActor: {
          kind: 'human',
          displayNameSnapshot: 'Ada',
        },
        contentProvenance: 'forwarded',
      },
    } as const;

    expect(protocol.PluginSessionInputRequestV1Schema.parse(request)).toEqual(request);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      pluginId: 'forged.plugin',
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      localId: 'caller-selected',
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      source: {
        ...request.source,
        admittedPermissionCeiling: 'yolo',
      },
    }).success).toBe(false);
  });

  it('admits declared composer attachment drafts alongside plugin Session input text', () => {
    const request = {
      kind: 'userText',
      text: 'Fix the failing check',
      idempotencyKey: 'triage-entry-42',
      attachments: [{
        attachmentLocalId: 'entry',
        value: {
          key: 'github:pull:42',
          value: { sourceId: 'github', entryId: '42' },
          presentation: { label: 'PR #42' },
        },
      }],
    } as const;

    expect(protocol.PluginSessionInputRequestV1Schema.parse(request)).toEqual(request);
    // The host qualifies the caller's plugin id and stamps instance identity and
    // type label. An author-supplied identity is not admissible on this seam.
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      attachments: [{
        ...request.attachments[0],
        attachment: { pluginId: 'forged.plugin', localId: 'entry' },
      }],
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      attachments: [{
        ...request.attachments[0],
        value: {
          ...request.attachments[0].value,
          presentation: { label: 'PR #42', typeLabel: 'Triage' },
        },
      }],
    }).success).toBe(false);
    // The seam cannot admit more attachment instances than one Message may carry.
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      attachments: Array.from(
        { length: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 + 1 },
        (_unused, index) => ({
          attachmentLocalId: 'entry',
          value: {
            key: `github:pull:${index}`,
            value: { sourceId: 'github', entryId: String(index) },
            presentation: { label: `PR #${index}` },
          },
        }),
      ),
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      attachments: [],
    }).success).toBe(false);
  });

  it('admits the exact semantic subagent-launch intent without exposing message metadata', () => {
    const request = {
      kind: 'sessionSubagentLaunch',
      launch: {
        kind: 'agent_team_member_create',
        teamId: 'reviewers',
        memberLabel: 'security',
        instructions: 'Review the authentication changes.',
        runInBackground: true,
      },
      idempotencyKey: 'launch-security-reviewer',
    } as const;

    expect(protocol.PluginSessionInputRequestV1Schema.parse(request)).toEqual(request);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      metaOverrides: { happier: { kind: 'forged' } },
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      callerSurface: 'subagent_command',
    }).success).toBe(false);
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      ...request,
      forceImmediate: true,
    }).success).toBe(false);
  });

  it('admits an attachment-only plugin Session input and refuses one carrying neither', () => {
    // The canonical composer submission rule is `text.trim().length === 0 &&
    // attachments.length === 0` (`apps/ui/sources/components/sessions/composer/
    // composerSubmissionCoordinator.ts`): blank text WITH an attachment is a
    // real message. The plugin seam refusing it made a promptless configured
    // action deliver nothing at all, which is the contract half `PLAN.md`
    // §0a A4a exists to close.
    const attachments = [{
      attachmentLocalId: 'entry',
      value: {
        key: 'github:pull:42',
        value: { sourceId: 'github', entryId: '42' },
        presentation: { label: 'PR #42' },
      },
    }] as const;

    const attachmentOnly = {
      kind: 'userText',
      text: '',
      idempotencyKey: 'triage-entry-42',
      attachments,
    } as const;
    expect(protocol.PluginSessionInputRequestV1Schema.parse(attachmentOnly)).toEqual(attachmentOnly);

    // Neither text nor an attachment is still nothing to say, and stays refused.
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'userText',
      text: '',
      idempotencyKey: 'triage-entry-42',
    }).success).toBe(false);
    // Whitespace is not content either: the canonical rule trims first.
    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'userText',
      text: '   \n  ',
      idempotencyKey: 'triage-entry-42',
    }).success).toBe(false);
    // The same rule at the Action surface binding, which is the schema the
    // plugin executor actually admits a caller through.
    const spec = getActionSpec('session.message.send');
    const pluginInput = spec.surfaceBindings?.plugin?.inputSchema;
    expect(pluginInput?.safeParse({
      sessionId: 'session-a',
      message: '',
      idempotencyKey: 'triage-entry-42',
      attachments,
    }).success).toBe(true);
    expect(pluginInput?.safeParse({
      sessionId: 'session-a',
      message: '',
      idempotencyKey: 'triage-entry-42',
    }).success).toBe(false);
  });

  it('keeps trusted-plugin user-text carriers aligned on authored fields while excluding host authority', () => {
    const actionInput = getActionSpec('session.message.send').surfaceBindings?.plugin?.inputSchema;
    const shared = {
      idempotencyKey: 'channel-message-42',
      recipient: { kind: 'execution_run', runId: 'run-42' },
      source: {
        sourceRef: 'channel-7',
        sourceRevisionOrEpoch: 'message-42',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
      },
      attachments: [{
        attachmentLocalId: 'entry',
        value: {
          key: 'github:pull:42',
          value: { sourceId: 'github', entryId: '42' },
          presentation: { label: 'PR #42' },
        },
      }],
    } as const;

    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'userText',
      text: 'Review this',
      ...shared,
    }).success).toBe(true);
    expect(actionInput?.safeParse({
      sessionId: 'session-a',
      message: 'Review this',
      ...shared,
    }).success).toBe(true);

    for (const malformed of [
      { ...shared, idempotencyKey: '' },
      { ...shared, recipient: { ...shared.recipient, label: 'display-only' } },
      { ...shared, source: { ...shared.source, sourceRevisionOrEpoch: undefined } },
      { ...shared, attachments: [] },
    ]) {
      expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
        kind: 'userText',
        text: 'Review this',
        ...malformed,
      }).success).toBe(false);
      expect(actionInput?.safeParse({
        sessionId: 'session-a',
        message: 'Review this',
        ...malformed,
      }).success).toBe(false);
    }

    expect(protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'userText',
      text: 'Review this',
      ...shared,
      authority: 'present_user',
    }).success).toBe(false);
    expect(actionInput?.safeParse({
      sessionId: 'session-a',
      message: 'Review this',
      ...shared,
      permissionModeOverride: 'yolo',
    }).success).toBe(false);
  });

  it('keeps immediate external actor and content provenance as bounded co-present facts', () => {
    const provenance = {
      v: 1,
      kind: 'pluginSession',
      pluginId: 'example.channels',
      contributionLocalId: 'inbound',
      surface: 'background',
      externalActor: { kind: 'human', displayNameSnapshot: 'Ada' },
      contentProvenance: 'forwarded',
    } as const;

    expect(publicSessionMessageProvenanceV1Schema)
      .toBe(protocol.SessionMessageProvenanceV1Schema);
    expect(protocol.SessionMessageProvenanceV1Schema.parse(provenance)).toEqual(provenance);
    expect(protocol.PluginSessionInputSourceV1Schema.parse({
      sourceRef: 'channel-7',
      sourceRevisionOrEpoch: 'message-42',
      remoteApprovalMaxScope: 'request',
      requestedPermissionCeiling: 'read-only',
      externalActor: { kind: 'bot' },
      contentProvenance: 'viaBot',
    })).toMatchObject({
      externalActor: { kind: 'bot' },
      contentProvenance: 'viaBot',
    });
    expect(protocol.PluginSessionInputSourceV1Schema.safeParse({
      sourceRef: 'channel-7',
      sourceRevisionOrEpoch: 'message-42',
      remoteApprovalMaxScope: 'request',
      requestedPermissionCeiling: 'read-only',
      externalActor: { kind: 'human' },
    }).success).toBe(false);
    expect(protocol.PluginSessionInputSourceV1Schema.safeParse({
      sourceRef: 'channel-7',
      sourceRevisionOrEpoch: 'message-42',
      remoteApprovalMaxScope: 'request',
      requestedPermissionCeiling: 'read-only',
      contentProvenance: 'original',
    }).success).toBe(false);

    const { contentProvenance: _contentProvenance, ...withoutContentProvenance } = provenance;
    const { externalActor: _externalActor, ...withoutExternalActor } = provenance;
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse(withoutContentProvenance).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse(withoutExternalActor).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse({
      ...provenance,
      externalActor: { kind: 'forwarded' },
    }).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse({
      ...provenance,
      externalActor: { kind: 'human', principalId: 'provider-user-42' },
    }).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse({
      ...provenance,
      externalActor: { kind: 'human', displayNameSnapshot: 'x'.repeat(129) },
    }).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse({
      ...provenance,
      externalActor: { kind: 'human', displayNameSnapshot: 'e\u0301' },
    }).success).toBe(false);
    expect(protocol.SessionMessageProvenanceV1Schema.parse({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'example.plugin',
      contributionLocalId: 'ordinary-input',
      surface: 'ui',
    })).toEqual({
      v: 1,
      kind: 'pluginSession',
      pluginId: 'example.plugin',
      contributionLocalId: 'ordinary-input',
      surface: 'ui',
    });
    expect(protocol.SessionMessageProvenanceV1Schema.safeParse({
      v: 1,
      kind: 'agentTerminal',
      agentId: 'codex',
    }).success).toBe(false);
    expect(protocol.SessionRoleUserProducerKindV1Schema.safeParse('daemonInitialPrompt').success).toBe(false);
    expect(protocol.SessionRoleUserProducerKindV1Schema.safeParse('connectedService').success).toBe(false);
    expect(protocol.SessionRoleUserProducerKindV1Schema.safeParse('agentTerminal').success).toBe(false);
  });

  it('settles a protected request only by narrowing against the current Session ceiling', () => {
    const request = protocol.SessionInputRequestV1Schema.parse({
      v: 1,
      producer: 'pluginSession',
      caller: {
        kind: 'plugin',
        pluginId: 'example.channels',
        contributionLocalId: 'inbound',
      },
      permission: { requestedPermissionCeiling: 'yolo' },
      sourceAuthority: pluginSource,
    });

    expect(protocol.settleSessionInputRequestV1({
      request,
      currentSessionPermissionCeiling: 'safe-yolo',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })).toEqual({
      ...request,
      permission: {
        requestedPermissionCeiling: 'yolo',
        admittedPermissionCeiling: 'safe-yolo',
      },
    });
    expect(protocol.settleSessionInputRequestV1({
      request: { ...request, permission: { requestedPermissionCeiling: 'read-only' } },
      currentSessionPermissionCeiling: 'yolo',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    }).permission.admittedPermissionCeiling).toBe('read-only');
  });

  it('builds trusted host admission for ordinary UI and Voice without asserting Account relationship', () => {
    expect(protocol.buildTrustedHostSessionInputAdmissionV1('ui')).toEqual({
      provenance: { v: 1, kind: 'host', producer: 'happierApp' },
      request: {
        v: 1,
        producer: 'happierApp',
        caller: { kind: 'host' },
        permission: {},
      },
    });
    expect(protocol.buildTrustedHostSessionInputAdmissionV1('voice')).toEqual({
      provenance: { v: 1, kind: 'voice' },
      request: {
        v: 1,
        producer: 'voiceInput',
        caller: { kind: 'host' },
        permission: {},
      },
    });
  });

  it.each([
    ['owner', 'owner'],
    ['sharedEditor', 'sharedCollaborator'],
    ['sharedAdmin', 'sharedCollaborator'],
  ] as const)('derives the descriptive Happier App actor from an authenticated %s receipt', (
    sessionRelationship,
    actorKind,
  ) => {
    const admission = protocol.buildTrustedHostSessionInputAdmissionV1('ui');
    expect(protocol.settleSessionMessageProvenanceV1({
      request: admission.request,
      requestedProvenance: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } },
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        actorAccountId: 'account-1',
        sessionRelationship,
      },
    })).toEqual({ v: 1, kind: 'happierApp', actor: { kind: actorKind } });
  });

  it('builds transcript-only provenance only for live transcript producers', () => {
    expect(protocol.buildSessionTranscriptMessageProvenanceV1('externalSessionHistory')).toEqual({
      v: 1,
      kind: 'host',
      producer: 'externalSessionHistory',
    });
    expect(protocol.buildSessionTranscriptMessageProvenanceV1('runtimeTranscript')).toEqual({
      v: 1,
      kind: 'host',
      producer: 'runtimeTranscript',
    });
    expect(protocol.buildSessionTranscriptMessageProvenanceV1('executionRunVoice')).toEqual({
      v: 1,
      kind: 'host',
      producer: 'executionRunVoice',
    });
  });

  it.each([
    {
      label: 'plugin caller',
      request: {
        v: 1,
        producer: 'pluginSession',
        caller: { kind: 'plugin', pluginId: 'example.channels', contributionLocalId: 'inbound' },
        permission: {},
      },
    },
    {
      label: 'source Session assertion',
      request: {
        v: 1,
        producer: 'sessionAction',
        caller: { kind: 'host' },
        sourceSession: { sourceSessionId: 'session-source', sourceTurnId: 'turn-source', via: 'action' },
        permission: {},
      },
    },
    {
      label: 'Automation assertion',
      request: {
        v: 1,
        producer: 'automation',
        caller: { kind: 'host' },
        automation: { automationId: 'automation-1', runId: 'run-1' },
        permission: {},
      },
    },
  ])('rejects an Account receipt for a protected $label', ({ request }) => {
    expect(() => protocol.settleSessionInputRequestV1({
      request,
      currentSessionPermissionCeiling: 'default',
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        actorAccountId: 'account-1',
        sessionRelationship: 'owner',
      },
    })).toThrow('Account admission');
  });

  it('classifies machine-only admission once at the Protocol owner', () => {
    expect(protocol.requiresAuthenticatedMachineAdmissionForSessionInputV1({
      v: 1,
      producer: 'happierApp',
      caller: { kind: 'host' },
      permission: {},
    })).toBe(false);
    expect(protocol.requiresAuthenticatedMachineAdmissionForSessionInputV1({
      v: 1,
      producer: 'sessionAction',
      caller: { kind: 'host' },
      sourceSession: {
        sourceSessionId: 'session-source',
        sourceTurnId: 'turn-source',
        via: 'mcp',
      },
      permission: {},
    })).toBe(true);
  });

  it('revalidates the minimal receipt against immutable settled authority for transcript projection', () => {
    const authority = protocol.SessionInputAuthorityV1Schema.parse({
      v: 1,
      producer: 'pluginSession',
      caller: { kind: 'plugin', pluginId: 'example.channels', contributionLocalId: 'inbound' },
      sourceAuthority: pluginSource,
      permission: { admittedPermissionCeiling: 'read-only' },
    });
    expect(protocol.assertSessionInputAdmissionReceiptForAuthorityV1({
      authority,
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })).toEqual({ v: 1, issuer: 'authenticatedMachine' });
    expect(() => protocol.assertSessionInputAdmissionReceiptForAuthorityV1({
      authority,
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        actorAccountId: 'account-1',
        sessionRelationship: 'owner',
      },
    })).toThrow('Account admission');
  });

  it('fails closed for invalid current policy and transcript-only producers', () => {
    const request = protocol.SessionInputRequestV1Schema.parse({
      v: 1,
      producer: 'cli',
      caller: { kind: 'host' },
      permission: {},
    });
    expect(() => protocol.settleSessionInputRequestV1({
      request,
      currentSessionPermissionCeiling: 'not-a-mode',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })).toThrow();
    expect(protocol.SessionInputRequestV1Schema.safeParse({
      ...request,
      producer: 'runtimeTranscript',
    }).success).toBe(false);
  });

  it('requires NFC nonblank bounded public idempotency keys', () => {
    const parse = (idempotencyKey: string) => protocol.PluginSessionInputRequestV1Schema.safeParse({
      kind: 'userText',
      text: 'hello',
      idempotencyKey,
    }).success;

    expect(parse('retry-1')).toBe(true);
    expect(parse('   ')).toBe(false);
    expect(parse('e\u0301')).toBe(false);
    expect(parse('x'.repeat(256))).toBe(true);
    expect(parse('x'.repeat(257))).toBe(false);
  });
});
