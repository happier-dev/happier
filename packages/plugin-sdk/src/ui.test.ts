import { describe, expect, it } from 'vitest';

import {
    defineHostedWeb,
    defineReactNativeBundle,
    defineSessionHeaderAction,
    defineSessionSurface,
    defineStructuredMessage,
    defineUiArtifact,
    defineUiTranslations,
} from './ui';

const display = {
    titleKey: 'title',
    iconToken: 'browser',
} as const;

describe('plugin UI contribution helpers', () => {
    it('preserves host-owned descriptor contribution shapes without executing plugin UI code', () => {
        const structuredMessage = defineStructuredMessage({
            id: 'preview-card',
            kind: 'acme.preview/preview-card.v1',
            payloadSchema: { type: 'object' },
            renderer: { kind: 'host', rendererId: 'summaryCard' },
            display,
        });
        const surface = defineSessionSurface({
            id: 'preview-pane',
            surfaceKind: 'previewPane',
            target: { kind: 'localService', idPath: '/previewId' },
            renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
            display,
        });
        const headerAction = defineSessionHeaderAction({
            id: 'open-preview',
            action: {
                id: 'open-preview',
                kind: 'openSurface',
                labelKey: 'title',
                target: { surfaceId: 'preview-pane' },
            },
            display,
            placement: { area: 'primary', overflow: 'auto' },
        });
        const translations = defineUiTranslations({
            locales: {
                en: {
                    title: 'Preview',
                },
            },
        });
        const hostedWeb = defineHostedWeb({
            id: 'preview-web',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            fallback: { kind: 'unavailable' },
            display,
        });
        const nativeBundle = defineReactNativeBundle({
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
        });
        const artifact = defineUiArtifact({
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
        });

        expect(structuredMessage.renderer).toEqual({ kind: 'host', rendererId: 'summaryCard' });
        expect(surface.renderer).toEqual({ kind: 'host', rendererId: 'previewPlaceholder' });
        expect(headerAction.action.kind).toBe('openSurface');
        expect(translations.locales.en?.title).toBe('Preview');
        expect(hostedWeb.service.kind).toBe('sessionEndpoint');
        expect(nativeBundle.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
        expect(artifact.integrity.digest).toBe('sha256:bundle');
    });

    it('validates public helper inputs through the protocol schemas', () => {
        expect(() => defineHostedWeb({
            id: 'bad-web',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            display,
        })).toThrow();

        expect(() => defineReactNativeBundle({
            id: 'bad-native',
            bundle: {
                platform: 'ios',
                channel: 'internal',
                integrity: { digest: 'bundle' },
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
        })).toThrow();
    });
});
