import { describe, expect, it } from 'vitest';
import { AgentSessionProviderCheckpointMaxJsonBytesV1 } from '@happier-dev/protocol/runtime';

import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonTurnContributionRequestV1Schema,
  AgentRuntimeDaemonTurnContributionsResultV1Schema,
  COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD,
  extractComposerStagedMediaAdmissionSettlement,
} from './agentRuntimeRunnerProtocol';

describe('Runner Agent protocol', () => {
  it('keeps the private runner descriptor strict and bounded', () => {
    const descriptor = {
      v: 1,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      backendId: 'codex',
      generation: 'generation-1',
      agentDeclaration: {
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        definition: {
          id: 'codex',
          title: 'Codex',
          runtime: { kind: 'custom' as const },
          primary: 'sessions' as const,
          capabilities: {
            sessions: {
              open: ['create' as const],
              delivery: ['newTurn' as const],
              cancel: true,
            },
          },
        },
      },
    } as const;

    expect(
      AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse(descriptor)
        .success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
        ...descriptor,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
        ...descriptor,
        agentDeclaration: {
          ...descriptor.agentDeclaration,
          manifestDigest: 'manifest:codex-generation-1',
        },
      }).success,
    ).toBe(false);
    const runtimeAuthorityDescriptor = {
      ...descriptor,
      runtimeAuthority: {
        runtimeCapabilities: ['sessionHooks'],
      },
    } as const;
    expect(
      AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse(
        runtimeAuthorityDescriptor,
      ).success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
        ...runtimeAuthorityDescriptor,
        runtimeAuthority: {
          ...runtimeAuthorityDescriptor.runtimeAuthority,
          permissions: ['process.spawn'],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      kind: 'create',
      sessionId: 'session-create',
      cwd: '/workspace',
    },
    {
      kind: 'resume',
      sessionId: 'session-resume',
      cwd: '/workspace',
      providerSessionId: 'provider-session-1',
    },
    {
      kind: 'fork',
      sessionId: 'session-fork',
      cwd: '/workspace/fork',
      source: {
        sessionId: 'session-source',
        providerSessionId: 'provider-session-source',
        cwd: '/workspace/source',
      },
    },
  ] as const)('accepts a strict $kind session-open request', (request) => {
    expect(
      AgentRuntimeDaemonSessionOpenRequestV1Schema.safeParse(request)
        .success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonSessionOpenRequestV1Schema.safeParse({
        ...request,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('rejects fork-open Provider checkpoints above the canonical byte bound', () => {
    expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.safeParse({
      kind: 'fork',
      sessionId: 'session-fork',
      cwd: '/workspace/fork',
      source: {
        sessionId: 'session-source',
        providerSessionId: 'provider-session-source',
        cwd: '/workspace/source',
        target: {
          turnId: 'turn-1',
          providerCheckpoint: 'x'.repeat(
            AgentSessionProviderCheckpointMaxJsonBytesV1 + 1,
          ),
        },
      },
    }).success).toBe(false);
  });

  it('rejects unknown fields and oversized prompt results', () => {
    const result = {
      kind: 'prompt',
      promptAssetBlocks: [{
        id: 'prompt-1',
        scope: 'turn',
        text: 'Use the repository conventions.',
      }],
      toolPromptContributions: [],
    } as const;

    expect(
      AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse(result)
        .success,
    ).toBe(true);
    expect(
      AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
        ...result,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
        ...result,
        promptAssetBlocks: [{
          ...result.promptAssetBlocks[0],
          text: 'x'.repeat(300_000),
        }],
      }).success,
    ).toBe(false);
  });

  it('keeps Composer resolution a bounded transient turn contribution', () => {
    const request = {
      kind: 'composerReference',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      candidateId: 'issue:42',
    } as const;
    const result = {
      kind: 'composerReference',
      resolution: {
        id: 'issue:42',
        label: 'Issue 42',
        context: 'Issue context safe for the prompt.',
      },
    } as const;

    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse(request).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse({
      ...request,
      provider: request.reference,
    }).success).toBe(false);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse(result).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      resolution: {
        ...result.resolution,
        context: { path: '/workspace/secret.txt' },
      },
    }).success).toBe(false);
  });

  it('carries Composer attachment dispatch resolution with only the stable admission identity', () => {
    const request = {
      kind: 'composerAttachment',
      attachment: { pluginId: 'acme.review', localId: 'review-comment' },
      request: {
        sessionId: 'session-1',
        localId: 'local-1',
        attachments: [{
          instanceId: 'review-1',
          key: 'review-1',
          value: { reviewId: '42' },
        }],
      },
    } as const;
    const result = {
      kind: 'composerAttachment',
      result: {
        attachments: [{
          instanceId: 'review-1',
          status: 'ready',
          context: 'Fresh review context.',
          data: { refreshed: true },
        }],
      },
    } as const;

    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse(request).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse({
      ...request,
      request: { ...request.request, messageId: 'forbidden' },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse(result).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      result: {
        ...result.result,
        attachments: [{ ...result.result.attachments[0], unknown: true }],
      },
    }).success).toBe(false);
  });

  it('carries Composer attachment post-acceptance notification without a terminal message identity', () => {
    const request = {
      kind: 'composerAttachmentAccepted',
      attachment: { pluginId: 'acme.review', localId: 'review-comment' },
      event: {
        sessionId: 'session-1',
        localId: 'local-1',
        attachments: [{
          instanceId: 'review-1',
          key: 'review-1',
          value: { reviewId: '42' },
        }],
      },
    } as const;
    const result = {
      kind: 'composerAttachmentAccepted',
    } as const;

    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse(request).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse({
      ...request,
      event: { ...request.event, messageId: 'forbidden' },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse(result).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      accepted: true,
    }).success).toBe(false);
  });

  it('keeps staged-media settlement request-local and strict before Message admission', () => {
    const handle = {
      v: 1,
      id: 'composer-media-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'com.example.media', localId: 'composer' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'review.png',
      sizeBytes: 67,
      sha256: 'a'.repeat(64),
    } as const;
    const settlement = {
      v: 1,
      releaseIntents: [{
        handle,
        executionTarget: handle.executionTarget,
        owner: handle.owner,
      }],
      createdWorkspaceRelativePaths: [
        '.happier/uploads/messages/session-1/local-1/review.png',
      ],
    } as const;

    const extracted = extractComposerStagedMediaAdmissionSettlement({
      text: 'Review this image.',
      [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: settlement,
    });

    expect(extracted.transformed).toEqual({ text: 'Review this image.' });
    expect(extracted.settlement).toEqual(settlement);
    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse({
      kind: 'settleComposerStagedMedia',
      outcome: 'accepted',
      settlement,
    }).success).toBe(true);
    expect(() => extractComposerStagedMediaAdmissionSettlement({
      [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: {
        ...settlement,
        releaseIntents: [{ ...settlement.releaseIntents[0], unexpected: true }],
      },
    })).toThrow('Daemon returned an invalid staged-media admission settlement');
  });

  it('carries bounded next-turn Agent composition without a raw runtime or prompt replacement', () => {
    const request = {
      kind: 'composition',
      runtimeFamily: 'hostSession',
      machineId: 'machine-1',
      featureIds: ['execution.runs'],
    } as const;
    const result = {
      kind: 'composition',
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: [{
        tool: {
          toolId: 'example.agent-context-companion/review-summary-tool',
          actionId: 'review-summary',
          name: 'review_summary',
          title: 'Review summary',
          description: 'Summarize the bounded review transcript.',
          inputSchema: { type: 'object', additionalProperties: false },
          inputHints: {},
          safety: 'safe',
          examples: { voice: { argsExample: '{}' } },
          promptSnippet: 'Use review_summary when it helps the current turn.',
          promptGuidelines: ['Keep the summary tied to the requested review scope.'],
          availability: {
            when: { fact: 'host.feature', operator: 'enabled', value: 'summary' },
          },
          surfaces: ['agent', 'mcp'],
        },
        expectedContributorImmutableGenerationId: 'generation-g',
      }],
      toolPromptContributions: [{
        pluginId: 'example.agent-context-companion',
        id: 'review-summary-tool',
        title: 'Review summary',
        promptSnippet: 'Use the review summary tool when it is relevant.',
      }],
      promptAssetBlocks: [{
        id: 'plugin_prompt_asset.example.agent-context-companion/review-context',
        scope: 'turn',
        text: 'Keep the review bounded to the requested change.',
      }],
      additionalInstructions: [{
        pluginId: 'example.agent-context-companion',
        text: 'Preserve the session review cursor for the next turn.',
      }],
    } as const;

    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse(request).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse(result).success)
      .toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      prompt: 'replace the complete provider prompt',
    }).success).toBe(false);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      selectedTools: [{
        pluginId: 'unmanaged.plugin',
        localId: 'foreign-tool',
      }],
    }).success).toBe(false);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      ...result,
      selectedToolBindings: [],
    }).success).toBe(false);
  });

  it('carries the bounded raw ACP request transform through the existing daemon turn channel', () => {
    const payload = {
      sessionId: 'host-session-1',
      agentId: 'codex',
      runtimeFamily: 'acpSession',
      method: 'session/prompt',
      request: {
        sessionId: 'provider-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      timestampMs: 1,
    } as const;

    expect(AgentRuntimeDaemonTurnContributionRequestV1Schema.safeParse({
      kind: 'transformAgentRequest',
      payload,
    }).success).toBe(true);
    expect(AgentRuntimeDaemonTurnContributionsResultV1Schema.safeParse({
      kind: 'transformAgentRequest',
      payload,
    }).success).toBe(true);
  });
});
