import { describe, expect, it } from 'vitest';

import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import type { FeatureId } from '@happier-dev/protocol';

describe('resolveCliLocalFeaturePolicyEnabled', () => {
  it('does not let retired channel bridge environment keys decide local availability', () => {
    // A predecessor process can still supply these retired strings through its environment.
    const retiredFeatureCases = [
      ['channelBridges' as unknown as FeatureId, { HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '0' }],
      ['channelBridges.telegram' as unknown as FeatureId, { HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED: '0' }],
    ] as const;

    for (const [featureId, env] of retiredFeatureCases) {
      expect(resolveCliLocalFeaturePolicyEnabled(featureId, env as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('defaults voice.daemonInference to disabled when no local env override is present', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('voice.daemonInference', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('enables voice.daemonInference when the explicit local env gate is on', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('voice.daemonInference', {
      HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED: '1',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defers the server-represented plugin UI tiers to the server decision (default-allow via unlisted fallback)', () => {
    // §4.1/§13.5.3: hostedWeb / reactNativeBundles are
    // server-represented + default-ALLOW kill-switches. CLI local policy must NOT pre-empt the
    // server bit, so each defers via the unlisted-id fallback (returns true). Per-plugin trust
    // derivation (5.1/5.2) still governs actual render.
    expect(resolveCliLocalFeaturePolicyEnabled('plugins.ui.hostedWeb', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCliLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles', {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('keeps the finer reactNativeBundles.devHotReload tier client-represented + fail-closed', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles.devHotReload', {} as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveCliLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles.devHotReload', {
      HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES_DEV_HOT_RELOAD__ENABLED: '1',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defers browser.automation to the server decision and keeps the injectedPage/eval tiers fail-closed', () => {
    // browser.automation is server-represented + default-ALLOW (§13.4 — the server owns the
    // automation gate and can disable it independently), so CLI local policy must NOT pre-empt it —
    // it defaults to allow via the unlisted-id fallback so the server bit governs. The finer
    // injectedPage/eval tiers stay client-represented + fail-closed locally (operator opt-in on top
    // of the server gate).
    expect(resolveCliLocalFeaturePolicyEnabled('browser.automation', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCliLocalFeaturePolicyEnabled('browser.automation.injectedPage', {} as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveCliLocalFeaturePolicyEnabled('browser.automation.eval', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('honors the explicit env opt-in for the finer browser.automation.injectedPage/eval tiers', () => {
    expect(resolveCliLocalFeaturePolicyEnabled('browser.automation.injectedPage', {
      HAPPIER_FEATURE_BROWSER_AUTOMATION_INJECTED_PAGE__ENABLED: '1',
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCliLocalFeaturePolicyEnabled('browser.automation.eval', {
      HAPPIER_FEATURE_BROWSER_AUTOMATION_EVAL__ENABLED: '1',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('keeps local services local policy default-allow so the server decision governs the gate', () => {
    // localServices is server-represented + default-allow: CLI local policy must not pre-empt
    // the server bit, so it defaults to allow. The env key remains an explicit opt-out.
    expect(resolveCliLocalFeaturePolicyEnabled('localServices', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveCliLocalFeaturePolicyEnabled('localServices', {
      HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: '0',
    } as NodeJS.ProcessEnv)).toBe(false);
    // The destructive terminate action is no longer locally gated; the server owns the gate,
    // so local policy returns the unlisted default of allow.
    expect(resolveCliLocalFeaturePolicyEnabled('localServices.actions.terminate', {} as NodeJS.ProcessEnv)).toBe(true);
  });
});
