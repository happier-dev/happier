import { describe, expect, it } from 'vitest';

import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from './daemonInvocationV1.js';

describe('client Action automated invocation provenance', () => {
  it('keeps Account caller package correspondence inside the existing closed binding', () => {
    const clientActionBinding = {
      pluginId: 'com.acme.account', pluginVersion: '1.2.3',
      contributionLocalId: 'aggregate', occurrenceId: 'local-account',
      sourceCustody: { kind: 'account_release', pluginId: 'com.acme.account', version: '1.2.3', archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
    };
    const request = { machineId: 'reading-machine', expectedContributorOccurrenceId: 'source-current',
      qualifiedActionId: 'com.acme.source/read', executionSurface: 'cli',
      invocation: { kind: 'clientPluginAction', clientActionBinding } };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({ ...request, requiredReadOnly: true }))
      .toMatchObject({ requiredReadOnly: true });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request, requiredReadOnly: false }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request,
      invocation: { ...request.invocation, clientActionBinding: { ...clientActionBinding, pluginVersion: ' ' } },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request,
      invocation: { ...request.invocation, clientActionBinding: { ...clientActionBinding, authority: 'present_user' } },
    }).success).toBe(false);
  });
  it('admits an independent Discussion Composer intent without deriving a Session identity', () => {
    const request = { machineId: 'machine-1', expectedContributorOccurrenceId: 'current',
      qualifiedActionId: 'acme.plugin/open', executionSurface: 'ui',
      invocation: { kind: 'hostPresentedComposer', currentComposerIntent: {
        composer: { kind: 'discussion', discussionId: 'discussion-1' }, revision: 0,
      } } };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request,
      invocation: { ...request.invocation, currentComposerIntent: { ...request.invocation.currentComposerIntent,
        composer: { ...request.invocation.currentComposerIntent.composer, sessionId: 'forged-session' },
      } },
    }).success).toBe(false);
  });

  it('resolves client message context only with the existing matching host-presented Message carrier', () => {
    const reference = { v: 1, sessionId: 's1', messageId: 'm1', observedRevision: 'r1' };
    const request = { machineId: 'machine-1', expectedContributorOccurrenceId: 'current',
      qualifiedActionId: 'acme.plugin/open', executionSurface: 'ui', resolveClientMessageContext: true,
      messageActionReference: reference, invocation: { kind: 'hostPresentedMessage', currentMessageIntent: reference } };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request, invocation: undefined }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request, executionSurface: 'agent' }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request, messageActionReference: { ...reference, messageId: 'other' } }).success).toBe(false);
  });
  it.each(['agent', 'mcp', 'cli'] as const)('admits the current client Action binding on the real %s surface', (executionSurface) => {
    const clientActionBinding = {
      pluginId: 'acme.search', contributionLocalId: 'search', occurrenceId: 'acme.search:current',
    };
    const request = {
      machineId: 'm1', expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.target/read', executionSurface,
      invocation: { kind: 'clientPluginAction', clientActionBinding },
    };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, invocation: { kind: 'mountedPluginSurface', mountedBinding: clientActionBinding },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, presentUserIntent: 'confirmed',
    }).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request, invocation: undefined, presentUserIntent: 'confirmed',
    }).success).toBe(false);
  });
});
