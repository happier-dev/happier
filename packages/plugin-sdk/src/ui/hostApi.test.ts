import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    ComposerDecorationResultV1 as ProtocolComposerDecorationResultV1,
    ComposerDecorationSetV1 as ProtocolComposerDecorationSetV1,
    ComposerFocusResultV1 as ProtocolComposerFocusResultV1,
    ComposerInputLockRequestV1 as ProtocolComposerInputLockRequestV1,
    ComposerOperationV1 as ProtocolComposerOperationV1,
    ComposerReadResultV1 as ProtocolComposerReadResultV1,
    ComposerRefV1 as ProtocolComposerRefV1,
    ComposerSnapshotV1 as ProtocolComposerSnapshotV1,
    ComposerSurfaceInputV1 as ProtocolComposerSurfaceInputV1,
    ComposerTransactionResultV1 as ProtocolComposerTransactionResultV1,
    ComposerTransactionV1 as ProtocolComposerTransactionV1,
    CurrentUiCommandDeclarationV1 as ProtocolCurrentUiCommandDeclarationV1,
    CurrentUiCommandDescriptorV1 as ProtocolCurrentUiCommandDescriptorV1,
    CurrentUiContextEntityV1 as ProtocolCurrentUiContextEntityV1,
    CurrentUiContextSnapshotV1 as ProtocolCurrentUiContextSnapshotV1,
    PluginUiContextEnrichmentV1 as ProtocolPluginUiContextEnrichmentV1,
    PluginUiSelectActionInputRequestV1,
    PluginUiSelectActionInputResultV1,
    PluginTargetedContributionSelectionV1 as ProtocolPluginTargetedContributionSelectionV1,
    PluginUiTargetedContributionsV1 as ProtocolPluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    ComposerMentionRefV1,
    ComposerDecorationResultV1,
    ComposerDecorationSetV1,
    ComposerFocusResultV1,
    ComposerInputLockRequestV1,
    ComposerAttachmentUpdateV1,
    ComposerAttachmentViewV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerOperationV1,
    ComposerReadResultV1,
    ComposerStagedMediaContentV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerSurfaceInputV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
    CurrentUiCommandDeclarationV1,
    CurrentUiCommandDescriptorV1,
    CurrentUiContextEntityV1,
    CurrentUiContextSnapshotV1,
    PluginUiHostApi,
    PluginUiContributionIdentityV1,
    PluginUiContextEnrichmentV1,
    PluginUiSemanticCommandV1,
    PluginUiTargetedContributionsV1,
    SelectActionInputRequest,
    SelectActionInputResult,
} from './hostApi.js';
import {
    ComposerSnapshotV1Schema,
    CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
    CURRENT_UI_CONTEXT_MAX_COMMANDS_V1,
    CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1,
} from './hostApi.js';
import type {
    PluginUiSemanticExecuteActionCommandV1,
    PluginUiSemanticOpenSurfaceCommandV1,
} from './publicContract.js';
import type { PluginTargetedContributionSelectionV1 } from '../contributions/index.js';
import type { PluginCancellationOptions } from '../lifecycle.js';

