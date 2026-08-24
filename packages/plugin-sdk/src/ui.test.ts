import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1 as canonicalCurrentUiContextBoundedIncompletenessV1,
    CURRENT_UI_CONTEXT_MAX_COMMANDS_V1 as canonicalCurrentUiContextMaxCommandsV1,
    CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1 as canonicalCurrentUiContextMaxUtf8BytesV1,
    ComposerRefV1Schema as canonicalComposerRefV1Schema,
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
import * as pluginProtocolPackageSurface from './protocol/index.js';
import * as pluginProtocolAuthorSurface from './protocol/index.public.js';
import * as pluginContributionsPackageSurface from './contributions/index.js';
import * as pluginContributionsAuthorSurface from './contributions/index.public.js';
import * as pluginSessionsPackageSurface from './sessions/index.js';
import * as pluginSessionsAuthorSurface from './sessions/index.public.js';
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

    it('keeps the exact Composer ref parser on the UI Host API surface, not /sessions', () => {
        expect(pluginUiPackageSurface.ComposerRefV1Schema).toBe(canonicalComposerRefV1Schema);
        expect(pluginUiAuthorSurface.ComposerRefV1Schema).toBe(canonicalComposerRefV1Schema);
        expect(pluginContributionsPackageSurface).not.toHaveProperty('ComposerRefV1Schema');
        expect(pluginContributionsAuthorSurface).not.toHaveProperty('ComposerRefV1Schema');
        expect(pluginSessionsPackageSurface).not.toHaveProperty('ComposerRefV1Schema');
        expect(pluginSessionsAuthorSurface).not.toHaveProperty('ComposerRefV1Schema');
        for (const spec of [
            './contributions/index.ts',
            './contributions/index.public.ts',
            './sessions/index.ts',
            './sessions/index.public.ts',
        ]) {
            expect(readFileSync(new URL(spec, import.meta.url), 'utf8')).not.toContain('ComposerRefV1');
        }
    });

    it('publishes the composable Composer ref projection on /protocol, not on the Host API', () => {
        // `/ui` is declaration-only by contract (`PluginUiSchema` exposes only
        // parse/safeParse), so a feature protocol cannot embed the Host API
        // projection in its own launch input. `/protocol` publishes the same
        // canonical Protocol value under its own name, as a composable.
        expect(pluginProtocolPackageSurface.ProtocolComposerRefV1Schema)
            .toBe(canonicalComposerRefV1Schema);
        expect(pluginProtocolAuthorSurface.ProtocolComposerRefV1Schema)
            .toBe(canonicalComposerRefV1Schema);

        const launchInput = pluginProtocolPackageSurface.defineProtocolObject({
            originComposer: pluginProtocolPackageSurface.ProtocolComposerRefV1Schema.optional(),
        }, { policy: 'closed' });
        expect(launchInput.parse({ originComposer: { kind: 'session', sessionId: 'session-1' } }))
            .toEqual({ originComposer: { kind: 'session', sessionId: 'session-1' } });
        expect(launchInput.parse({})).toEqual({});
        // The arms stay closed through the projection.
        expect(launchInput.safeParse({
            originComposer: { kind: 'session', sessionId: 'session-1', unknownArmField: true },
        }).success).toBe(false);
        expect(launchInput.jsonSchema.properties?.originComposer).toBeDefined();

        // One author-visible owner per name: neither subpath borrows the other's.
        expect(pluginProtocolPackageSurface).not.toHaveProperty('ComposerRefV1Schema');
        expect(pluginProtocolAuthorSurface).not.toHaveProperty('ComposerRefV1Schema');
        expect(pluginUiPackageSurface).not.toHaveProperty('ProtocolComposerRefV1Schema');
        expect(pluginUiAuthorSurface).not.toHaveProperty('ProtocolComposerRefV1Schema');
    });

    it('keeps Composer reference source publication on /ui', () => {
        const uiAuthorSource = readFileSync(new URL('./ui/index.public.ts', import.meta.url), 'utf8');
        const contributionsAuthorSource = readFileSync(
            new URL('./contributions/index.public.ts', import.meta.url),
            'utf8',
        );

        expect(uiAuthorSource).toMatch(
            /export \{[\s\S]*?ComposerRefV1Schema[\s\S]*?\} from '\.\/hostApi\.js';/u,
        );
        expect(uiAuthorSource).toContain("export type { ComposerRefV1 } from './hostApi.js';");
        expect(contributionsAuthorSource).not.toContain('ComposerRefV1');
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

    it('projects current-context bounds and incompleteness through the UI author spec', () => {
        const uiAuthorSource = readFileSync(new URL('./ui/index.public.ts', import.meta.url), 'utf8');

        expect(pluginUiPackageSurface.CURRENT_UI_CONTEXT_MAX_COMMANDS_V1)
            .toBe(canonicalCurrentUiContextMaxCommandsV1);
        expect(pluginUiPackageSurface.CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1)
            .toBe(canonicalCurrentUiContextMaxUtf8BytesV1);
        expect(pluginUiPackageSurface.CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1)
            .toBe(canonicalCurrentUiContextBoundedIncompletenessV1);
        expect(pluginUiAuthorSurface.CURRENT_UI_CONTEXT_MAX_COMMANDS_V1)
            .toBe(canonicalCurrentUiContextMaxCommandsV1);
        expect(pluginUiAuthorSurface.CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1)
            .toBe(canonicalCurrentUiContextMaxUtf8BytesV1);
        expect(pluginUiAuthorSurface.CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1)
            .toBe(canonicalCurrentUiContextBoundedIncompletenessV1);
        expect(uiAuthorSource).toMatch(
            /export \{[\s\S]*?CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1[\s\S]*?CURRENT_UI_CONTEXT_MAX_COMMANDS_V1[\s\S]*?CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1[\s\S]*?\} from '\.\/hostApi\.js';/u,
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
        const uiAuthorSource = readFileSync(new URL('./ui/index.public.ts', import.meta.url), 'utf8');

        expect(uiSource).toContain("from './ui/publicContract.js';");
        expect(uiSource).toContain('PluginUiViewDestinationBindingInputV2,');
        expect(uiSource).toContain('PluginUiViewV2,');
        expect(uiSource).toContain('PluginUiViewV2Input,');
        expect(uiSource).toContain('PluginUiSessionPlacementCandidateV1,');
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewDestinationBindingInputV2 } from '../ui.js';",
        );
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewV2 } from '../ui.js';",
        );
        expect(uiSubpathSource).toContain(
            "export type { PluginUiViewV2Input } from '../ui.js';",
        );
        expect(uiSubpathSource).toContain(
            "export type { PluginUiSessionPlacementCandidateV1 } from '../ui.js';",
        );
        expect(uiAuthorSource).toContain(
            "export type { PluginUiSessionPlacementCandidateV1 } from '../ui.js';",
        );
    });

    it('keeps the hosted-web client factory isolated to ui/client while sharing the domain API type', () => {
        const uiRuntime = pluginUi as Readonly<Record<string, unknown>>;
        expect(uiRuntime.createPluginUiHostApiClient).toBeUndefined();
        expect(hostedWebClient.createPluginUiHostApiClient).toBeTypeOf('function');
    });
});
