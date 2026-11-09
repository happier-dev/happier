import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { buildCodeBuddySubscriptionConfiguration, createCodeBuddySubscriptionLaunch } from './connectedAccounts.js';
import { CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH } from './continuity.js';

describe('CodeBuddy subscription native configuration', () => {
  it('routes an explicit model with access-only headers and omits rejected token and sampling fields', () => {
    const configuration = buildCodeBuddySubscriptionConfiguration({ modelId: 'gpt-5.6-sol', materialized: {
      kind: 'httpHeaders', headers: { authorization: 'Bearer dummy-access-only', 'chatgpt-account-id': 'fixture-account' },
    } });
    const native = JSON.parse(configuration.env.ACC_PRODUCT_CONFIG_V3);
    expect(native.models).toEqual([expect.objectContaining({ id: 'gpt-5.6-sol', api: 'openai-codex-responses',
      url: 'https://chatgpt.com/backend-api/codex', tags: ['custom'], supportsReasoning: true })]);
    expect(native.models[0]).not.toHaveProperty('maxOutputTokens');
    expect(native.models[0]).not.toHaveProperty('temperature');
    expect(native.models[0]).not.toHaveProperty('topP');
    expect(native.models[0].apiKey).toBe('dummy-access-only');
    expect(native.productFeatures.ResponsesStore).toBe(false);
    expect(configuration.env.CODEBUDDY_CODE_MAX_OUTPUT_TOKENS).toBe('');
    expect(configuration.env.CODEBUDDY_DISABLE_PRODUCT_CACHE).toBe('1');
    expect(configuration.env.CODEBUDDY_CUSTOM_HEADERS).not.toContain('dummy-access-only');
    expect(configuration.env.CODEBUDDY_CUSTOM_HEADERS).toContain('chatgpt-account-id: fixture-account');
    expect(configuration.env.CODEBUDDY_CUSTOM_HEADERS).toContain('openai-beta: responses=experimental');
    expect(JSON.stringify(configuration)).not.toContain('refreshToken');
    expect(configuration.args).toEqual(['--model', 'gpt-5.6-sol']);
    const launch = createCodeBuddySubscriptionLaunch(configuration);
    const settingsPath = launch.args[launch.args.indexOf('--settings') + 1];
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings.alwaysThinkingEnabled).toBe(true);
      expect(settings.env.CODEBUDDY_CUSTOM_HEADERS).toContain('chatgpt-account-id: fixture-account');
      // Native CliSettingsProvider logs settings; authorization is supplied by
      // model.apiKey after native custom-header merging, never by this file.
      expect(JSON.stringify(settings)).not.toContain('dummy-access-only');
      expect(launch.args.join(' ')).not.toContain('dummy-access-only');
      if (process.platform !== 'win32') expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally { launch.dispose(); }
    expect(existsSync(settingsPath)).toBe(false);
  });

  it.each(['', '  '])('refuses an absent explicit model %j', (modelId) => {
    expect(() => buildCodeBuddySubscriptionConfiguration({ modelId, materialized: {
      kind: 'httpHeaders', headers: { authorization: 'Bearer dummy', 'chatgpt-account-id': 'fixture' },
    } })).toThrow(expect.objectContaining({ code: 'codebuddy_subscription_model_required' }));
  });

  it('refuses materialization without the selected account identity', () => {
    expect(() => buildCodeBuddySubscriptionConfiguration({ modelId: 'gpt-5.6-sol', materialized: {
      kind: 'httpHeaders', headers: { authorization: 'Bearer dummy' },
    } })).toThrow(expect.objectContaining({ code: 'codebuddy_subscription_materialization_invalid' }));
  });

  it('requires restart for static-token rotation and refuses unverifiable native account adoption', async () => {
    const adapter = CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.runtimeAuthAdapter;
    expect(adapter.canHotApply()).toMatchObject({ status: 'unsupported', recovery: 'restart_resume', applied: false });
    expect(await adapter.verifyActiveAccount()).toMatchObject({ status: 'unavailable', retryable: false });
    expect(await CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH.continuity.verifyResumeReachable()).toMatchObject({ ok: false });
  });
});
