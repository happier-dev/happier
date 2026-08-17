import { describe, expect, it } from 'vitest';

import { PluginUiRendererV2Schema } from '../contributions/ui/v2.js';
import {
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1,
} from '../contributions/ui/surfaceRegistry.js';
import {
  PLUGIN_HOSTED_WEB_BRIDGE_LIFECYCLE_KINDS_V1,
  PLUGIN_HOSTED_WEB_BRIDGE_OPERATION_KINDS_V1,
  PluginHostedWebBridgeMessageKindV1Schema,
} from '../contributions/ui/hostedWeb.js';
import {
  PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1,
  PluginUiHostApiDiagnosticV1Schema,
  PluginUiHostApiOpenExternalLinkRequestV1Schema,
  PluginUiHostApiRequestEnvelopeV1Schema,
  PluginUiHostApiWriteClipboardRequestV1Schema,
} from './hostApiRequests.js';
import { PluginUiHostApiWireEnvelopeV1Schema } from './hostApiWire.js';
import {
  PLUGIN_UI_HOST_API_VERSION_V1,
  PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1,
  PLUGIN_UI_HOST_METHODS_V1,
  PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
  PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1,
  PluginUiHostMethodV1Schema,
  isPluginUiHostApiVersionCompatibleV1,
} from './hostApi.js';

const NOT_A_HOST_METHOD = '__not_a_host_method__';

const surface = {
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  surfaceId: 'sessionSurface:acme.preview:preview-pane',
  sessionId: 'session-1',
  placement: 'sessionPane',
  platform: 'web',
  channel: 'internal',
} as const;

const wireIdentity = {
  pluginId: 'acme.preview',
  pluginVersion: '1.0.0',
  viewId: 'preview-pane',
  generation: 'gen-1',
} as const;

function parseRendererWithRequiredMethods(method: string): boolean {
  return PluginUiRendererV2Schema.safeParse({
    id: 'preview',
    kind: 'reactNative',
    artifact: 'preview-bundle',
    requiredHostMethods: [method],
  }).success;
}

function parseRequestEnvelopeMethod(method: string): boolean {
  return PluginUiHostApiRequestEnvelopeV1Schema.safeParse({
    version: 1,
    requestId: 'req-1',
    surface,
    method,
  }).success;
}

function parseWireRequestMethod(method: string): boolean {
  return PluginUiHostApiWireEnvelopeV1Schema.safeParse({
    wireVersion: 1,
    identity: wireIdentity,
    requestId: 'req-1',
    kind: 'request',
    method,
  }).success;
}

function parseWireResultMethod(method: string): boolean {
  return PluginUiHostApiWireEnvelopeV1Schema.safeParse({
    wireVersion: 1,
    identity: wireIdentity,
    requestId: 'req-1',
    kind: 'result',
    method,
  }).success;
}

function parseHostMethod(method: string): boolean {
  return PluginUiHostMethodV1Schema.safeParse(method).success;
}

/**
 * SDK-EU-28 direct-cut closure. The canonical tuple is the only place a
 * host-method name is written down. Its complete produced vocabulary is the
 * initial semantic 1.0 contract: no staged/released projection or later
 * semantic version can withhold an already-produced method from a consumer.
 */
