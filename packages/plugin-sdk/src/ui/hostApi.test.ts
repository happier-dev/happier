import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    PluginUiSelectActionInputRequestV1,
    PluginUiSelectActionInputResultV1,
    PluginTargetedContributionSelectionV1 as ProtocolPluginTargetedContributionSelectionV1,
    PluginUiTargetedContributionsV1 as ProtocolPluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    ComposerMentionRefV1,
    ComposerAttachmentUpdateV1,
    ComposerAttachmentViewV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerOperationV1,
    ComposerStagedMediaContentV1,
    ComposerRefV1,
    PluginUiHostApi,
    PluginUiContributionIdentityV1,
    PluginUiTargetedContributionsV1,
    SelectActionInputRequest,
    SelectActionInputResult,
} from './hostApi.js';
import { ComposerSnapshotV1Schema } from './hostApi.js';
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
        expectTypeOf<PluginUiSelectActionInputResultV1>()
            .toMatchTypeOf<SelectActionInputResult>();
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
