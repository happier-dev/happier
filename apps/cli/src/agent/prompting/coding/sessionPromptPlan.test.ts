import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { BUILT_IN_ROLES_V1, accountSettingsParse } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';

import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { shouldDenyAgentSessionTitleToolCall } from '@/agent/permissions/codingPromptTitlePermission';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { CodexLikePermissionHandler } from '@/agent/permissions/CodexLikePermissionHandler';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

// The daemon IPC service is a system boundary; no plugin contributions are selected in these cases.
const daemonBridge: DaemonAgentRuntimeTurnContributionsBridge = {
  resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }),
  resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
  resolveComposerReference: async () => { throw new Error('Unexpected reference request'); },
  resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
  afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
  transformAgentContext: async () => { throw new Error('Unexpected context transform'); },
  transformSessionInput: async () => { throw new Error('Unexpected input transform'); },
  transformAgentRequest: async () => { throw new Error('Unexpected request transform'); },
};

describe('session prompt-plan producer', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['owned', 'shared'] as const)('uses the %s published profile on each preparation for prompt, native tools and title admission', async (source) => {
    let sessionTitleUpdates: 'disabled' | 'ongoing' = 'disabled';
    let available = true;
    let listFailed = false;
    const metadata = createTestMetadata({ profileId: 'focused' });
    // HTTP is the Artifact boundary; mode checking, profile opening and prompt composition stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const row = { id: 'published-profile', ownerAccountId: 'account', access: source === 'owned' ? 'owner' : 'view', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: 'focused', name: 'Focused' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
          v: 2, id: 'focused', name: 'Focused', createdAt: 1, updatedAt: 1,
          codingPromptBehaviorOverrides: { sessionTitleUpdates },
        } }) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      if (path === '/v1/artifacts') return listFailed ? { status: 503, data: { error: 'unavailable' } }
        : { status: 200, data: available ? [row] : [] };
      if (path === '/v1/artifacts/published-profile') return available
        ? { status: 200, data: row } : { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    const settings = accountSettingsParse({ profiles: source === 'owned' ? [{ artifactId: 'published-profile' }] : [] });
    const session = createMutableApiSessionClientFixture({ metadata });
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'published-profile-test-token', encryption: null },
        accountSettingsContext: { source: 'cache', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], whenRefreshed: null, settings } },
      session,
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native-conversation', daemonBridge,
    });
    const disabled = await resolve();
    expect(disabled).not.toContain('change_title');
    const behavior = resolve.readCodingPromptBehavior?.();
    expect(behavior?.sessionTitleUpdates).toBe('disabled');
    expect(resolveSessionNativeToolDescriptors({ accountSettings: settings, profileId: 'focused',
      codingPromptBehavior: behavior, sessionId: 'test-session', memoryRecallGuidanceEnabled: false,
    }).map(tool => tool.name)).not.toContain('change_title');
    expect(shouldDenyAgentSessionTitleToolCall({ settings, profileId: 'focused', codingPromptBehavior: behavior,
      toolName: 'change_title', input: { title: 'Title' } })).toBe(true);
    const controls: Partial<SessionRuntimeControls> = {};
    const publishedControls = { readCodingPromptBehavior: () => resolve.readCodingPromptBehavior?.() ?? null };
    const policy = { getAccountSettings: () => settings,
      getCodingPromptBehavior: () => controls.readCodingPromptBehavior?.() ?? null };
    const handlers = [createProviderEnforcedPermissionHandler({ session, logPrefix: '[Test]', ...policy }),
      new CodexLikePermissionHandler({ session, logPrefix: '[Test]', ...policy })];
    // The client owns a stable controls object; the producer can attach after the handler.
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    applySessionRuntimeControls(controls, publishedControls);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    settings.codingPromptBehaviorV1 = { ...settings.codingPromptBehaviorV1, sessionTitleUpdates: 'disabled' };
    sessionTitleUpdates = 'ongoing';
    expect(await resolve()).toContain('change_title');
    expect(resolve.readCodingPromptBehavior?.()?.sessionTitleUpdates).toBe('ongoing');
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' })?.decision)
      .not.toBe('denied');
    available = false;
    // An unresolved profile uses the canonical policy owner's Account defaults.
    expect(await resolve()).not.toContain('change_title');
    expect(resolve.readCodingPromptBehavior?.()?.sessionTitleUpdates).toBe('disabled');
    available = true;
    listFailed = true;
    await expect(resolve()).rejects.toMatchObject({ code: 'list_failed' });
    expect(resolve.readCodingPromptBehavior?.()).toBeNull();
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    listFailed = false;
    expect(await resolve()).toContain('change_title');
    const controller = new AbortController();
    const cancelled = new Error('Preparation cancelled');
    controller.abort(cancelled);
    await expect(resolve({ signal: controller.signal })).rejects.toBe(cancelled);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    expect(await resolve()).toContain('change_title');
    applySessionRuntimeControls(controls, null);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' }))
      .toEqual({ decision: 'denied' });
    applySessionRuntimeControls(controls, publishedControls);
    for (const handler of handlers) expect(handler.getImmediateDecision('title', 'change_title', { title: 'Title' })?.decision)
      .not.toBe('denied');
  });

  it('re-reads selected stack documents on each preparation and revises the full plan after an edit', async () => {
    let markdown = 'Initial stack document';
    // Artifact HTTP is the boundary; document opening, stack rendering and plan revision stay real.
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      id: 'stack-doc', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) }),
    } }));
    const resolve = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'test-token', encryption: null },
        accountSettingsContext: { source: 'cache', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], whenRefreshed: null, settings: accountSettingsParse({ promptStacksV1: {
          v: 1, surfaces: { coding: [{ id: 'stack-entry', ref: { kind: 'doc', artifactId: 'stack-doc' },
            enabled: true, placement: 'system_append', editPolicy: 'user_only' }], voice: [], profilesById: {} },
        } }) } },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => null },
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false, readNativeSessionId: () => 'native-conversation',
      daemonBridge,
    });
    const first = await resolve({ baseOverride: 'Base instructions' });
    expect(first).toContain(markdown);
    const firstRevision = resolve.readStartupInstructions?.()?.revision;
    expect(firstRevision).toBe(1);
    markdown = 'Edited stack document';
    const edited = await resolve({ baseOverride: 'Base instructions' });
    expect(edited).toContain(markdown);
    expect(edited).not.toContain('Initial stack document');
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 2, instructions: edited,
    });
    expect(await resolve({ baseOverride: 'Base instructions' })).toBe(edited);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(2);
  });
  it('retains the full-plan identity and advances its revision only when composed instructions change', async () => {
    let notes = 'Initial worker boundary';
    const resolve = createSessionPromptPlanResolver({
      opts: {
        credentials: { token: 'test-session-token', encryption: null },
        agentSessionStartupInstructionsV1: {
          v: 1, id: 'voice.caller', revision: 9, instructions: 'Caller startup guidance',
        },
      },
      session: { sessionId: 'test-session', getMetadataSnapshot: () => null },
      agentId: 'codex', machineId: 'test-machine', directory: '/tmp/project',
      memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native-conversation',
      daemonBridge,
      resolveRoleContext: async () => ({
        role: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder' }, notes,
      }),
    });
    const first = await resolve({ baseOverride: 'Base instructions' });
    expect(first).toContain('Caller startup guidance');
    expect(first).toContain(BUILT_IN_ROLES_V1.builder.instructions);
    expect(first).toContain(notes);
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 9, instructions: first,
    });
    await resolve({ baseOverride: 'Base instructions' });
    expect(resolve.readStartupInstructions?.()?.revision).toBe(9);

    notes = 'Revised worker boundary';
    const revised = await resolve({ baseOverride: 'Base instructions' });
    expect(revised).toContain(notes);
    expect(resolve.readStartupInstructions?.()).toEqual({
      v: 1, id: 'happier.coding_session_plan', revision: 10, instructions: revised,
    });
    notes = 'Initial worker boundary';
    expect(await resolve({ baseOverride: 'Base instructions' })).toBe(first);
    expect(resolve.readStartupInstructions?.()?.revision).toBe(11);
    await resolve({ baseOverride: 'Base instructions' });
    expect(resolve.readStartupInstructions?.()?.revision).toBe(11);
  });
});