describe('plugin UI initial host-method vocabulary closure', () => {
  it('publishes Composer document operations and one generalized disposer', () => {
    const composerMethods = [
      'activeComposer',
      'readComposer',
      'watchComposer',
      'applyComposer',
      'focusComposer',
      'setComposerDecorations',
      'acquireComposerInputLock',
      'pickComposerMedia',
      'inspectComposerContent',
      'releaseComposerContent',
    ];

    for (const method of composerMethods) {
      expect(PLUGIN_UI_HOST_METHODS_V1).toContain(method);
      expect(parseRendererWithRequiredMethods(method)).toBe(true);
      expect(parseHostMethod(method)).toBe(true);
      expect(parseRequestEnvelopeMethod(method)).toBe(true);
      expect(parseWireRequestMethod(method)).toBe(true);
      expect(parseWireResultMethod(method)).toBe(true);
    }
    expect(PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1).toEqual(expect.arrayContaining([
      'watchComposer',
      'acquireComposerInputLock',
    ]));
    expect(PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1).toEqual(['disposeHostResource']);
  });

  it('publishes same-page location replacement as a declarable host method', () => {
    // A page's own location is not a destination selection. `openSurface`
    // pushes; this is the one declarable capability that does not, so a page
    // can keep its filters/selection shareable without burying the user's
    // previous screen. It must be declarable, requirable and wire-carried like
    // every other method, or a renderer could not negotiate it.
    expect(PLUGIN_UI_HOST_METHODS_V1).toContain('replacePageLocation');
    expect(parseRendererWithRequiredMethods('replacePageLocation')).toBe(true);
    expect(parseHostMethod('replacePageLocation')).toBe(true);
    expect(parseRequestEnvelopeMethod('replacePageLocation')).toBe(true);
    expect(parseWireRequestMethod('replacePageLocation')).toBe(true);
    expect(parseWireResultMethod('replacePageLocation')).toBe(true);
    // It answers one request; it is not a subscription and never pushes.
    expect(PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1).not.toContain('replacePageLocation');
  });

  it('makes selectActionInput part of the sole initial 1.0 declaration contract', () => {
    expect(PLUGIN_UI_HOST_API_VERSION_V1).toBe('1.0.0');
    expect(PLUGIN_UI_HOST_METHODS_V1).toContain('selectActionInput');
    expect(PluginUiHostMethodV1Schema.options).toEqual([...PLUGIN_UI_HOST_METHODS_V1]);

    // This would pass if selection remained transport-only or a 1.2-only
    // capability. It must instead be declarable by the one final initial API.
    expect(parseRendererWithRequiredMethods('selectActionInput')).toBe(true);
    expect(parseHostMethod('selectActionInput')).toBe(true);
    expect(parseRequestEnvelopeMethod('selectActionInput')).toBe(true);
    expect(parseWireRequestMethod('selectActionInput')).toBe(true);
    expect(parseWireResultMethod('selectActionInput')).toBe(true);
  });

  it('owns the one compatible Host API range rather than comparing a draft literal', () => {
    expect(PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1).toBe('^1.0.0');
    for (const range of ['^1', '^1.0.0', '>=1.0.0 <2.0.0']) {
      expect(isPluginUiHostApiVersionCompatibleV1(range)).toBe(true);
    }
    for (const range of ['^2.0.0', '<1.0.0', 'not-a-semver-range']) {
      expect(isPluginUiHostApiVersionCompatibleV1(range)).toBe(false);
    }
  });

  it('owns strict diagnostic and utility-effect request grammars at the Host API boundary', () => {
    expect(PluginUiHostApiDiagnosticV1Schema.safeParse({
      code: 'plugin.ui.ready',
      severity: 'info',
      remediation: { kind: 'openUrl', url: 'https://example.test/help' },
    }).success).toBe(true);
    expect(PluginUiHostApiDiagnosticV1Schema.safeParse({
      code: 'plugin.ui.ready', severity: 'info', unexpected: true,
    }).success).toBe(false);
    expect(PluginUiHostApiDiagnosticV1Schema.safeParse({
      code: 'plugin.ui.ready',
      severity: 'info',
      message: 'x'.repeat(PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1),
    }).success).toBe(false);
    expect(PluginUiHostApiWriteClipboardRequestV1Schema.safeParse({ value: 'review link' }).success).toBe(true);
    expect(PluginUiHostApiWriteClipboardRequestV1Schema.safeParse({ value: 'review link', extra: true }).success).toBe(false);
    expect(PluginUiHostApiOpenExternalLinkRequestV1Schema.safeParse({ url: 'https://example.test/review' }).success).toBe(true);
    expect(PluginUiHostApiOpenExternalLinkRequestV1Schema.safeParse({ url: 3 }).success).toBe(false);
  });

  it.each([...PLUGIN_UI_HOST_METHODS_V1])(
    'accepts %s through every derived declaration and transport boundary',
    (method) => {
      expect(parseRendererWithRequiredMethods(method)).toBe(true);
      expect(parseHostMethod(method)).toBe(true);
      expect(parseRequestEnvelopeMethod(method)).toBe(true);
      expect(parseWireRequestMethod(method)).toBe(true);
      expect(parseWireResultMethod(method)).toBe(true);
    },
  );

  it('keeps every destination slot and subscription subset within their canonical owners', () => {
    expect(PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.length).toBeGreaterThan(0);
    for (const method of PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1) {
      expect(PLUGIN_UI_HOST_METHODS_V1).toContain(method);
    }
  });

  it('admits host API calls only through the hostApi outer wrapper', () => {
    expect([...PluginHostedWebBridgeMessageKindV1Schema.options].sort()).toEqual([
      ...PLUGIN_HOSTED_WEB_BRIDGE_LIFECYCLE_KINDS_V1,
      ...PLUGIN_HOSTED_WEB_BRIDGE_OPERATION_KINDS_V1,
    ].sort());
    expect(PluginHostedWebBridgeMessageKindV1Schema.safeParse('hostApi').success).toBe(true);
    for (const method of PLUGIN_UI_HOST_METHODS_V1) {
      expect(PluginHostedWebBridgeMessageKindV1Schema.safeParse(method).success).toBe(false);
    }
    expect(PluginHostedWebBridgeMessageKindV1Schema.safeParse('requestHostAction').success).toBe(false);
    expect(PluginHostedWebBridgeMessageKindV1Schema.safeParse('requestSessionResource').success).toBe(false);
    expect(PluginHostedWebBridgeMessageKindV1Schema.safeParse('copy').success).toBe(false);
  });

  it('rejects a method the canonical producer does not declare everywhere', () => {
    expect(PluginUiHostMethodV1Schema.safeParse(NOT_A_HOST_METHOD).success).toBe(false);
    expect(parseRendererWithRequiredMethods(NOT_A_HOST_METHOD)).toBe(false);
    expect(parseHostMethod(NOT_A_HOST_METHOD)).toBe(false);
    expect(parseRequestEnvelopeMethod(NOT_A_HOST_METHOD)).toBe(false);
    expect(parseWireRequestMethod(NOT_A_HOST_METHOD)).toBe(false);
    expect(parseWireResultMethod(NOT_A_HOST_METHOD)).toBe(false);
  });
});
