import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as pluginUi from './ui';
import * as pluginUiBuild from './ui/build/index.js';
import * as hostedWebClient from './ui/client';
import type { PluginUiHostApi as ClientPluginUiHostApi } from './ui.js';

import { defineHostedWebBridgeMessage } from './experimental/uiHostedWebBridgeV1.js';

type AssertNever<T extends never> = T;
type _UiAggregateMustNotExportHostedWebFactory = AssertNever<
    Extract<keyof typeof pluginUi, 'createPluginUiHostApiClient' | 'CreatePluginUiHostApiClientOptions'>
>;
type _ClientMustExportDomainApi = ClientPluginUiHostApi;

describe('plugin UI public surface', () => {
    it('publishes only the canonical UI entrypoints', () => {
        const packageJson = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ) as { exports?: Record<string, unknown> };

        for (const subpath of ['./ui', './ui/client', './ui/build']) {
            expect(packageJson.exports, subpath).toHaveProperty(subpath);
        }
        for (const removed of [
            './ui/hostedWeb',
            './ui/hostedWebBuild',
            './ui/reactNativeBuild',
            './ui/reactNativeWebBuild',
            './ui/reactNativeBundles',
            './ui/reactNativeDevServer',
            './ui/hostRuntimeExternalsBuildPlugin',
        ]) {
            expect(packageJson.exports?.[removed], removed).toBeUndefined();
        }
        expect(pluginUiBuild).not.toHaveProperty('createManagedRuntimeBundlerRunner');
        expect(defineHostedWebBridgeMessage({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            nonce: 'nonce-1',
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        }).kind).toBe('ready');
    });

    it('keeps settings convenience types out of the normal UI aggregate', () => {
        const uiSubpathSource = readFileSync(new URL('./ui/index.ts', import.meta.url), 'utf8');

        expect(readFileSync(new URL('./ui.ts', import.meta.url), 'utf8')).not.toContain('SettingDefinitionMap');
        expect(uiSubpathSource).toContain("SettingDefinitionMap } from '@happier-dev/protocol'");
    });

    it('keeps the hosted-web client factory isolated to ui/client while sharing the domain API type', () => {
        const uiRuntime = pluginUi as Readonly<Record<string, unknown>>;
        expect(uiRuntime.createPluginUiHostApiClient).toBeUndefined();
        expect(hostedWebClient.createPluginUiHostApiClient).toBeTypeOf('function');
    });
});
