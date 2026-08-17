import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '@happier-dev/protocol';
import * as protocolUiClient from '@happier-dev/protocol/plugins/ui/client';

import { ComposerReferenceCandidateIdV1Schema as sourceCandidateIdSchema } from './composerReferenceProviders.js';
import { selectCurrentTargetedContribution as sourceSelectCurrentTargetedContribution } from './services/targetedContributions.js';
import * as rootSdk from './index.js';
import * as browserRootSdk from './index.browser.js';
import * as manifestSdk from './manifest.js';
import type {
    ComposerAttachmentAuthorDeclaration as SourceComposerAttachmentAuthorDeclaration,
    ComposerAttachmentAuthorDisplay as SourceComposerAttachmentAuthorDisplay,
    ComposerAttachmentAuthorPreview as SourceComposerAttachmentAuthorPreview,
    ComposerControlAuthorInteraction as SourceComposerControlAuthorInteraction,
    ComposerRendererChainAuthorInput as SourceComposerRendererChainAuthorInput,
} from './definePlugin.js';
import type {
    ComposerReferenceRuntime as SourceComposerReferenceRuntime,
    ComposerReferencesRegistrationApi as SourceComposerReferencesRegistrationApi,
} from './activation.js';
import * as sourceUiHostApi from './ui/hostApi.js';
import type {
    ComposerAttachmentAuthorDeclaration,
    ComposerAttachmentAuthorDisplay,
    ComposerAttachmentAuthorPreview,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerReferenceCandidatePageV1,
    ComposerReferenceRuntime,
    ComposerReferencesRegistrationApi,
    ComposerReferenceResolutionV1,
    ComposerControlAuthorInteraction,
    ComposerRendererChainAuthorInput,
} from './index.js';

