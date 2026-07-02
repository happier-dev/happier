import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';

const display = {
  titleKey: 'title',
  descriptionKey: 'description',
  iconToken: 'browser',
  tone: 'info',
};

describe('plugin UI contribution families', () => {
  it('accepts valid host-owned plugin UI contribution families', () => {
    const parsed = PluginContributesV2Schema.parse({
      uiTranslations: [{
        locales: {
          en: {
            title: 'Preview',
            description: 'Open the preview',
          },
        },
      }],
      structuredMessages: [{
        id: 'preview-card',
        kind: 'acme.preview/preview-card.v1',
        payloadSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'url' },
          },
        },
        renderer: { kind: 'host', rendererId: 'summaryCard' },
        display,
      }],
      sessionSurfaces: [{
        id: 'preview-pane',
        surfaceKind: 'previewPane',
        target: { kind: 'localService', idPath: '/previewId' },
        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
        display,
      }],
      sessionHeaderActions: [{
        id: 'open-preview',
        action: {
          id: 'open-preview',
          kind: 'openSurface',
          labelKey: 'title',
          target: { surfaceId: 'preview-pane' },
        },
        display,
        placement: { area: 'primary', overflow: 'auto' },
      }],
      hostedWeb: [{
        id: 'preview-web',
        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
        entry: { routeMode: 'hostOrigin', path: '/' },
        bridge: { allowedMessages: ['ready', 'heightChanged'] },
        sandbox: { scripts: true },
        fallback: { kind: 'unavailable' },
        display,
      }],
      reactNativeBundles: [{
        id: 'native-preview',
        bundle: {
          platform: 'ios',
          channel: 'internal',
          integrity: { digest: 'sha256:bundle' },
        },
        entry: { exportName: 'renderSurface' },
        compatibility: {
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.79.0',
          supportedPlatforms: ['ios'],
          supportedChannels: ['internal'],
        },
        hostApi: { minVersion: '1.0.0' },
        fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        display,
      }],
      uiArtifacts: [{
        id: 'native-preview-ios',
        contributionId: 'native-preview',
        contributionFamily: 'reactNativeBundles',
        artifactKind: 'reactNativeBundle',
        platform: 'ios',
        channel: 'internal',
        integrity: { digest: 'sha256:bundle' },
        compatibility: {
          hostAppVersion: '2.0.0',
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.79.0',
        },
        byteSize: 1024,
        contentType: 'application/javascript',
      }],
    });

    expect(parsed.structuredMessages[0]?.kind).toBe('acme.preview/preview-card.v1');
    expect(parsed.sessionSurfaces[0]?.surfaceKind).toBe('previewPane');
    expect(parsed.hostedWeb[0]?.fallback).toEqual({ kind: 'unavailable' });
    expect(parsed.reactNativeBundles[0]?.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
    expect(parsed.uiArtifacts[0]?.integrity.digest).toBe('sha256:bundle');
  });

  it('rejects descriptor-only UI contributions that try to name raw host implementation details', () => {
    const result = PluginContributesV2Schema.safeParse({
      structuredMessages: [{
        id: 'bad-card',
        kind: 'acme.preview/bad-card.v1',
        payloadSchema: { type: 'object' },
        renderer: { kind: 'component', importPath: './BadCard' },
        display: {
          title: 'Bad card',
          iconFamily: 'Ionicons',
          color: '#fff',
        },
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('structuredMessages.0.renderer.kind');
    }
  });

  it('rejects raw hosted web URLs, missing fallbacks, and production dev artifacts', () => {
    const result = PluginContributesV2Schema.safeParse({
      hostedWeb: [{
        id: 'bad-web',
        service: { kind: 'url', url: 'http://localhost:3000' },
        entry: { routeMode: 'hostOrigin' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: { scripts: true },
        display,
      }],
      uiArtifacts: [{
        id: 'bad-web-assets',
        contributionId: 'bad-web',
        contributionFamily: 'hostedWeb',
        artifactKind: 'hostedWebAsset',
        platform: 'web',
        channel: 'store',
        devUrl: 'http://localhost:3000',
        integrity: { digest: 'sha256:asset' },
        compatibility: { hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0' },
        byteSize: 12,
        contentType: 'text/html',
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('hostedWeb.0.service.kind');
      expect(issuePaths).toContain('hostedWeb.0.fallback');
      expect(issuePaths).toContain('uiArtifacts.0.devUrl');
    }
  });

  it('requires exact RN runtime compatibility and executable artifact integrity', () => {
    const result = PluginContributesV2Schema.safeParse({
      reactNativeBundles: [{
        id: 'bad-native',
        bundle: {
          platform: 'ios',
          channel: 'store',
          integrity: {},
        },
        entry: { exportName: 'renderSurface' },
        compatibility: {
          hostUiApiVersion: '1.0.0',
          reactVersion: '*',
          reactNativeVersion: '0.79.0',
          supportedPlatforms: ['ios'],
          supportedChannels: ['store'],
        },
        hostApi: { minVersion: '1.0.0' },
        display,
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('reactNativeBundles.0.bundle.integrity.digest');
      expect(issuePaths).toContain('reactNativeBundles.0.compatibility.reactVersion');
      expect(issuePaths).toContain('reactNativeBundles.0.fallback');
    }
  });

  it('requires React Native source map artifacts to belong to React Native bundle contributions', () => {
    const result = PluginContributesV2Schema.safeParse({
      uiArtifacts: [{
        id: 'native-preview-ios-map',
        contributionId: 'native-preview',
        contributionFamily: 'hostedWeb',
        artifactKind: 'reactNativeSourceMap',
        platform: 'ios',
        channel: 'internal',
        integrity: { digest: 'sha256:map' },
        compatibility: {
          hostAppVersion: '2.0.0',
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.79.0',
        },
        byteSize: 512,
        contentType: 'application/json',
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'uiArtifacts.0.contributionFamily',
      );
    }
  });
});
