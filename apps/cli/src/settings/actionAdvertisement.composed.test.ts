import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cmdSessionActionsList } from '@/cli/commands/session/actions/list';
import { cmdSessionActionsDescribe } from '@/cli/commands/session/actions/describe';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { buildVoiceAgentBootstrapPrompt, buildVoiceAgentSeededUserTurnPrompt } from '@/agent/voice/agent/voiceAgentPrompts';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from './accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from './accountSettings/accountSettingsScopeKey';

const token = 'advertisement-owner';
function publish(enabled: boolean) {
  const rawSettings = { actionsSettingsV1: { v: 1, actions: { 'review.start': { enabled }, 'session.list': { enabled, toolExposureModes: { mcp: 'direct' } } } } };
  setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKeyForToken(token), source: 'network',
    settingsVersion: enabled ? 2 : 1, settings: accountSettingsParse(rawSettings), rawSettings,
    settingsSecretsReadKeys: [], loadedAtMs: 1 });
}

describe('Action advertisement consumes Account execution policy', () => {
  beforeEach(() => { vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', ''); resetActiveAccountSettingsSnapshotForTests(); publish(false); });
  afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllEnvs(); });

  it('omits Account Off from CLI list and describe, then observes a policy replacement', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionActionsList(['actions', 'list', '--json']);
      expect(output.json()).toMatchObject({ ok: true, data: { actionSpecs: expect.not.arrayContaining([expect.objectContaining({ id: 'review.start' })]) } });
    } finally { output.restore(); }
    const description = captureConsoleJsonOutput();
    try {
      await cmdSessionActionsDescribe(['actions', 'describe', 'review.start', '--json']);
      expect(description.json()).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    } finally { description.restore(); }
    publish(true);
    const enabled = captureConsoleJsonOutput();
    try {
      await cmdSessionActionsList(['actions', 'list', '--json']);
      expect(enabled.json()).toMatchObject({ ok: true, data: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id: 'review.start' })]) } });
    } finally { enabled.restore(); }
  });

  it('omits Account Off from the default tool inventory and honors an explicit admitted policy', () => {
    expect(listBuiltInHappierTools({ surface: 'cli' }).map(tool => tool.name)).not.toContain('review_start');
    const settings = accountSettingsParse({}).actionsSettingsV1;
    expect(listBuiltInHappierTools({ surface: 'cli', actionsSettings: settings }).map(tool => tool.name)).toContain('review_start');
    publish(true);
    expect(listBuiltInHappierTools({ surface: 'cli' }).map(tool => tool.name)).toContain('review_start');
  });

  it('omits Account Off from native Voice bootstrap and seeded advertisement', () => {
    const options = { verbosity: 'short' as const, initialContext: '' };
    expect(buildVoiceAgentBootstrapPrompt({ ...options, mode: 'ready_handshake' }).includes('startReview')).toBe(false);
    expect(buildVoiceAgentSeededUserTurnPrompt({ ...options, userText: 'hello' }).includes('startReview')).toBe(false);
    publish(true);
    expect(buildVoiceAgentBootstrapPrompt({ ...options, mode: 'ready_handshake' }).includes('startReview')).toBe(true);
  });

  it('carries the prepared Voice Account policy into native prompt advertisement', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: { 'review.start': { enabled: true } } }));
    const preparation = await resolveCliVoicePromptPreparation({
      settings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: { 'review.start': { enabled: false } } } }),
      accountEntries: [], profileEntries: [], projectEntries: [], sessionEntries: [], roleContext: null,
    });
    expect(preparation.disabledActionIds).toContain('review.start');
    expect(buildVoiceAgentBootstrapPrompt({ ...preparation, verbosity: 'short', initialContext: '', mode: 'ready_handshake' }).includes('startReview'))
      .toBe(false);
  });

  it('uses credential-bound Account policy in MCP tools/list despite a permissive ambient override', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: { 'session.list': { enabled: true, toolExposureModes: { mcp: 'direct' } } } }));
    const { mcp } = createExternalMcpServer({ credentials: { token, encryption: null } });
    const client = new Client({ name: 'policy-advertisement', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('session_list');
    } finally { await client.close(); await mcp.close(); }
    publish(true);
    const enabled = createExternalMcpServer({ credentials: { token, encryption: null } });
    try { expect(enabled.toolNames).toContain('session_list'); } finally { await enabled.mcp.close(); }
  });
});