describe('root composer runtime projection', () => {
    it('publishes the complete content-aware Composer author/runtime, host API, and testkit closure through its public specs', () => {
        const rootSource = readFileSync(new URL('./index.public.ts', import.meta.url), 'utf8');
        const uiSource = readFileSync(new URL('./ui/index.public.ts', import.meta.url), 'utf8');
        const testingSource = readFileSync(new URL('./testing/index.public.ts', import.meta.url), 'utf8');

        for (const symbol of [
            'ComposerAttachmentAuthorDeclaration',
            'ComposerAttachmentAuthorDisplay',
            'ComposerAttachmentAuthorPreview',
            'ComposerControlAuthorInteraction',
            'ComposerRendererChainAuthorInput',
            'ComposerAttachmentPrepareRequestV1',
            'ComposerAttachmentPrepareOutcomeV1',
            'ComposerAttachmentPrepareResultV1',
            'ComposerAttachmentResolveRequestV1',
            'ComposerAttachmentResolveResultV1',
            'ComposerAttachmentMessageAcceptedV1',
            'ComposerContentHandleV1',
            'ComposerContentInspectRequestV1',
            'ComposerContentInspectResultV1',
            'ComposerContentPickMediaRequestV1',
            'ComposerStagedMediaContentV1',
            'ComposerSessionMediaContentV1',
            'ComposerMediaContentCapabilityV1',
            'COMPOSER_MEDIA_CONTENT_CAPABILITY_V1',
            'ComposerContentService',
            'ComposerContentStageMediaRequestV1',
        ]) {
            expect(rootSource).toContain(symbol);
        }
        expect(rootSource).toMatch(
            /export type \{[\s\S]*?ComposerAttachmentMessageAcceptedV1[\s\S]*?ComposerAttachmentResolveResultV1[\s\S]*?\} from '\.\/activation\.js';/u,
        );

        for (const symbol of [
            'ComposerRefV1',
            'ComposerSnapshotV1',
            'ComposerTransactionV1',
            'ComposerOperationV1',
            'ComposerTransactionResultV1',
            'ComposerReadResultV1',
            'ComposerFocusResultV1',
            'ComposerDecorationSetV1',
            'ComposerDecorationResultV1',
            'ComposerInputLockRequestV1',
            'ComposerRefV1Schema',
            'ComposerContentHandleV1Schema',
            'ComposerContentInspectRequestV1Schema',
            'ComposerContentPickMediaRequestV1Schema',
            'ComposerSurfaceInputV1',
            'ComposerSurfaceInputV1Schema',
            'ComposerSnapshotV1Schema',
            'ComposerTransactionV1Schema',
            'ComposerOperationV1Schema',
            'ComposerTransactionResultV1Schema',
            'ComposerReadResultV1Schema',
            'ComposerFocusResultV1Schema',
            'ComposerDecorationSetV1Schema',
            'ComposerDecorationResultV1Schema',
            'ComposerInputLockRequestV1Schema',
        ]) {
            expect(uiSource).toContain(symbol);
        }
        for (const rootOwnedSymbol of [
            'ComposerContentHandleV1',
            'ComposerContentInspectRequestV1',
            'ComposerContentInspectResultV1',
            'ComposerContentMediaKindV1',
            'ComposerContentMimeTypeV1',
            'ComposerContentPickMediaRequestV1',
            'ComposerMediaContentCapabilityV1',
            'ComposerSessionMediaContentV1',
            'ComposerStagedMediaContentV1',
        ]) {
            expect(uiSource).not.toMatch(
                new RegExp(`export type \\{[^}]*\\b${rootOwnedSymbol}\\b[^}]*\\} from '\\.\\/hostApi\\.js';`, 'u'),
            );
        }
        expect(uiSource).not.toMatch(
            /export \{[^}]*\bCOMPOSER_MEDIA_CONTENT_CAPABILITY_V1\b[^}]*\} from '\.\/hostApi\.js';/u,
        );

        for (const symbol of [
            'PluginUiTestkitActiveComposerInput',
            'PluginUiTestkitReadComposerInput',
            'PluginUiTestkitReplacePageLocationInput',
            'PluginUiTestkitApplyComposerInput',
            'PluginUiTestkitSetComposerDecorationsInput',
            'PluginUiTestkitAcquireComposerInputLockInput',
            'PluginUiTestkitPickComposerMediaInput',
            'PluginUiTestkitInspectComposerContentInput',
            'PluginUiTestkitReleaseComposerContentInput',
        ]) {
            expect(testingSource).toContain(symbol);
        }
    });

    it('publishes the target-local current contribution selector through the root public spec', () => {
        const rootSource = readFileSync(new URL('./index.public.ts', import.meta.url), 'utf8');
        const browserRootSource = readFileSync(new URL('./index.browser.ts', import.meta.url), 'utf8');

        for (const symbol of [
            'selectCurrentTargetedContribution',
            'TargetedContributionAdmittedEntry',
            'TargetedContributionSelectionResult',
            'TargetedContributionSelectionUnavailableReason',
        ]) {
            expect(rootSource).toContain(symbol);
        }

        expect(browserRootSource).toContain('selectCurrentTargetedContribution');
        expect(browserRootSdk.selectCurrentTargetedContribution)
            .toBe(sourceSelectCurrentTargetedContribution);
    });

    it('publishes the canonical UI surface shorthand through the root and build public specs', () => {
        const rootSource = readFileSync(new URL('./index.public.ts', import.meta.url), 'utf8');
        const uiSource = readFileSync(new URL('./ui/index.public.ts', import.meta.url), 'utf8');
        const buildSource = readFileSync(new URL('./ui/build/index.public.ts', import.meta.url), 'utf8');

        expect(rootSource).toContain('defineUiSurface');
        expect(rootSource).toContain('UiSurface');
        expect(rootSource).toContain("from './ui/surface.js'");
        for (const symbol of ['UiRenderer', 'UiHost', 'UiResource']) {
            expect(uiSource).toContain(symbol);
        }
        expect(uiSource).toContain("from '../ui.js'");
        expect(buildSource).toContain('buildUiSurfaceTargets');
        expect(buildSource).toContain("from '../surface.js'");
        expect(rootSource).not.toContain('definePluginUiSurface');
        expect(uiSource).not.toContain('definePluginUiSurface');
        expect(buildSource).not.toContain('definePluginUiSurface');
    });

    it('projects the candidate-id schema at the root while retaining contribution identity on /manifest', () => {
        expect(sourceCandidateIdSchema)
            .toBe(protocol.ComposerReferenceCandidateIdV1Schema);
        expect(rootSdk.ComposerReferenceCandidateIdV1Schema)
            .toBe(protocol.ComposerReferenceCandidateIdV1Schema);
        expect(browserRootSdk.ComposerReferenceCandidateIdV1Schema)
            .toBe(protocol.ComposerReferenceCandidateIdV1Schema);
        expect(rootSdk.normalizePluginDaemonDatabaseRuntimeProjection)
            .toBeTypeOf('function');
        expect(rootSdk).not.toHaveProperty('PluginContributionIdentityV1Schema');
        expect(manifestSdk.PluginContributionIdentityV1Schema)
            .toBe(protocol.PluginContributionIdentityV1Schema);
        expectTypeOf<ComposerReferenceRuntime>()
            .toEqualTypeOf<SourceComposerReferenceRuntime>();
        expectTypeOf<ComposerReferencesRegistrationApi>()
            .toEqualTypeOf<SourceComposerReferencesRegistrationApi>();
        expectTypeOf<ComposerReferenceCandidatePageV1>()
            .toEqualTypeOf<protocol.ComposerReferenceCandidatePageV1>();
        expectTypeOf<ComposerReferenceResolutionV1>()
            .toEqualTypeOf<protocol.ComposerReferenceResolutionV1>();
        expectTypeOf<Awaited<ReturnType<SourceComposerReferenceRuntime['search']>>>()
            .toEqualTypeOf<ComposerReferenceCandidatePageV1>();
        expectTypeOf<Awaited<ReturnType<SourceComposerReferenceRuntime['resolve']>>>()
            .toEqualTypeOf<ComposerReferenceResolutionV1>();
        expectTypeOf<ComposerAttachmentAuthorDeclaration>()
            .toEqualTypeOf<SourceComposerAttachmentAuthorDeclaration>();
        expectTypeOf<ComposerAttachmentAuthorDisplay>()
            .toEqualTypeOf<SourceComposerAttachmentAuthorDisplay>();
        expectTypeOf<ComposerAttachmentAuthorPreview>()
            .toEqualTypeOf<SourceComposerAttachmentAuthorPreview>();
        expectTypeOf<ComposerControlAuthorInteraction>()
            .toEqualTypeOf<SourceComposerControlAuthorInteraction>();
        expectTypeOf<ComposerRendererChainAuthorInput>()
            .toEqualTypeOf<SourceComposerRendererChainAuthorInput>();
        expectTypeOf<ComposerContentHandleV1>()
            .toEqualTypeOf<sourceUiHostApi.ComposerContentHandleV1>();
        expectTypeOf<ComposerContentInspectRequestV1>()
            .toEqualTypeOf<sourceUiHostApi.ComposerContentInspectRequestV1>();
        expectTypeOf<ComposerContentInspectResultV1>()
            .toEqualTypeOf<sourceUiHostApi.ComposerContentInspectResultV1>();
        expectTypeOf<ComposerContentPickMediaRequestV1>()
            .toEqualTypeOf<sourceUiHostApi.ComposerContentPickMediaRequestV1>();
        expect(rootSdk.COMPOSER_MEDIA_CONTENT_CAPABILITY_V1)
            .toBe(sourceUiHostApi.COMPOSER_MEDIA_CONTENT_CAPABILITY_V1);
        expect(sourceUiHostApi.ComposerContentHandleV1Schema)
            .toBe(protocolUiClient.ComposerContentHandleV1Schema);
        expect(sourceUiHostApi.ComposerContentInspectRequestV1Schema)
            .toBe(protocolUiClient.ComposerContentInspectRequestV1Schema);
        expect(sourceUiHostApi.ComposerContentPickMediaRequestV1Schema)
            .toBe(protocolUiClient.ComposerContentPickMediaRequestV1Schema);
        expect(sourceUiHostApi.ComposerRefV1Schema)
            .toBe(protocolUiClient.ComposerRefV1Schema);
        expect(sourceUiHostApi.ComposerSurfaceInputV1Schema)
            .toBe(protocolUiClient.ComposerSurfaceInputV1Schema);
        expect(sourceUiHostApi.ComposerSnapshotV1Schema)
            .toBe(protocolUiClient.ComposerSnapshotV1Schema);
        expect(sourceUiHostApi.ComposerTransactionV1Schema)
            .toBe(protocolUiClient.ComposerTransactionV1Schema);
        expect(sourceUiHostApi.ComposerOperationV1Schema)
            .toBe(protocolUiClient.ComposerOperationV1Schema);
        expect(sourceUiHostApi.ComposerTransactionResultV1Schema)
            .toBe(protocolUiClient.ComposerTransactionResultV1Schema);
        expect(sourceUiHostApi.ComposerReadResultV1Schema)
            .toBe(protocolUiClient.ComposerReadResultV1Schema);
        expect(sourceUiHostApi.ComposerFocusResultV1Schema)
            .toBe(protocolUiClient.ComposerFocusResultV1Schema);
        expect(sourceUiHostApi.ComposerDecorationSetV1Schema)
            .toBe(protocolUiClient.ComposerDecorationSetV1Schema);
        expect(sourceUiHostApi.ComposerDecorationResultV1Schema)
            .toBe(protocolUiClient.ComposerDecorationResultV1Schema);
        expect(sourceUiHostApi.ComposerInputLockRequestV1Schema)
            .toBe(protocolUiClient.ComposerInputLockRequestV1Schema);
    });
});
