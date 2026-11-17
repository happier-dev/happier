import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  actionSpecToActionDefinitionV1,
  projectActionDefinitionForExternalDiscovery,
  projectActionDefinitionSummaryForExternalDiscovery,
  searchSerializedActionSpecsForSurface,
} from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { AppShellActionOutputSchemas, projectInboxReadItemV1 } from '@happier-dev/protocol/actions/appShellActionFamily';
import { VoiceRealtimeToolResultV1Schema, type VoiceRealtimeJsonValue } from '@happier-dev/protocol/voice/realtime/events';

import { redactVoiceToolResultForProvider } from '@/voice/context/redactVoiceToolResult';
import { createRealtimeToolBarrierForVoiceHandlers } from './defaultRealtimeToolBarrier';
import { t } from '@/text';
import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

const privacy = { shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false };

async function runTool(toolName: string, args: VoiceRealtimeJsonValue, output: unknown, prefs = privacy) {
  const barrier = createRealtimeToolBarrierForVoiceHandlers({
    handlers: { [toolName]: async () => JSON.stringify(output) },
    readRedactionPrefs: () => prefs,
    submitResults: async () => undefined,
    continueResponse: async () => undefined,
  });
  try {
    return await barrier.run({ responseId: 'response-1', calls: [{
      v: 1, responseId: 'response-1', callId: 'call-1', toolName, order: 0, arguments: args,
    }] });
  } finally {
    barrier.dispose();
  }
}

