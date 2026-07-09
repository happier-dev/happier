import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    defineSessionHeaderAction,
    defineStructuredMessage,
    defineSurfaceContribution,
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
        const surface = defineSurfaceContribution({
            mode: 'surfacePlacement',
            contribution: {
                id: 'preview-pane',
                placement: 'session.preview',
                target: { kind: 'session', sessionIdPath: '/session/id' },
                renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                display,
            },
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
        const hostedWeb = defineSurfaceContribution({
            mode: 'hostedWeb',
            contribution: {
                id: 'preview-web',
                service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                entry: { routeMode: 'hostOrigin', path: '/' },
                bridge: { allowedMessages: ['ready'] },
                sandbox: { scripts: true },
                security: {},
                fallback: { kind: 'unavailable' },
                display,
            },
        });
        const nativeBundle = defineSurfaceContribution({
            mode: 'reactNative',
            contribution: {
                id: 'native-preview',
                bundle: {
                    platform: 'ios',
                    channel: 'internal',
                    integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
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
            },
        });
        const artifact = defineUiArtifact({
            id: 'native-preview-ios',
            contributionId: 'native-preview',
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
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
        expect(artifact.integrity.digest).toBe('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });

    it('validates public helper inputs through the protocol schemas', () => {
        expect(() => defineSurfaceContribution({
            mode: 'hostedWeb',
            contribution: {
                id: 'bad-web',
                service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                // Invalid routeMode value — schema rejects at authoring time.
                entry: { routeMode: 'bogusMode' as 'hostOrigin' },
                bridge: { allowedMessages: ['ready'] },
                sandbox: { scripts: true },
                security: {},
                fallback: { kind: 'unavailable' },
                display,
            },
        })).toThrow();

        expect(() => defineSurfaceContribution({
            mode: 'reactNative',
            contribution: {
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
            },
        })).toThrow();
    });

    it('publishes React Native helper subpaths in the stable UI export tier', () => {
        const packageJson = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ) as { exports?: Record<string, unknown> };

        expect(packageJson.exports).toHaveProperty('./ui/reactNativeBuild', {
            types: './dist/ui/reactNativeBuild.d.ts',
            default: './dist/ui/reactNativeBuild.js',
        });
        expect(packageJson.exports).toHaveProperty('./ui/reactNativeBundles', {
            types: './dist/ui/reactNativeBundles.d.ts',
            default: './dist/ui/reactNativeBundles.js',
        });
        expect(packageJson.exports).toHaveProperty('./ui/reactNativeDevServer', {
            types: './dist/ui/reactNativeDevServer.d.ts',
            default: './dist/ui/reactNativeDevServer.js',
        });
        expect(packageJson.exports).toHaveProperty('./ui/reactNativeWebBuild', {
            types: './dist/ui/reactNativeWebBuild.d.ts',
            default: './dist/ui/reactNativeWebBuild.js',
        });
        expect(packageJson.exports).toHaveProperty('./ui/hostRuntimeExternalsBuildPlugin', {
            types: './dist/ui/hostRuntimeExternalsBuildPlugin.d.ts',
            default: './dist/ui/hostRuntimeExternalsBuildPlugin.js',
        });
    });

    it('routes UI subpath shared setting types through the canonical SDK UI aggregate', () => {
        const uiSubpathSource = readFileSync(new URL('./ui/index.ts', import.meta.url), 'utf8');

        expect(uiSubpathSource).toContain("export type { SettingDefinitionMap } from '../ui.js';");
        expect(uiSubpathSource).not.toContain("SettingDefinitionMap } from '@happier-dev/protocol'");
    });
});
