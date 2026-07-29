import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';
import {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
} from './v1.js';

describe('plugin browser contributions', () => {
  it('accepts safe URL targets and action presentations without exposing browser internals', () => {
    expect(PluginBrowserTargetContributionV1Schema.parse({
      id: 'preview-target',
      title: 'Preview',
      url: 'https://preview.example.test/',
      launch: 'currentView',
      profile: 'session',
      availability: {
        when: { fact: 'host.platform', operator: 'notEquals', value: 'ios' },
        disabledWhen: { fact: 'host.feature', operator: 'enabled', value: 'preview.readOnly' },
        disabledReason: 'Preview is read-only',
      },
    })).toMatchObject({
      id: 'preview-target',
      launch: 'currentView',
      profile: 'session',
    });

    expect(PluginBrowserActionContributionV1Schema.parse({
      id: 'open-preview',
      title: 'Open preview',
      action: 'open-preview-action',
      target: 'preview-target',
      placement: 'toolbar',
      icon: 'open-outline',
      order: 10,
    })).toMatchObject({
      action: 'open-preview-action',
      target: 'preview-target',
      placement: 'toolbar',
    });
  });

  it('rejects unsafe URL schemes and browser contributions that try to own chrome or adapter internals', () => {
    expect(PluginBrowserTargetContributionV1Schema.safeParse({
      id: 'unsafe-target',
      title: 'Unsafe',
      url: 'javascript:alert(1)',
    }).success).toBe(false);

    const result = PluginBrowserActionContributionV1Schema.safeParse({
      id: 'bad-browser-action',
      title: 'Bad browser action',
      action: 'open-preview-action',
      target: 'preview-target',
      chrome: { hideAddressBar: true },
      cdp: { method: 'Page.navigate' },
      iframeRef: 'frame-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const rejectedKeys = result.error.issues.flatMap((issue) => (
        issue.code === 'unrecognized_keys' ? issue.keys : []
      ));
      expect(rejectedKeys).toEqual(expect.arrayContaining(['chrome', 'cdp', 'iframeRef']));
    }
  });

  it('registers browser targets and actions as dedicated manifest contribution families', () => {
    const parsed = PluginContributesV2Schema.parse({
      browserTargets: [{
        id: 'preview-target',
        title: 'Preview',
        url: 'https://preview.example.test/',
      }],
      browserActions: [{
        id: 'open-preview',
        title: 'Open preview',
        action: 'open-preview-action',
        target: 'preview-target',
      }],
    });

    expect(parsed.browserTargets[0]).toMatchObject({
      url: 'https://preview.example.test/',
      launch: 'newView',
      profile: 'user',
    });
    expect(parsed.browserActions[0]).toMatchObject({ placement: 'toolbar' });
  });
});
