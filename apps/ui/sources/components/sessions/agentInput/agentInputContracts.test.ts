import { describe, expect, it, vi } from 'vitest';

import type {
    ComposerAttachmentDisplayV1,
    ComposerAttachmentPreviewV1,
    ComposerAttachmentViewV1,
} from '@happier-dev/protocol';

import * as contracts from './agentInputContracts';

type ProjectComposerAttachmentRowItem = (input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: Readonly<{
        identity: ComposerAttachmentViewV1['attachment'];
        display?: ComposerAttachmentDisplayV1;
        preview?: ComposerAttachmentPreviewV1;
    }> | null;
    media?: Readonly<{
        media: 'image' | 'video';
        renderedPreview: unknown;
        onPress?: () => void;
    }>;
    surface?: Readonly<{
        sizing: 'compact' | 'content';
        renderedContent: unknown;
    }>;
    onRemove?: () => void;
}>) => unknown;

const projectComposerAttachmentRowItem = (contracts as unknown as Readonly<{
    projectComposerAttachmentRowItem?: ProjectComposerAttachmentRowItem;
}>).projectComposerAttachmentRowItem;

const attachment = {
    v: 1,
    instanceId: 'instance-1',
    attachment: { pluginId: 'acme.issue', localId: 'issue' },
    key: 'incident-42',
    value: { incidentId: '42' },
    presentation: { label: 'Incident 42', typeLabel: 'Issue' },
    availability: { status: 'ready' },
} satisfies ComposerAttachmentViewV1;

const stagedImageMediaDisplay = {
    kind: 'media',
    media: 'image',
} satisfies ComposerAttachmentDisplayV1;

describe('composer attachment row projection', () => {
    it('projects matching catalog badge and rendered-surface roles from a contentless attachment view', () => {
        expect(projectComposerAttachmentRowItem).toBeTypeOf('function');

        const remove = vi.fn();
        const project = projectComposerAttachmentRowItem!;

        const badge = project({
            attachment,
            catalog: {
                identity: attachment.attachment,
                display: { kind: 'badge' },
            },
            onRemove: remove,
        });
        const surface = project({
            attachment,
            catalog: {
                identity: attachment.attachment,
                display: {
                    kind: 'surface',
                    renderer: { renderer: 'incident-display' },
                    sizing: 'content',
                },
            },
            surface: { sizing: 'content', renderedContent: 'host-projected-surface' },
            onRemove: remove,
        });

        expect(badge).toMatchObject({
            kind: 'badge',
            key: 'instance-1',
            label: 'Incident 42',
            onRemove: remove,
        });
        expect(surface).toMatchObject({
            kind: 'surface',
            key: 'instance-1',
            label: 'Incident 42',
            sizing: 'content',
            renderedContent: 'host-projected-surface',
            onRemove: remove,
        });
    });

    it('projects an approved staged image into the host media row without carrying a URI', () => {
        expect(projectComposerAttachmentRowItem).toBeTypeOf('function');

        const onPress = vi.fn();
        const rowItem = projectComposerAttachmentRowItem!({
            attachment,
            catalog: {
                identity: attachment.attachment,
                display: stagedImageMediaDisplay,
                preview: { kind: 'host', presentation: 'image' },
            },
            media: {
                media: 'image',
                renderedPreview: 'host-staged-image-preview',
                onPress,
            },
        });

        expect(rowItem).toMatchObject({
            kind: 'media',
            key: 'instance-1',
            label: 'Incident 42',
            media: 'image',
            renderedPreview: 'host-staged-image-preview',
            onPress,
        });
        expect(rowItem).not.toHaveProperty('uri');
        expect(rowItem).not.toHaveProperty('path');
    });

    it('keeps the host fallback badge when a catalog entry does not match the attachment definition', () => {
        expect(projectComposerAttachmentRowItem).toBeTypeOf('function');

        const rowItem = projectComposerAttachmentRowItem!({
            attachment,
            catalog: {
                identity: { pluginId: 'acme.other', localId: 'issue' },
                display: stagedImageMediaDisplay,
            },
            media: {
                media: 'image',
                renderedPreview: 'host-staged-image-preview',
            },
        });

        expect(rowItem).toMatchObject({
            kind: 'badge',
            key: 'instance-1',
            label: 'Incident 42',
        });
    });
});
