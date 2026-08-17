import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1 as canonicalComposerAttachmentDescriptionCodePointsV1,
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 as canonicalComposerAttachmentLabelCodePointsV1,
    pluginUiTargetedContributionOperationKey as canonicalPluginUiTargetedContributionOperationKey,
} from '@happier-dev/protocol/plugins/ui/client';

import {
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
} from './ui/hostApi.js';
import * as pluginUi from './ui';
import * as pluginUiPackageSurface from './ui/index.js';
import * as pluginUiAuthorSurface from './ui/index.public.js';
import * as pluginUiBuild from './ui/build/index.js';
import * as hostedWebClient from './ui/client';
import type { PluginUiHostApi as ClientPluginUiHostApi } from './ui.js';
import type { PluginUiChannel } from './ui.js';

import { defineHostedWebBridgeMessage } from './ui.js';

type AssertNever<T extends never> = T;
type _UiAggregateMustNotExportHostedWebFactory = AssertNever<
    Extract<keyof typeof pluginUi, 'createPluginUiHostApiClient' | 'CreatePluginUiHostApiClientOptions'>
>;
type _ClientMustExportDomainApi = ClientPluginUiHostApi;
const desktopUiChannel: PluginUiChannel = 'desktop';

describe('plugin UI public surface', () => {
    it('publishes selected Action execution options from the canonical UI public spec', () => {
        const publicSpecSource = readFileSync(
            new URL('./ui/index.public.ts', import.meta.url),
            'utf8',
        );

        expect(publicSpecSource).toContain(
            "export type { PluginUiActionExecutionOptions } from './hostApi.js';",
        );
    });

    it('projects the canonical targeted operation key through every public UI entry', () => {
        expect(pluginUiPackageSurface.pluginUiTargetedContributionOperationKey).toBe(
            canonicalPluginUiTargetedContributionOperationKey,
        );
        expect(pluginUiAuthorSurface).toHaveProperty(
            'pluginUiTargetedContributionOperationKey',
            canonicalPluginUiTargetedContributionOperationKey,
        );
    });

    it('projects Composer attachment presentation bounds through the UI author spec', () => {
        const hostApiSource = readFileSync(new URL('./ui/hostApi.ts', import.meta.url), 'utf8');
        const uiAuthorSource = readFileSync(
            new URL('./ui/index.public.ts', import.meta.url),
            'utf8',
        );

        expect(MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1).toBe(
            canonicalComposerAttachmentLabelCodePointsV1,
        );
        expect(MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1).toBe(
            canonicalComposerAttachmentDescriptionCodePointsV1,
        );
        expect(hostApiSource).toContain(
            'export const MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1: number =',
        );
        expect(hostApiSource).toContain(
            'export const MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1: number =',
        );
        expect(uiAuthorSource).toMatch(
            /export \{[\s\S]*?MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1[\s\S]*?MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1[\s\S]*?\} from '\.\/hostApi\.js';/u,
        );
    });

    it('re-exports the Protocol-owned semantic icon vocabulary', () => {
        expect(pluginUi.PLUGIN_UI_ICON_TOKENS_V1).toEqual([
            'action',
            'browser',
            'copy',
            'file',
            'globe',
            'info',
            'preview',
            'refresh',
            'settings',
            'terminal',
            'warning',
            'add',
            'back',
            'check',
            'close',
            'error',
            'external',
            'forward',
            'more',
            'search',
        ]);
    });

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
        expect(desktopUiChannel).toBe('desktop');
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

    it('keeps the settings contract on the canonical settings entrypoint', () => {
        const settingsSubpathSource = readFileSync(
            new URL('./settings/index.ts', import.meta.url),
            'utf8',
        );
        const uiSubpathSource = readFileSync(new URL('./ui/index.ts', import.meta.url), 'utf8');

        expect(readFileSync(new URL('./ui.ts', import.meta.url), 'utf8'))
            .not.toContain('PluginSettingsContribution');
        expect(uiSubpathSource).not.toContain('PluginSettingsContribution');
        expect(settingsSubpathSource).toContain(
            "export type { PluginSettingsContribution } from './projections.js';",
        );
    });

    it('projects UI input and output types through the SDK author contract', () => {
        const uiSource = readFileSync(new URL('./ui.ts', import.meta.url), 'utf8');
        const uiSubpathSource = readFileSync(new URL('./ui/index.ts', import.meta.url), 'utf8');

        expect(uiSource).toContain("from './ui/publicContract.js';");
        expect(uiSource).toContain('PluginUiViewDestinationBindingInputV2,');
        expect(uiSource).toContain('PluginUiViewV2,');
        expect(uiSource).toContain('PluginUiViewV2Input,');
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewDestinationBindingInputV2 } from '../ui.js';",
        );
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewV2 } from '../ui.js';",
        );
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewV2Input } from '../ui.js';",
        );
    });

    it('keeps the hosted-web client factory isolated to ui/client while sharing the domain API type', () => {
        const uiRuntime = pluginUi as Readonly<Record<string, unknown>>;
        expect(uiRuntime.createPluginUiHostApiClient).toBeUndefined();
        expect(hostedWebClient.createPluginUiHostApiClient).toBeTypeOf('function');
    });
});