describe('PluginUiHostApi initial public contract', () => {
    it('projects one semantic API and mount owner through SDK-local author declarations', () => {
        const hostApiSource = readFileSync(new URL('./hostApi.ts', import.meta.url), 'utf8');
        const publicContractSource = readFileSync(new URL('./publicContract.ts', import.meta.url), 'utf8');
        const uiIndexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

        expect(hostApiSource).toContain("from './publicContract.js';");
        expect(hostApiSource).toContain('PluginUiHostMethodV1,');
        expect(hostApiSource).toContain('PluginUiMountContextV1,');
        expect(hostApiSource).not.toContain('ProtocolPluginUiHostMethodV1');
        expect(publicContractSource).toContain('mount: PluginUiMountContextV1;');
        expect(hostApiSource).toContain('PluginUiHostApiSurfaceContextV1,');
        expect(hostApiSource).not.toContain("from '@happier-dev/protocol/plugins/ui/client';\n\nexport type SurfaceContext");
        expect(hostApiSource).not.toMatch(/PluginUiHostReleasedMethod/u);
        expect(hostApiSource).not.toContain('readonly placement:');
        expect(hostApiSource).not.toContain('readonly view:');
        expect(uiIndexSource).toContain(
            "export type { PluginUiHostMethodV1 } from './hostApi.js';",
        );
        expect(uiIndexSource).toContain(
            "export type { PluginUiMountContextV1 } from './hostApi.js';",
        );
    });

    it('keeps targeted facts exact and accepts canonical selection settlements through the author projection', () => {
        expectTypeOf<PluginUiTargetedContributionsV1>()
            .toMatchTypeOf<ProtocolPluginUiTargetedContributionsV1>();
        expectTypeOf<ProtocolPluginUiTargetedContributionsV1>()
            .toMatchTypeOf<PluginUiTargetedContributionsV1>();
        expectTypeOf<PluginTargetedContributionSelectionV1>()
            .toMatchTypeOf<ProtocolPluginTargetedContributionSelectionV1>();
        expectTypeOf<ProtocolPluginTargetedContributionSelectionV1>()
            .toMatchTypeOf<PluginTargetedContributionSelectionV1>();
        expectTypeOf<PluginUiSelectActionInputRequestV1>()
            .toMatchTypeOf<SelectActionInputRequest>();
        expectTypeOf<SelectActionInputRequest>()
            .toMatchTypeOf<PluginUiSelectActionInputRequestV1>();
        expectTypeOf<PluginUiSelectActionInputResultV1>()
            .toMatchTypeOf<SelectActionInputResult>();
        expectTypeOf<Extract<SelectActionInputResult, { kind: 'executionRunLaunch' }>>()
            .toEqualTypeOf<Extract<PluginUiSelectActionInputResultV1, { kind: 'executionRunLaunch' }>>();
    });

    it('publishes only closed current-UI enrichment through the mount-bound host API', () => {
        expectTypeOf<CurrentUiContextEntityV1>()
            .toEqualTypeOf<ProtocolCurrentUiContextEntityV1>();
        expectTypeOf<CurrentUiCommandDeclarationV1>()
            .toEqualTypeOf<ProtocolCurrentUiCommandDeclarationV1>();
        expectTypeOf<PluginUiSemanticCommandV1>()
            .toEqualTypeOf<ProtocolCurrentUiCommandDeclarationV1['command']>();
        expectTypeOf<PluginUiSemanticExecuteActionCommandV1>()
            .toEqualTypeOf<Extract<ProtocolCurrentUiCommandDeclarationV1['command'], { kind: 'executeAction' }>>();
        expectTypeOf<PluginUiSemanticOpenSurfaceCommandV1>()
            .toEqualTypeOf<Extract<ProtocolCurrentUiCommandDeclarationV1['command'], { kind: 'openSurface' }>>();
        expectTypeOf<CurrentUiCommandDescriptorV1>()
            .toEqualTypeOf<ProtocolCurrentUiCommandDescriptorV1>();
        expectTypeOf<CurrentUiContextSnapshotV1>()
            .toEqualTypeOf<ProtocolCurrentUiContextSnapshotV1>();
        expectTypeOf<PluginUiContextEnrichmentV1>()
            .toEqualTypeOf<ProtocolPluginUiContextEnrichmentV1>();
        expectTypeOf<PluginUiHostApi['publishCurrentUiContext']>().parameters.toEqualTypeOf<[
            enrichment: PluginUiContextEnrichmentV1 | null,
        ]>();
        expectTypeOf<PluginUiHostApi['publishCurrentUiContext']>().returns.toEqualTypeOf<void>();
    });

    it('lets an SDK-only UI author consume the canonical current-context bounds', () => {
        expect(CURRENT_UI_CONTEXT_MAX_COMMANDS_V1).toBe(32);
        expect(CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1).toBe(8_192);
        expect(CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1).toEqual({ incomplete: true });
    });

    it('projects the optional Composer reference companion through the canonical snapshot schema', () => {
        const composerReference = { pluginId: 'acme.issues', localId: 'issues' };
        const snapshot = ComposerSnapshotV1Schema.parse({
            revision: 1,
            ref: { kind: 'session', sessionId: 'session-1' },
            text: '@incident-42',
            references: [{
                kind: 'happier.composerReference',
                ref: 'composerReference:incident-42',
                token: '@incident-42',
                start: 0,
                end: 12,
                composerReference,
            }],
            attachments: [],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
        });

        expect(snapshot.references[0]?.composerReference).toEqual(composerReference);
        expectTypeOf<NonNullable<ComposerMentionRefV1['composerReference']>>()
            .toEqualTypeOf<Readonly<PluginUiContributionIdentityV1>>();
    });

    it('aliases the complete browser-safe Composer contract to Protocol ownership', () => {
        expectTypeOf<ComposerRefV1>().toEqualTypeOf<ProtocolComposerRefV1>();
        expectTypeOf<ComposerSurfaceInputV1>().toEqualTypeOf<ProtocolComposerSurfaceInputV1>();
        expectTypeOf<ComposerSnapshotV1>().toEqualTypeOf<ProtocolComposerSnapshotV1>();
        expectTypeOf<ComposerOperationV1>().toEqualTypeOf<ProtocolComposerOperationV1>();
        expectTypeOf<ComposerTransactionV1>().toEqualTypeOf<ProtocolComposerTransactionV1>();
        expectTypeOf<ComposerTransactionResultV1>()
            .toEqualTypeOf<ProtocolComposerTransactionResultV1>();
        expectTypeOf<ComposerReadResultV1>().toEqualTypeOf<ProtocolComposerReadResultV1>();
        expectTypeOf<ComposerFocusResultV1>().toEqualTypeOf<ProtocolComposerFocusResultV1>();
        expectTypeOf<ComposerDecorationSetV1>().toEqualTypeOf<ProtocolComposerDecorationSetV1>();
        expectTypeOf<ComposerDecorationResultV1>()
            .toEqualTypeOf<ProtocolComposerDecorationResultV1>();
        expectTypeOf<ComposerInputLockRequestV1>()
            .toEqualTypeOf<ProtocolComposerInputLockRequestV1>();
    });

    it('exposes only the opaque media-content operations on the public Composer host API', () => {
        expectTypeOf<PluginUiHostApi['pickComposerMedia']>().parameters.toEqualTypeOf<[
            ref: ComposerRefV1,
            request: ComposerContentPickMediaRequestV1,
            options?: PluginCancellationOptions,
        ]>();
        expectTypeOf<PluginUiHostApi['pickComposerMedia']>().returns.resolves
            .toEqualTypeOf<ComposerContentHandleV1>();
        expectTypeOf<PluginUiHostApi['inspectComposerContent']>().parameters.toEqualTypeOf<[
            handle: ComposerContentHandleV1,
            request: ComposerContentInspectRequestV1,
            options?: PluginCancellationOptions,
        ]>();
        expectTypeOf<PluginUiHostApi['inspectComposerContent']>().returns.resolves
            .toEqualTypeOf<ComposerContentInspectResultV1>();
        expectTypeOf<PluginUiHostApi['releaseComposerContent']>().parameters.toEqualTypeOf<[
            handle: ComposerContentHandleV1,
            options?: PluginCancellationOptions,
        ]>();
        expectTypeOf<PluginUiHostApi['releaseComposerContent']>().returns.resolves.toEqualTypeOf<void>();
        expectTypeOf<ComposerContentHandleV1['executionTarget']>()
            .toEqualTypeOf<Readonly<{ serverId: string; machineId: string }>>();
        expectTypeOf<ComposerContentHandleV1>().not.toHaveProperty('path');
        expectTypeOf<ComposerContentHandleV1>().not.toHaveProperty('uri');
        expectTypeOf<ComposerContentHandleV1>().not.toHaveProperty('bytes');
        expectTypeOf<ComposerContentHandleV1>().not.toHaveProperty('base64');
        expectTypeOf<ComposerContentHandleV1>().not.toHaveProperty('transferSessionId');
    });

    it('keeps staged media as an attachment-level draft field rather than attachment-defined value or admission state', () => {
        type AttachmentAdd = Extract<ComposerOperationV1, { kind: 'attachment.add' }>;

        expectTypeOf<AttachmentAdd['content']>()
            .toEqualTypeOf<ComposerStagedMediaContentV1 | undefined>();
        expectTypeOf<ComposerAttachmentViewV1['content']>()
            .toEqualTypeOf<ComposerStagedMediaContentV1 | undefined>();
        expectTypeOf<AttachmentAdd['value']>().not.toHaveProperty('content');
        expectTypeOf<ComposerAttachmentUpdateV1>().not.toHaveProperty('content');
    });

    it('keeps emitted Host API declarations out of the source owner', async () => {
        await expect(readFile(new URL('./hostApi.d.ts', import.meta.url), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
