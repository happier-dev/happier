import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';
import {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
} from './v1.js';

const display = {
  title: 'Preview',
  iconToken: 'browser',
  tone: 'info',
} as const;

const target = {
  kind: 'hostedPluginWeb',
  targetId: 'target_1',
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  display,
} as const;

describe('plugin browser contributions', () => {
  it('accepts declarative host-owned browser targets and actions', () => {
    expect(PluginBrowserTargetContributionV1Schema.parse({
      id: 'preview-target',
      target,
      display,
      featureGate: 'browser.viewTargets',
      order: 10,
    })).toMatchObject({ id: 'preview-target' });

    expect(PluginBrowserActionContributionV1Schema.parse({
      id: 'open-preview',
      kind: 'openTarget',
      target,
      display,
      policy: {
        requiredFeatureIds: ['browser.viewTargets'],
        profileMode: 'session',
      },
    })).toMatchObject({ kind: 'openTarget' });
  });

  it('rejects browser contributions that try to own chrome or adapter internals', () => {
    const result = PluginBrowserActionContributionV1Schema.safeParse({
      id: 'bad-browser-action',
      kind: 'openTarget',
      target,
      display,
      chrome: { hideAddressBar: true },
      cdp: { method: 'Page.navigate' },
      iframeRef: 'frame-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('chrome');
      expect(paths).toContain('cdp');
      expect(paths).toContain('iframeRef');
    }
  });

  it('registers browser targets and actions as dedicated manifest contribution families', () => {
    const parsed = PluginContributesV2Schema.parse({
      browserTargets: [{ id: 'preview-target', target, display }],
      browserActions: [{ id: 'open-preview', kind: 'openTarget', target, display }],
    });

    expect(parsed.browserTargets[0]?.target.kind).toBe('hostedPluginWeb');
    expect(parsed.browserActions[0]?.kind).toBe('openTarget');
    expect(parsed.browserActions[0]?.policy).toEqual({
      requiredFeatureIds: [],
      requiredPermissionIds: [],
    });
  });
});
