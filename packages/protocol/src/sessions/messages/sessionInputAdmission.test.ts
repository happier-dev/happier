import { describe, expect, it } from 'vitest';

import { SessionMessageProvenanceV1Schema as publicSessionMessageProvenanceV1Schema } from '../general.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '../../runtime/input/composerAttachmentV1.js';
import * as sessionInputAdmission from './sessionInputAdmission.js';
import { SessionMessageMetaSchema } from './sessionMessageMeta.js';

const protocol = { ...sessionInputAdmission, SessionMessageMetaSchema };

describe('session input admission metadata', () => {
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
    expect(protocol.SessionMessageProvenanceV1Schema.parse({
      v: 1,
      kind: 'agentTerminal',
      agentId: 'codex',
    })).toEqual({
      v: 1,
      kind: 'agentTerminal',
      agentId: 'codex',
    });
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
