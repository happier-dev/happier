import * as React from 'react';
import {
    type ComposerAttachmentViewV1,
    type ComposerContentHandleV1,
    type PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';

import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { Icon } from '@/components/ui/icons/Icon';
import type {
    AgentInputAttachmentRowBadge,
    AgentInputAttachmentsRowItem,
    ComposerAttachmentCatalogRowDescriptor,
    ComposerAttachmentRowMediaPresentation,
    ComposerAttachmentRowSurfacePresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { projectComposerAttachmentRowItem } from '@/components/sessions/agentInput/agentInputContracts';
import { t } from '@/text';
import { resolveCurrentComposerAttachmentCatalogEntry } from './composerScopeAdapters';
import { createComposerStagedMediaAttachmentPresentation } from './composerStagedMediaAttachmentPresentation';

function projectPluginAttachmentIcon(iconToken: ComposerAttachmentViewV1['presentation']['icon']) {
    if (!iconToken) return undefined;
    const name = resolvePluginUiIconName(iconToken);
    return (tint: string) => React.createElement(Icon, { name, size: 14, color: tint });
}

/**
 * The composition owner decides how an exact attachment launches. The row
 * receives only host presentation callbacks, never catalog authority.
 */
export type ComposerAttachmentRowInteractionPresentation = Pick<
    AgentInputAttachmentRowBadge,
    'onPress' | 'renderPreviewPopover'
>;

export type ComposerAttachmentRowMediaResolver = (input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
    /** Opaque staged-media custody; no source path, URI, or bytes cross this seam. */
    handle: ComposerContentHandleV1;
}>) => ComposerAttachmentRowMediaPresentation | undefined;

function resolveComposerAttachmentStagedMediaHandle(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
}>): ComposerContentHandleV1 | null {
    const content = input.attachment.content;
    if (content?.kind !== 'stagedMedia' || input.catalog.display?.kind !== 'media') return null;

    const handle = content.handle;
    if (handle.mediaKind !== input.catalog.display.media) return null;
    if (
        handle.owner.pluginId !== input.attachment.attachment.pluginId
        || handle.owner.localId !== input.attachment.attachment.localId
    ) {
        return null;
    }
    return handle;
}

/**
 * Reads one attachment descriptor from the daemon-normalized UI projection.
 * This is a lookup only: it neither normalizes a declaration nor treats a
 * retained catalog entry as a live renderer capability.
 */
export function resolveComposerAttachmentCatalogRowDescriptor(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>> | null | undefined;
}>): ComposerAttachmentCatalogRowDescriptor | null {
    const entry = resolveCurrentComposerAttachmentCatalogEntry(input.attachment, input.entriesById);
    if (!entry) return null;

    return {
        identity: entry.identity,
        immutableGenerationId: entry.immutableGenerationId,
        ...(entry.definition.picker === undefined ? {} : { picker: entry.definition.picker }),
        ...(entry.definition.display === undefined ? {} : { display: entry.definition.display }),
        ...(entry.definition.preview === undefined ? {} : { preview: entry.definition.preview }),
    };
}

/**
 * The minimum no-picker/no-control attachment presentation. Rich media and
 * surface declarations are mounted by the catalog/currentness path; this
 * fallback intentionally relies only on persisted semantic presentation so an
 * unavailable plugin remains visible and removable.
 */
export function projectComposerAttachmentRowItems(input: Readonly<{
    attachments: readonly ComposerAttachmentViewV1[];
    /**
     * Removal is a Composer document mutation. The owning scope supplies it
     * only while its exact `ComposerSnapshotV1.state.editable` allows one; an
     * explicit read-only/locked scope omits it so the row does not render a
     * control whose transaction the owner would refuse. Non-mutating preview,
     * picker and surface interaction remain available either way.
     */
    onRemove?: (instanceId: string) => void;
    /** The current daemon-normalized attachment projection, never a retained local catalog. */
    entriesById?: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>>;
    /**
     * The composition owner supplies an already-bound PluginSurfaceHost node.
     * This projection only chooses whether the exact declared display can use it.
     */
    renderSurface?: (input: Readonly<{
        attachment: ComposerAttachmentViewV1;
        catalog: ComposerAttachmentCatalogRowDescriptor;
    }>) => ComposerAttachmentRowSurfacePresentation | undefined;
    /**
     * Resolves an exact opaque staged-media handle into incumbent host media
     * presentation. It never receives a filesystem path, URI, or bytes.
     */
    resolveMedia?: ComposerAttachmentRowMediaResolver;
    /** The composition owner resolves a declared picker/preview presentation, if any. */
    resolveInteraction?: (input: Readonly<{
        attachment: ComposerAttachmentViewV1;
        catalog: ComposerAttachmentCatalogRowDescriptor;
    }>) => ComposerAttachmentRowInteractionPresentation | undefined;
}>): readonly AgentInputAttachmentsRowItem[] {
    return input.attachments.map((attachment) => {
        const catalog = input.entriesById === undefined
            ? null
            : resolveComposerAttachmentCatalogRowDescriptor({
                attachment,
                entriesById: input.entriesById,
            });
        const handle = attachment.availability.status === 'ready' && catalog !== null
            ? resolveComposerAttachmentStagedMediaHandle({ attachment, catalog })
            : null;
        const media = handle === null || catalog === null
            ? undefined
            : (input.resolveMedia ?? createComposerStagedMediaAttachmentPresentation)({ attachment, catalog, handle });
        // A host preview is authoritative for staged media. Do not give a
        // plugin surface a competing activation path for that same row.
        const interaction = attachment.availability.status === 'ready'
            && catalog !== null
            && catalog.preview?.kind !== 'host'
            ? input.resolveInteraction?.({ attachment, catalog })
            : undefined;
        // This row owns the instance's label, error feedback and removal for a
        // surface item too, so a mounted custom display receives no row-shaped
        // fallback: its failure state is body-level content inside this row.
        const surface = attachment.availability.status === 'ready'
            && catalog?.display?.kind === 'surface'
            ? input.renderSurface?.({ attachment, catalog })
            : undefined;
        const removeAttachment = input.onRemove;
        const onRemove = removeAttachment === undefined
            ? undefined
            : () => removeAttachment(attachment.instanceId);
        const projected = projectComposerAttachmentRowItem({
            attachment,
            catalog,
            ...(media === undefined ? {} : { media }),
            ...(surface === undefined ? {} : { surface }),
            ...(interaction === undefined ? {} : interaction),
            ...(onRemove === undefined ? {} : { onRemove }),
            testID: `composer-attachment:${attachment.instanceId}`,
            accessibilityLabel: `${attachment.presentation.typeLabel}: ${attachment.presentation.label}`,
            removeAccessibilityLabel: `${t('common.remove')} ${attachment.presentation.typeLabel}: ${attachment.presentation.label}`,
        });
        const icon = projectPluginAttachmentIcon(attachment.presentation.icon);
        return projected.kind === 'badge'
            ? {
                ...projected,
                key: `composer-attachment:${attachment.instanceId}`,
                ...(icon === undefined ? {} : { icon }),
            }
            : {
                ...projected,
                key: `composer-attachment:${attachment.instanceId}`,
            };
    });
}
