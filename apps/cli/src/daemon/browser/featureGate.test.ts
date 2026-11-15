import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

import { createBrowserDaemonFeatureGate } from './featureGate';

function readySnapshot(
  browser: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    features: FeaturesResponseSchema.parse({ features: { ...extras, browser } }),
  };
}

const ALL_BROWSER_ENABLED = {
  enabled: true,
  viewTargets: { enabled: true },
  internal: { enabled: true },
  sidecar: { enabled: true },
  diagnostics: { enabled: true },
  context: { enabled: true },
  automation: { enabled: true },
  recording: { enabled: true, attachments: { enabled: true } },
};

const ALL_BROWSER_DISABLED = {
  enabled: true,
  viewTargets: { enabled: true },
  internal: { enabled: true },
  sidecar: { enabled: false },
  diagnostics: { enabled: false },
  context: { enabled: false },
  automation: { enabled: false },
  recording: { enabled: false, attachments: { enabled: false } },
};

const ATTACHMENTS_UPLOADS_ENABLED = {
  attachments: { uploads: { enabled: true } },
};

describe('createBrowserDaemonFeatureGate', () => {
  it('resolves each refreshed decision once while event reads consume the current result', async () => {
    let envReads = 0;
    let snapshot = readySnapshot(ALL_BROWSER_ENABLED);
    const env = new Proxy({}, { get: () => { envReads++; return undefined; } });
    const gate = createBrowserDaemonFeatureGate({ env, resolveServerFeaturesSnapshot: () => snapshot });
    await gate.refresh();
    const afterRefresh = envReads;
    for (let event = 0; event < 100; event++) expect(gate.isEnabled('browser.diagnostics')).toBe(true);
    expect(envReads - afterRefresh).toBe(0);
    snapshot = readySnapshot(ALL_BROWSER_DISABLED);
    await gate.refresh();
    expect(gate.isEnabled('browser.diagnostics')).toBe(false);
  });
  it('is fail-closed with no server snapshot', () => {
    const gate = createBrowserDaemonFeatureGate({
      env: { HAPPIER_FEATURE_BROWSER_AUTOMATION__ENABLED: '1' },
      resolveServerFeaturesSnapshot: () => undefined,
    });

    for (const id of ['browser.sidecar', 'browser.context', 'browser.diagnostics', 'browser.recording', 'browser.recording.attachments', 'browser.automation'] as const) {
      expect(gate.isEnabled(id)).toBe(false);
    }
  });

  it('is enabled when the server snapshot enables the child gate', async () => {
    const gate = createBrowserDaemonFeatureGate({
      env: {},
      resolveServerFeaturesSnapshot: () => readySnapshot(ALL_BROWSER_ENABLED, ATTACHMENTS_UPLOADS_ENABLED),
    });

    await gate.refresh();

    // Automation is now server-represented like sidecar/context/diagnostics/recording — the daemon
    // gate follows the server snapshot bit, not a local env opt-in.
    for (const id of ['browser.sidecar', 'browser.context', 'browser.diagnostics', 'browser.recording', 'browser.recording.attachments', 'browser.automation'] as const) {
      expect(gate.isEnabled(id)).toBe(true);
    }
  });

  it('is disabled when the server disables the child gate', async () => {
    const gate = createBrowserDaemonFeatureGate({
      env: {},
      resolveServerFeaturesSnapshot: () => readySnapshot(ALL_BROWSER_DISABLED),
    });

    await gate.refresh();

    for (const id of ['browser.sidecar', 'browser.context', 'browser.diagnostics', 'browser.recording', 'browser.recording.attachments', 'browser.automation'] as const) {
      expect(gate.isEnabled(id)).toBe(false);
    }
  });

  it('keeps the prior snapshot when a later refresh throws', async () => {
    let call = 0;
    const gate = createBrowserDaemonFeatureGate({
      env: {},
      resolveServerFeaturesSnapshot: () => {
        call += 1;
        if (call === 1) return readySnapshot(ALL_BROWSER_ENABLED);
        throw new Error('provider failed');
      },
    });

    await gate.refresh();
    expect(gate.isEnabled('browser.context')).toBe(true);
    await gate.refresh();
    expect(gate.isEnabled('browser.context')).toBe(true);
  });
});
