import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveGrokAcpAuthentication } from './auth';
import { buildGrokAcpBackendOptions, resolveGrokXaiApiKeyPresence } from './backend';

describe('Grok ACP backend options', () => {
  let root = '';
  let executable = '';
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalOverride = process.env.HAPPIER_GROK_PATH;
    root = mkdtempSync(join(tmpdir(), 'happier-grok-backend-'));
    executable = join(root, process.platform === 'win32' ? 'grok.exe' : 'grok');
    writeFileSync(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    process.env.HAPPIER_GROK_PATH = executable;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.HAPPIER_GROK_PATH;
    else process.env.HAPPIER_GROK_PATH = originalOverride;
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the managed resolver and exact automation argv', () => {
    const options = buildGrokAcpBackendOptions({ cwd: root });
    expect(options.command).toBe(executable);
    expect(options.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
  });

  it('passes provider environment without adding speculative aliases or flags', () => {
    const options = buildGrokAcpBackendOptions({
      cwd: root,
      env: { XAI_API_KEY: '  secret-value  ', GROK_TEST_SENTINEL: 'yes' },
    });
    expect(options.env).toEqual({ XAI_API_KEY: '  secret-value  ', GROK_TEST_SENTINEL: 'yes' });
    expect(options.args).not.toContain('--no-leader');
    expect(options.env).not.toHaveProperty('GROK_CODE_XAI_API_KEY');
    expect(options.env).not.toHaveProperty('GROK_OAUTH2_REFERRER');
  });

  it('captures only API-key presence in the authentication resolver', () => {
    const options = buildGrokAcpBackendOptions({ cwd: root, env: { XAI_API_KEY: 'secret-value' } });
    expect(options.authentication).toMatchObject({ kind: 'resolve-after-initialize' });
    expect(JSON.stringify(options.authentication)).not.toContain('secret-value');
    if (options.authentication?.kind !== 'resolve-after-initialize') {
      throw new Error('Expected dynamic Grok authentication');
    }
    expect(options.authentication.resolve({
      advertisedMethodIds: new Set(['xai.api_key']),
      initializeMeta: null,
    })).toEqual({ methodId: 'xai.api_key', meta: { headless: true } });
  });

  it.each([
    {
      name: 'accepts an inherited exact-case key on POSIX',
      platform: 'linux' as const,
      inheritedEnv: { XAI_API_KEY: '  inherited-secret  ' },
      overrideEnv: undefined,
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'ignores an inherited differently-cased key on POSIX',
      platform: 'darwin' as const,
      inheritedEnv: { xai_api_key: 'inherited-secret' },
      overrideEnv: undefined,
      expectedMethodId: 'cached_token',
      expectedUnsetInherited: false,
    },
    {
      name: 'accepts an inherited differently-cased key on Windows',
      platform: 'win32' as const,
      inheritedEnv: { xai_api_key: '  inherited-secret  ' },
      overrideEnv: undefined,
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'lets a differently-cased blank Windows override shadow an inherited key',
      platform: 'win32' as const,
      inheritedEnv: { XAI_API_KEY: 'inherited-secret' },
      overrideEnv: { xai_api_key: '   ' },
      expectedMethodId: 'cached_token',
      expectedUnsetInherited: true,
    },
    {
      name: 'does not let a differently-cased POSIX override shadow an inherited key',
      platform: 'linux' as const,
      inheritedEnv: { XAI_API_KEY: 'inherited-secret' },
      overrideEnv: { xai_api_key: '   ' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'uses a differently-cased nonblank Windows override over an inherited blank value',
      platform: 'win32' as const,
      inheritedEnv: { XAI_API_KEY: '   ' },
      overrideEnv: { Xai_Api_Key: '\t override-secret \n' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: true,
    },
    {
      name: 'uses the lexicographically first Windows override when casing variants coexist',
      platform: 'win32' as const,
      inheritedEnv: {},
      overrideEnv: { xai_api_key: '   ', XAI_API_KEY: 'override-secret' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: true,
    },
  ])('$name', ({ platform, inheritedEnv, overrideEnv, expectedMethodId, expectedUnsetInherited }) => {
    const presence = resolveGrokXaiApiKeyPresence({
      inheritedEnv,
      overrideEnv,
      platform,
    });
    const authentication = resolveGrokAcpAuthentication({
      advertisedMethodIds: new Set(['xai.api_key', 'cached_token']),
      initializeMeta: { defaultAuthMethodId: 'cached_token' },
    }, presence.hasXaiApiKey);

    expect(authentication).toEqual({ methodId: expectedMethodId, meta: { headless: true } });
    expect(presence.unsetInheritedXaiApiKey).toBe(expectedUnsetInherited);
    expect(JSON.stringify({ presence, authentication })).not.toContain('secret');
  });

  it('owns xAI prompt completion for every Grok session and questions only when the permission owner is present', () => {
    const permissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' as const }),
    };
    const withPermissionOwner = buildGrokAcpBackendOptions({ cwd: root, permissionHandler });
    expect(withPermissionOwner.extensionHandlers?.map(({ kind, method }) => `${kind}:${method}`).sort()).toEqual([
      'notification:_x.ai/mcp/servers_updated',
      'notification:_x.ai/session/prompt_complete',
      'notification:x.ai/session/prompt_complete',
      'request:_x.ai/ask_user_question',
      'request:x.ai/ask_user_question',
    ]);
    expect(withPermissionOwner.promptCompletion?.buildRequestMeta({ correlationId: 'prompt-1' })).toEqual({
      promptId: 'prompt-1',
      requestId: 'prompt-1',
    });
    expect(withPermissionOwner.permissionHandler).toBe(permissionHandler);

    const withoutPermissionOwner = buildGrokAcpBackendOptions({ cwd: root });
    expect(withoutPermissionOwner.extensionHandlers?.map(({ kind, method }) => `${kind}:${method}`).sort()).toEqual([
      'notification:_x.ai/mcp/servers_updated',
      'notification:_x.ai/session/prompt_complete',
      'notification:x.ai/session/prompt_complete',
    ]);
  });

  it('registers native session notifications only when the live-session adapter is supplied', () => {
    const sessionNotificationObserver = async () => undefined;
    const methods = buildGrokAcpBackendOptions({
      cwd: root,
      sessionNotificationObserver,
    }).extensionHandlers?.map(({ kind, method }) => `${kind}:${method}`);

    expect(methods).toContain('notification:x.ai/session_notification');
    expect(methods).toContain('notification:_x.ai/session_notification');
    expect(methods).toContain('notification:x.ai/session/update');
    expect(methods).toContain('notification:_x.ai/session/update');
    expect(buildGrokAcpBackendOptions({ cwd: root }).extensionHandlers
      ?.map(({ method }) => method)).not.toContain('x.ai/session_notification');
  });

  it('owns in-flight steer through x.ai/interject without falling back to concurrent session/prompt', () => {
    const steer = buildGrokAcpBackendOptions({ cwd: root }).inFlightSteer;

    expect(steer).toBeDefined();
    expect(steer?.method).toBe('x.ai/interject');
    expect(steer?.buildParams({
      sessionId: 'grok-session-1',
      prompt: 'change direction',
      deliveryIdentity: {
        localId: 'pending-message-1',
        localIds: ['pending-message-1'],
        userMessageSeq: 17,
        userMessageSeqs: [17],
      },
    })).toEqual({
      sessionId: 'grok-session-1',
      text: 'change direction',
      interjectionId: 'pending-message-1',
    });
    expect(steer?.isAccepted({ status: 'queued' })).toBe(true);
    expect(steer?.isAccepted({ status: 'unknown' })).toBe(false);
  });

  it('projects Grok prompt usage without double-counting overlapping token classes', () => {
    const usage = buildGrokAcpBackendOptions({ cwd: root }).promptUsageAdapter;

    expect(usage?.project({
      usage: {
        inputTokens: 70,
        outputTokens: 30,
        cachedReadTokens: 20,
        cacheCreationTokens: 5,
        reasoningTokens: 10,
        costUsdTicks: 2_500_000_000,
        costIsPartial: false,
        usageIsIncomplete: false,
      },
      promptResponse: {},
    })).toEqual({
      tokens: {
        total: 100,
        input: 70,
        output: 30,
        cache_read: 20,
        cache_creation: 5,
        thought: 10,
      },
      cost: { total: 0.25 },
    });

    expect(usage?.project({
      usage: {
        totalTokens: 100,
        inputTokens: 70,
        outputTokens: 30,
        costUsdTicks: 2_500_000_000,
        costIsPartial: true,
      },
      promptResponse: {},
    })).toEqual({
      tokens: { total: 100, input: 70, output: 30 },
    });
  });

  it('projects only well-formed per-model reasoning effort metadata', () => {
    const adapter = buildGrokAcpBackendOptions({ cwd: root }).sessionModelAdapter;
    expect(adapter).toBeDefined();

    expect(adapter?.projectModelOptions?.({
      rawModel: {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: 'high',
          reasoningEfforts: [
            { id: 'low', value: 'low', label: 'Low Effort' },
            { id: 'medium', value: 'medium', label: 'Medium Effort' },
            { id: 'high', value: 'high', label: 'High Effort', description: 'More reasoning' },
            { value: 'max' },
          ],
        },
      },
      normalizedModelOptions: [],
    })).toEqual([{
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High', description: 'More reasoning' },
        { value: 'max', name: 'Max' },
      ],
    }]);

    expect(adapter?.projectModel?.({
      rawModel: {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        _meta: { totalContextTokens: 256_000 },
      },
      normalizedModel: { id: 'grok-4.5', name: 'Grok 4.5' },
    })).toEqual({
      id: 'grok-4.5',
      name: 'Grok 4.5',
      contextWindowTokens: 256_000,
    });

    expect(adapter?.projectModelOptions?.({
      rawModel: {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: 'high',
        },
      },
      normalizedModelOptions: [],
    })).toEqual([{
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'xhigh', name: 'XHigh', description: 'Extended reasoning' },
        { value: 'high', name: 'High', description: 'Heavy reasoning' },
        { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
        { value: 'low', name: 'Low', description: 'Faster, lighter reasoning' },
      ],
    }]);

    for (const meta of [
      undefined,
      { supportsReasoningEffort: false, reasoningEffort: 'high', reasoningEfforts: [{ value: 'high' }] },
      { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ value: 'low' }] },
      { supportsReasoningEffort: true, reasoningEffort: ' high ', reasoningEfforts: [{ value: ' high ' }] },
    ]) {
      expect(adapter?.projectModelOptions?.({
        rawModel: { id: 'grok-4.5', name: 'Grok 4.5', ...(meta ? { meta } : {}) },
        normalizedModelOptions: [],
      })).toEqual([]);
    }

    for (const reasoningEfforts of [
      [{ value: 'high' }, 1],
      [{ value: 'high' }, { value: 'high' }],
      [{ value: 'high', label: ' ' }],
    ]) {
      expect(adapter?.projectModelOptions?.({
        rawModel: {
          id: 'grok-4.5',
          name: 'Grok 4.5',
          meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts },
        },
        normalizedModelOptions: [],
      })?.[0]?.options).toEqual([
        { value: 'xhigh', name: 'XHigh', description: 'Extended reasoning' },
        { value: 'high', name: 'High', description: 'Heavy reasoning' },
        { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
        { value: 'low', name: 'Low', description: 'Faster, lighter reasoning' },
      ]);
    }
  });
});