describe('realtime provider output redaction', () => {
  it('retains the complete redacted Action failure for owner summary and refreshed delivery', async () => {
    let shareFilePaths = true;
    const output = parseActionExecuteFailure({ ok: false, errorCode: 'CustomActionFailure',
      error: 'Claude is signed out on the selected machine at /home/alice/private',
      details: { reason: 'provider_signed_out' } });
    expect(output).not.toBeNull();
    const submitted: unknown[] = [];
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { spawnSession: async () => JSON.stringify(output) },
      readRedactionPrefs: () => ({ ...privacy, shareFilePaths }),
      submitResults: async (_id, results) => { submitted.push(results); }, continueResponse: async () => {},
    });
    const input = { responseId: 'response-owner-failure', calls: [{ v: 1, responseId: 'response-owner-failure',
      callId: 'call-owner-failure', toolName: 'spawnSession', order: 0, arguments: {
        executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/project' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      } }] };
    try {
      const first = await barrier.run(input);
      expect(first.results[0]).toMatchObject({ status: 'error', errorCode: 'CustomActionFailure',
        summary: expect.stringContaining('Claude is signed out') });
      shareFilePaths = false;
      const refreshed = await barrier.run(input);
      expect(refreshed.results[0]).toMatchObject({ status: 'error', errorCode: 'CustomActionFailure',
        summary: expect.stringContaining('Claude is signed out') });
      expect(JSON.stringify(refreshed)).not.toContain('/home/alice');
      expect(JSON.stringify(submitted.at(-1))).not.toContain('/home/alice');
      expect(refreshed.results[0]?.output).toBeUndefined();
    } finally { barrier.dispose(); }
  });

  it('delivers the Action owner approval summary while preserving typed failure status', async () => {
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { spawnSession: async () => JSON.stringify({ ok: false, errorCode: 'present_user_required' }) },
      readRedactionPrefs: () => privacy,
      submitResults: async () => {}, continueResponse: async () => {},
    });
    try {
      const result = await barrier.run({ responseId: 'response-1', calls: [{ v: 1, responseId: 'response-1',
        callId: 'call-1', toolName: 'spawnSession', order: 0, arguments: {
          executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/project' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } }] });
      expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'present_user_required',
        summary: t('voiceSurface.approvalTapRequired') });
      expect(result.results[0]?.output).toBeUndefined();
    } finally { barrier.dispose(); }
  });

  it('derives the realtime summary from the privacy-projected result', async () => {
    const output = { ok: true, target: { label: 'Private Session title' } };
    const result = await runTool('spawnSession', {
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    }, output);
    expect(result.results[0]?.status).toBe('success');
    expect(JSON.stringify(result)).not.toContain('Private Session title');
    expect(result.results[0]).not.toHaveProperty('summary');
  });

  it('delivers a canonical plugin-target approval without manufacturing an undefined built-in Action id', async () => {
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Set title',
      qualifiedActionId: 'acme.titles/actions/set', input: { title: 'Release', credential: 'private-input' },
      secretInputPaths: ['credential'], sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
    });
    const output = getActionSpec('approval.request.get')!.outputSchema!.parse({
      artifactId: 'approval', request: projectApprovalRequestForPublicRead(request),
      canAllow: false, // No pending automatic consent in this stored request.
      queryPlan: { kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore',
        boundedBy: 'approval artifact id', hydratedTranscripts: false },
    });
    const result = await runTool('approval_request_get', { artifactId: 'approval' }, output,
      { ...privacy, shareFilePaths: true, sharePermissionRequests: true });
    expect(result.results[0]?.status).toBe('success');
    expect(result.results[0]?.output).toMatchObject({ request: {
      status: 'open', summary: 'Set title', qualifiedActionId: request.qualifiedActionId,
    } });
    expect(JSON.stringify(result)).not.toContain('private-input');
  });

  it('delivers the canonical Inbox projection at the observed 1365-row scale', async () => {
    const items = Array.from({ length: 1365 }, (_, index) => projectInboxReadItemV1({
      key: `notice-${index}`, producer: 'notice', type: 'update', view: 'updates',
      title: 'Account update', context: null, createdAt: index, read: false,
      pageRoute: '/inbox', source: { kind: 'notice', id: `notice-${index}`, serverId: 'home' },
      focus: { kind: 'notice', serverId: 'home', id: `notice-${index}` },
    }));
    const output = { ok: true, ...AppShellActionOutputSchemas['inbox.get'].parse({
      status: 'ready', groups: [], items, coverage: { discussions: 'complete' },
      approvalIds: [], usageNoticeIds: [], accountNoticeIds: items.map(item => item.key),
      friendRequestIds: [], automationRunIds: [], readySessions: [], actionOperations: [],
      isLoading: false, refreshFailed: false,
    }) };

    const result = await runTool('inbox_get', {}, output);

    expect(result.status).toBe('submitted');
    expect(result.results[0]?.status).toBe('success');
    expect(result.results[0]).toMatchObject({ status: 'success',
      output: redactVoiceToolResultForProvider('inbox_get', output, privacy) });
    expect(VoiceRealtimeToolResultV1Schema.parse(result.results[0]).output)
      .toMatchObject({ items: expect.any(Array), accountNoticeIds: items.map(item => item.key) });
  });

  it('delivers the real session spawn Action detail contract after privacy projection', async () => {
    const output = { ok: true, actionSpec: projectActionDefinitionForExternalDiscovery(
      actionSpecToActionDefinitionV1(getActionSpec('session.spawn_new'), { surface: 'voice', includeOutputSchema: true }),
    ) };
    const result = await runTool('getActionSpec', { id: 'session.spawn_new' }, output);

    expect(result.results[0]?.status).toBe('success');
    expect(result.results[0]).toMatchObject({ status: 'success',
      output: redactVoiceToolResultForProvider('getActionSpec', output, privacy) });
  });

  it('delivers the real spawn-session discovery summaries after privacy projection', async () => {
    const output = { ok: true, actionSpecs: searchSerializedActionSpecsForSurface({
      surface: 'voice', query: 'spawn session', limit: 5, includeOutputSchema: true,
    }).map(projectActionDefinitionSummaryForExternalDiscovery) };
    expect(output.actionSpecs.length).toBeGreaterThan(0);
    const result = await runTool('searchActionSpecs', { query: 'spawn session', limit: 5 }, output);

    expect(result.results[0]?.status).toBe('success');
    expect(result.results[0]).toMatchObject({ status: 'success',
      output: redactVoiceToolResultForProvider('searchActionSpecs', output, privacy) });
  });

  it('preserves typed Action failure details through the same privacy projection', async () => {
    const output = { ok: false, errorCode: 'action_input_invalid', details: {
      reason: 'directory_missing', directory: '/home/alice/private', field: 'directory',
    } };
    const result = await runTool('getActionSpec', { id: 'session.spawn_new' }, output);

    expect(result.results[0]).toMatchObject({ status: 'error', errorCode: output.errorCode,
      errorDetails: { reason: 'directory_missing', directory: '<path_redacted>', field: 'directory' } });
    expect(JSON.stringify(result)).not.toContain('/home/alice');
  });

  it('preserves a canonical thrown PluginError code without applying a local code vocabulary', async () => {
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: { getActionSpec: async () => { throw new PluginError({ code: 'CustomActionFailure',
        details: { reason: 'directory_missing', directory: '/home/alice/private' } }); } },
      readRedactionPrefs: () => privacy,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });
    try {
      const result = await barrier.run({ responseId: 'response-1', calls: [{
        v: 1, responseId: 'response-1', callId: 'call-1', toolName: 'getActionSpec', order: 0,
        arguments: { id: 'session.spawn_new' },
      }] });
      expect(result.results[0]).toMatchObject({ status: 'error', errorCode: 'CustomActionFailure',
        errorDetails: { reason: 'directory_missing', directory: '<path_redacted>' } });
      expect(JSON.stringify(result)).not.toContain('/home/alice');
    } finally {
      barrier.dispose();
    }
  });

  it.each([false, true])('does not restore a PluginError code containing a path removed by the privacy owner (initial sharing: %s)', async initiallySharePaths => {
    let shareFilePaths = initiallySharePaths;
    let markFirstProjection!: () => void;
    const firstProjection = new Promise<void>(resolve => { markFirstProjection = resolve; });
    let releaseSibling!: (value: string) => void;
    const sibling = new Promise<string>(resolve => { releaseSibling = resolve; });
    const barrier = createRealtimeToolBarrierForVoiceHandlers({
      handlers: {
        getActionSpec: async () => { throw new PluginError({ code: '/home/alice/private' }); },
        searchActionSpecs: async () => await sibling,
      },
      readRedactionPrefs: () => {
        markFirstProjection();
        return { ...privacy, shareFilePaths };
      },
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });
    try {
      const pending = barrier.run({ responseId: 'response-1', calls: [{
        v: 1, responseId: 'response-1', callId: 'call-1', toolName: 'getActionSpec', order: 0,
        arguments: { id: 'session.spawn_new' },
      }, { v: 1, responseId: 'response-1', callId: 'call-2', toolName: 'searchActionSpecs', order: 1,
        arguments: { query: 'spawn session', limit: 5 } }] });
      await firstProjection;
      shareFilePaths = false;
      releaseSibling(JSON.stringify({ ok: true, actionSpecs: [] }));
      const result = await pending;
      expect(result.results[0]).toMatchObject({ status: 'error', errorCode: '<path_redacted>' });
      expect(JSON.stringify(result)).not.toContain('/home/alice');
    } finally {
      barrier.dispose();
    }
  });

});
