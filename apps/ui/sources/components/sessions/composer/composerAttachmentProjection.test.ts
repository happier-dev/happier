import type {
    ComposerAttachmentViewV1,
    PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    projectComposerAttachmentRowItems,
    resolveComposerAttachmentCatalogRowDescriptor,
} from './composerAttachmentProjection';

describe('composer attachment row projection', () => {
    it('keeps an injectable plugin attachment visible and host-removable without a control or picker', () => {
        const onRemove = vi.fn();
        const attachments: readonly ComposerAttachmentViewV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue', icon: 'warning' },
            availability: { status: 'ready' },
        }];

        const items = projectComposerAttachmentRowItems({ attachments, onRemove });

        expect(items).toEqual([expect.objectContaining({
            kind: 'badge',
            key: 'composer-attachment:issue-42',
            testID: 'composer-attachment:issue-42',
            label: 'Issue #42',
            accessibilityLabel: 'Issue: Issue #42',
            availability: 'ready',
        })]);
        const item = items[0];
        if (!item || item.kind !== 'badge' || !item.icon) {
            throw new Error('expected the host badge to retain its resolved plugin icon');
        }
        expect(item.icon('row-tint')).toEqual(expect.objectContaining({
            props: expect.objectContaining({ name: 'warning', color: 'row-tint' }),
        }));
        items[0]?.onRemove?.();
        expect(onRemove).toHaveBeenCalledWith('issue-42');
    });

    it('keeps an unavailable persisted attachment visible and removable as a fallback badge', () => {
        const items = projectComposerAttachmentRowItems({
            attachments: [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'unavailable', reason: 'Plugin is unavailable' },
            }],
            onRemove: vi.fn(),
        });

        expect(items[0]).toMatchObject({
            kind: 'badge',
            availability: 'unavailable',
            label: 'Issue #42',
            testID: 'composer-attachment:issue-42',
        });
        expect(items[0]?.onRemove).toEqual(expect.any(Function));
    });

    // Removal is a Composer mutation. A read-only Session, a `view` share, and
    // an `editAndSubmit` lock all refuse the transaction, so offering the
    // control there produced a visibly enabled affordance that silently
    // no-opped. Preview and picker interaction stay available.
    it('omits removal when the owning Composer scope cannot be mutated', () => {
        const attachments: readonly ComposerAttachmentViewV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        }];
        const onPress = vi.fn();

        const readOnly = projectComposerAttachmentRowItems({
            attachments,
            resolveInteraction: () => ({ onPress }),
            entriesById: {},
        });
        expect(readOnly[0]).toMatchObject({ kind: 'badge', label: 'Issue #42' });
        expect(readOnly[0]?.onRemove).toBeUndefined();

        // Positive twin: an editable scope still supplies removal.
        const onRemove = vi.fn();
        const editable = projectComposerAttachmentRowItems({ attachments, onRemove });
        editable[0]?.onRemove?.();
        expect(onRemove).toHaveBeenCalledWith('issue-42');
    });

    it('accepts only the exact daemon-admitted attachment definition instead of trusting an id-keyed catalog collision', () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        };
        const mismatchedEntry: PluginProjectedComposerAttachmentEntryV1 = {
            id: 'acme.issues/issue',
            pluginId: 'acme.issues',
            identity: { pluginId: 'acme.issues', localId: 'other-issue' },
            immutableGenerationId: 'issues-generation-7',
            definition: {
                id: 'other-issue',
                title: 'Other issue',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                display: { kind: 'surface', renderer: { renderer: 'issue-display' }, sizing: 'content' },
            },
        };

        expect(resolveComposerAttachmentCatalogRowDescriptor({
            attachment,
            entriesById: { [mismatchedEntry.id]: mismatchedEntry },
        })).toBeNull();

        const matchingEntry: PluginProjectedComposerAttachmentEntryV1 = {
            ...mismatchedEntry,
            identity: attachment.attachment,
            definition: {
                ...mismatchedEntry.definition,
                id: attachment.attachment.localId,
            },
        };

        expect(resolveComposerAttachmentCatalogRowDescriptor({
            attachment,
            entriesById: { [matchingEntry.id]: matchingEntry },
        })).toEqual({
            identity: attachment.attachment,
            immutableGenerationId: matchingEntry.immutableGenerationId,
            display: { kind: 'surface', renderer: { renderer: 'issue-display' }, sizing: 'content' },
        });

        expect(resolveComposerAttachmentCatalogRowDescriptor({
            attachment,
            entriesById: {
                [matchingEntry.id]: {
                    ...matchingEntry,
                    id: 'acme.issues/forged-issue',
                },
            },
        })).toBeNull();
    });

    it('mounts a custom display and preview interaction only through the exact current attachment catalog row', () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        };
        const matchingEntry: PluginProjectedComposerAttachmentEntryV1 = {
            id: 'acme.issues/issue',
            pluginId: 'acme.issues',
            identity: attachment.attachment,
            immutableGenerationId: 'issues-generation-7',
            definition: {
                id: attachment.attachment.localId,
                title: 'Issue',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                display: { kind: 'surface', renderer: { renderer: 'issue-display' }, sizing: 'content' },
                preview: { kind: 'surface', renderer: { renderer: 'issue-preview' }, presentation: 'popover' },
            },
        };
        const renderSurface = vi.fn(() => ({
            sizing: 'content' as const,
            renderedContent: 'exact composer display',
        }));
        const renderPreviewPopover = vi.fn(() => null);
        const resolveInteraction = vi.fn(() => ({ renderPreviewPopover }));
        // Keep the extension facts in a value before passing it to the older
        // projection signature: the RED proves current code ignores this live
        // catalog relation rather than failing from fixture typing.
        const projectionInput = {
            attachments: [attachment],
            onRemove: vi.fn(),
            entriesById: { [matchingEntry.id]: matchingEntry },
            renderSurface,
            resolveInteraction,
        };

        const items = projectComposerAttachmentRowItems(projectionInput);

        expect(renderSurface).toHaveBeenCalledWith(expect.objectContaining({
            attachment,
            catalog: expect.objectContaining({ identity: attachment.attachment }),
        }));
        expect(items[0]).toMatchObject({
            kind: 'surface',
            key: 'composer-attachment:issue-42',
            sizing: 'content',
            renderedContent: 'exact composer display',
            renderPreviewPopover,
        });
        expect(resolveInteraction).toHaveBeenCalledWith(expect.objectContaining({
            attachment,
            catalog: expect.objectContaining({ identity: attachment.attachment }),
        }));

        const mismatchedItems = projectComposerAttachmentRowItems({
            ...projectionInput,
            entriesById: {
                [matchingEntry.id]: {
                    ...matchingEntry,
                    identity: { pluginId: attachment.attachment.pluginId, localId: 'different' },
                    definition: { ...matchingEntry.definition, id: 'different' },
                },
            },
        });
        expect(mismatchedItems[0]).toMatchObject({ kind: 'badge' });
        expect(mismatchedItems[0]).not.toHaveProperty('renderPreviewPopover');
    });

    it('projects an exact ready staged image through the host media row without exposing a path or URI', () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'image-42',
            attachment: { pluginId: 'acme.images', localId: 'image' },
            key: '42',
            value: { imageId: 42 },
            presentation: { label: 'Incident image', typeLabel: 'Image' },
            availability: { status: 'ready' },
            content: {
                kind: 'stagedMedia',
                handle: {
                    v: 1,
                    id: 'stage_42',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    owner: { pluginId: 'acme.images', localId: 'image' },
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    name: 'incident.png',
                    sizeBytes: 42,
                    sha256: 'a'.repeat(64),
                },
            },
        };
        const entry: PluginProjectedComposerAttachmentEntryV1 = {
            id: 'acme.images/image',
            pluginId: 'acme.images',
            identity: attachment.attachment,
            immutableGenerationId: 'images-generation-7',
            definition: {
                id: 'image',
                title: 'Image',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                display: { kind: 'media', media: 'image' },
                preview: { kind: 'host', presentation: 'image' },
            },
        };
        const onPress = vi.fn();
        const resolveMedia = vi.fn(() => ({
            media: 'image' as const,
            renderedPreview: 'host-staged-image-preview',
            onPress,
        }));
        const resolveInteraction = vi.fn(() => ({ onPress: vi.fn() }));
        const defaultItems = projectComposerAttachmentRowItems({
            attachments: [attachment],
            onRemove: vi.fn(),
            entriesById: { [entry.id]: entry },
        });
        expect(defaultItems[0]).toMatchObject({
            kind: 'media',
            key: 'composer-attachment:image-42',
            media: 'image',
            renderedPreview: expect.anything(),
            onPress: expect.any(Function),
        });
        expect(defaultItems[0]).not.toHaveProperty('uri');
        expect(defaultItems[0]).not.toHaveProperty('path');
        const projectionInput = {
            attachments: [attachment],
            onRemove: vi.fn(),
            entriesById: { [entry.id]: entry },
            resolveMedia,
            resolveInteraction,
        };

        const items = projectComposerAttachmentRowItems(projectionInput);

        expect(resolveMedia).toHaveBeenCalledWith(expect.objectContaining({
            attachment,
            catalog: expect.objectContaining({
                identity: attachment.attachment,
                display: entry.definition.display,
                preview: entry.definition.preview,
            }),
        }));
        expect(resolveInteraction).not.toHaveBeenCalled();
        expect(items[0]).toMatchObject({
            kind: 'media',
            key: 'composer-attachment:image-42',
            media: 'image',
            renderedPreview: 'host-staged-image-preview',
            onPress,
        });
        expect(items[0]).not.toHaveProperty('uri');
        expect(items[0]).not.toHaveProperty('path');

        const unavailableItems = projectComposerAttachmentRowItems({
            ...projectionInput,
            attachments: [{ ...attachment, availability: { status: 'unavailable' } }],
        });
        expect(resolveMedia).toHaveBeenCalledTimes(1);
        expect(unavailableItems[0]).toMatchObject({ kind: 'badge', availability: 'unavailable' });

        const wrongOwnerItems = projectComposerAttachmentRowItems({
            ...projectionInput,
            attachments: [{
                ...attachment,
                content: {
                    kind: 'stagedMedia',
                    handle: {
                        ...attachment.content!.handle,
                        owner: { pluginId: 'acme.other', localId: 'image' },
                    },
                },
            }],
        });
        expect(resolveMedia).toHaveBeenCalledTimes(1);
        expect(wrongOwnerItems[0]).toMatchObject({ kind: 'badge', availability: 'ready' });
    });

    it('projects an exact staged video through the same host media row and preview adapter', () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'video-42',
            attachment: { pluginId: 'acme.recordings', localId: 'recording' },
            key: '42',
            value: { recordingId: 42 },
            presentation: { label: 'Incident recording', typeLabel: 'Recording' },
            availability: { status: 'ready' },
            content: {
                kind: 'stagedMedia',
                handle: {
                    v: 1,
                    id: 'stage_video_42',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    owner: { pluginId: 'acme.recordings', localId: 'recording' },
                    mediaKind: 'video',
                    mimeType: 'video/webm',
                    name: 'incident.webm',
                    sizeBytes: 42,
                    sha256: 'b'.repeat(64),
                },
            },
        };
        const entry: PluginProjectedComposerAttachmentEntryV1 = {
            id: 'acme.recordings/recording',
            pluginId: 'acme.recordings',
            identity: attachment.attachment,
            immutableGenerationId: 'recordings-generation-7',
            definition: {
                id: 'recording',
                title: 'Recording',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                display: { kind: 'media', media: 'video' },
                preview: { kind: 'host', presentation: 'video' },
            },
        };

        const items = projectComposerAttachmentRowItems({
            attachments: [attachment],
            onRemove: vi.fn(),
            entriesById: { [entry.id]: entry },
        });

        expect(items[0]).toMatchObject({
            kind: 'media',
            key: 'composer-attachment:video-42',
            media: 'video',
            renderedPreview: expect.anything(),
            onPress: expect.any(Function),
        });
        expect(items[0]).not.toHaveProperty('uri');
        expect(items[0]).not.toHaveProperty('path');
    });

    it('forwards a declared preview interaction only for the exact ready attachment row', () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        };
        const entry: PluginProjectedComposerAttachmentEntryV1 = {
            id: 'acme.issues/issue',
            pluginId: 'acme.issues',
            identity: attachment.attachment,
            immutableGenerationId: 'issues-generation-7',
            definition: {
                id: attachment.attachment.localId,
                title: 'Issue',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                preview: {
                    kind: 'surface',
                    renderer: { renderer: 'issue-preview' },
                    presentation: 'popover',
                },
            },
        };
        const onPress = vi.fn();
        const renderPreviewPopover = vi.fn(() => null);
        const resolveInteraction = vi.fn(() => ({ onPress, renderPreviewPopover }));

        const items = projectComposerAttachmentRowItems({
            attachments: [attachment],
            onRemove: vi.fn(),
            entriesById: { [entry.id]: entry },
            resolveInteraction,
        });

        expect(resolveInteraction).toHaveBeenCalledWith(expect.objectContaining({
            attachment,
            catalog: expect.objectContaining({
                identity: attachment.attachment,
                immutableGenerationId: entry.immutableGenerationId,
                preview: entry.definition.preview,
            }),
        }));
        expect(items[0]).toMatchObject({
            kind: 'badge',
            onPress,
            renderPreviewPopover,
        });

        const unavailableItems = projectComposerAttachmentRowItems({
            attachments: [{ ...attachment, availability: { status: 'unavailable' } }],
            onRemove: vi.fn(),
            entriesById: { [entry.id]: entry },
            resolveInteraction,
        });
        expect(resolveInteraction).toHaveBeenCalledTimes(1);
        expect(unavailableItems[0]).not.toHaveProperty('onPress');
        expect(unavailableItems[0]).not.toHaveProperty('renderPreviewPopover');
    });
});
