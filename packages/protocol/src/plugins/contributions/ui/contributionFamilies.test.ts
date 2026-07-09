import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';

const BUNDLE_DIGEST = `sha256:${'b'.repeat(64)}`;
const MAP_DIGEST = `sha256:${'c'.repeat(64)}`;

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
      surfacePlacements: [{
        id: 'preview-pane',
        placement: 'session.preview',
        target: { kind: 'session', sessionIdPath: '/session/id' },
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
        bridge: { allowedMessages: ['ready', 'heightChanged', 'openExternal', 'unsubscribeResource'] },
        sandbox: { scripts: true },
        security: {
          allowedConnectOrigins: ['https://api.example.test'],
          csp: {
            connectSrc: 'declaredOrigins',
            allowBlobUrls: true,
            allowInlineStyles: true,
            allowEval: false,
          },
        },
        fallback: { kind: 'unavailable' },
        display,
      }],
      reactNativeBundles: [{
        id: 'native-preview',
        bundle: {
          platform: 'ios',
          channel: 'internal',
          integrity: { digest: BUNDLE_DIGEST },
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
        integrity: { digest: BUNDLE_DIGEST },
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
    expect(parsed.surfacePlacements?.find((placement) => placement.id === 'preview-pane')?.placement).toBe('session.preview');
    expect(parsed.hostedWeb[0]?.fallback).toEqual({ kind: 'unavailable' });
    expect(parsed.hostedWeb[0]?.bridge.allowedMessages).toEqual([
      'ready',
      'heightChanged',
      'openExternal',
      'unsubscribeResource',
    ]);
    expect(parsed.hostedWeb[0]?.security).toMatchObject({
      allowedConnectOrigins: ['https://api.example.test'],
      csp: {
        connectSrc: 'declaredOrigins',
        allowBlobUrls: true,
        allowInlineStyles: true,
        allowEval: false,
      },
    });
    expect(parsed.reactNativeBundles[0]?.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
    expect(parsed.uiArtifacts[0]?.integrity?.digest).toBe(BUNDLE_DIGEST);
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

  it('allows local development UI artifact dev URLs without immutable artifact integrity', () => {
    const parsed = PluginContributesV2Schema.parse({
      uiArtifacts: [{
        id: 'native-preview-ios-dev',
        contributionId: 'native-preview',
        contributionFamily: 'reactNativeBundles',
        artifactKind: 'reactNativeBundle',
        platform: 'ios',
        channel: 'development',
        compatibility: {
          hostAppVersion: '2.0.0',
          hostUiApiVersion: '1.0.0',
          reactVersion: '19.0.0',
          reactNativeVersion: '0.83.4',
        },
        byteSize: 0,
        contentType: 'application/javascript',
        devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
      }],
    });

    expect(parsed.uiArtifacts[0]?.integrity).toBeUndefined();
    expect(parsed.uiArtifacts[0]?.devUrl).toBe('http://127.0.0.1:8082/index.bundle?platform=ios&dev=true');
  });

  it('rejects raw hosted web URLs, missing fallbacks, and production dev artifacts', () => {
    const result = PluginContributesV2Schema.safeParse({
      hostedWeb: [{
        id: 'bad-web',
        service: { kind: 'url', url: 'http://localhost:3000' },
        entry: { routeMode: 'hostOrigin' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: { scripts: true },
        security: {},
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
        integrity: { digest: BUNDLE_DIGEST },
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

  it('normalizes empty hosted web security policy to deny-by-default values', () => {
    const result = PluginContributesV2Schema.safeParse({
      hostedWeb: [{
        id: 'secure-web',
        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
        entry: { routeMode: 'hostOrigin', path: '/' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: { scripts: true },
        security: {},
        fallback: { kind: 'unavailable' },
        display,
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hostedWeb?.[0]?.security).toEqual({
        allowedNavigationOrigins: [],
        allowedCallbackOrigins: [],
        allowedConnectOrigins: [],
        csp: {
          scriptSrc: 'selfOnly',
          styleSrc: 'selfOnly',
          imgSrc: 'selfOnly',
          fontSrc: 'selfOnly',
          connectSrc: 'selfOnly',
          allowDataUrls: false,
          allowBlobUrls: false,
          allowInlineStyles: false,
          allowEval: false,
        },
        sourceMaps: 'disabled',
        mixedContent: 'deny',
      });
    }
  });

  it('rejects hosted web descriptors without a security policy or with URL globs', () => {
    const result = PluginContributesV2Schema.safeParse({
      hostedWeb: [{
        id: 'bad-web',
        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
        entry: { routeMode: 'hostOrigin' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: { scripts: true },
        security: {
          allowedConnectOrigins: ['https://api.example.test/*'],
        },
        fallback: { kind: 'unavailable' },
        display,
      }, {
        id: 'missing-policy',
        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
        entry: { routeMode: 'hostOrigin' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: { scripts: true },
        fallback: { kind: 'unavailable' },
        display,
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('hostedWeb.0.security.allowedConnectOrigins.0');
      expect(issuePaths).toContain('hostedWeb.1.security');
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
        integrity: { digest: MAP_DIGEST },
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
