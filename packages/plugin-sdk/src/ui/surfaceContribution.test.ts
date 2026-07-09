import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as pluginSdkUi from '../ui.js';
import { defineSurfaceContribution } from './surfaceContribution';

/**
 * REG-3 — single author entry. `defineSurfaceContribution` is the ONE authoring
 * helper for every executable/declarative surface contribution; the legacy
 * `defineHostedWebUi` / `defineReactNativeBundleUi` / `defineHostedWeb` /
 * `defineReactNativeBundle` definers are deleted (no thin wrappers left behind).
 */
describe('defineSurfaceContribution — single author entry (REG-3)', () => {
    it('authors a hostedWeb surface contribution', () => {
        const contribution = defineSurfaceContribution({
            mode: 'hostedWeb',
            contribution: {
                id: 'preview-web',
                service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                entry: { routeMode: 'hostOrigin', path: '/' },
                bridge: { allowedMessages: ['ready'] },
                sandbox: { scripts: true },
                security: {
                    allowedConnectOrigins: ['https://api.example.test'],
                    csp: { connectSrc: 'declaredOrigins', allowEval: false },
                },
                fallback: { kind: 'unavailable' },
                display: { titleKey: 'preview.title' },
            },
        });

        expect(contribution.id).toBe('preview-web');
        expect(contribution.service.kind).toBe('sessionEndpoint');
        expect(contribution.security.allowedConnectOrigins).toEqual(['https://api.example.test']);
    });

    it('authors a reactNative surface contribution', () => {
        const contribution = defineSurfaceContribution({
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
                display: { titleKey: 'preview.title' },
            },
        });

        expect(contribution.id).toBe('native-preview');
        expect(contribution.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
    });

    it('rejects the retired embeddedWeb mode at runtime with a clear message (LEDGER DEC-6)', () => {
        // A non-TS (or stale-typed) caller could still pass the retired mode at
        // runtime — assert it fails closed with an actionable message instead of
        // silently falling through, even though the TInput union no longer
        // types this as a valid call.
        expect(() =>
            defineSurfaceContribution({
                mode: 'embeddedWeb',
                contribution: {},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any),
        ).toThrow(/embeddedWeb is retired/u);
    });

    it('authors a surfacePlacement (host-rendered) surface contribution', () => {
        const contribution = defineSurfaceContribution({
            mode: 'surfacePlacement',
            contribution: {
                id: 'inspector-details',
                placement: 'session.details',
                target: { kind: 'session', sessionIdPath: '/session/id' },
                renderer: { kind: 'host', rendererId: 'resourceSummary' },
                display: {
                    titleKey: 'inspector.details.title',
                    descriptionKey: 'inspector.details.description',
                    developerFallback: 'Session Inspector',
                    iconToken: 'info',
                    tone: 'info',
                },
                order: 10,
                actions: [],
                hostActions: [],
            },
        });

        expect(contribution.id).toBe('inspector-details');
        expect(contribution.placement).toBe('session.details');
    });

    it('does NOT re-export any of the deleted legacy surface definers (zero-importer gate)', () => {
        // REG-3 DONE gate: the three legacy author entries are deleted with no
        // thin-wrapper / compat layer left behind. Assert they are not exported
        // from the plugin-sdk `ui` barrel so a re-introduction fails the build.
        const LEGACY_DEFINER_EXPORTS = [
            'defineHostedWeb',
            'defineHostedWebUi',
            'defineReactNativeBundle',
            'defineReactNativeBundleUi',
            'defineSessionSurface',
            'defineSurfacePlacement',
        ] as const;
        for (const legacyExport of LEGACY_DEFINER_EXPORTS) {
            expect(
                Object.prototype.hasOwnProperty.call(pluginSdkUi, legacyExport),
                `legacy definer '${legacyExport}' must be deleted (no thin wrapper)`,
            ).toBe(false);
        }
    });

    it('declares no legacy surface definer functions in the plugin-sdk ui source tree', () => {
        // Build-failing grep: scan every `src/ui/*.ts` for a legacy definer
        // declaration. Catches a re-introduction even if it is not yet barreled.
        const uiDir = dirname(fileURLToPath(import.meta.url));
        const LEGACY_DECLARATION_PATTERNS = [
            /export\s+(?:function|const)\s+defineHostedWeb\b/,
            /export\s+(?:function|const)\s+defineHostedWebUi\b/,
            /export\s+(?:function|const)\s+defineReactNativeBundle\b/,
            /export\s+(?:function|const)\s+defineReactNativeBundleUi\b/,
            /export\s+(?:function|const)\s+defineSessionSurface\b/,
            /export\s+(?:function|const)\s+defineSurfacePlacement\b/,
        ];
        const offenders: string[] = [];
        for (const fileName of readdirSync(uiDir)) {
            if (!fileName.endsWith('.ts') || fileName.endsWith('.test.ts')) {
                continue;
            }
            const source = readFileSync(join(uiDir, fileName), 'utf8');
            for (const pattern of LEGACY_DECLARATION_PATTERNS) {
                if (pattern.test(source)) {
                    offenders.push(`${fileName}: ${pattern.source}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('rejects an invalid contribution at authoring time', () => {
        expect(() =>
            defineSurfaceContribution({
                mode: 'hostedWeb',
                contribution: {
                    id: 'broken',
                    service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                    // Invalid routeMode value — schema rejects at authoring time.
                    entry: { routeMode: 'bogusMode' as 'hostOrigin' },
                    bridge: { allowedMessages: ['ready'] },
                    sandbox: { scripts: true },
                    security: {},
                    fallback: { kind: 'unavailable' },
                    display: { titleKey: 'broken.title' },
                },
            }),
        ).toThrow();
    });
});
