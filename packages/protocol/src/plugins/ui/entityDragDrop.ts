import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** Browser delivery hint only; the host realm carry remains the identity/admission authority. */
export const ENTITY_DRAG_DELIVERY_MIME_V1 = 'application/x-happier-entity-carry';
import { BoardItemRefV1Schema } from '../../boards/workBoardV1.js';

import { VoiceTrackedSessionAddressV1Schema } from '../../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { SessionCompanionPresentationItemRefV1Schema } from '../../sessions/presentation/currentSessionPresentationV1.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { PluginContributionIdentityV1Schema, parseQualifiedPluginContributionKey } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { WidgetInstanceRefV1Schema } from '../../widgets/widgetInstanceV1.js';
import { supportsWidgetGroupsV1 } from '../../widgets/widgetPresentationV1.js';

const Id = z.string().trim().min(1);

/** Intentional grip movement before carrying; shared by native and hosted adapters. */
export const ENTITY_DRAG_ACTIVATION_DISTANCE_PX = 4;

/** V1 is a transient wire epoch, independent of package SemVer. All envelopes are closed. */
export const EntityDragScopeV1Schema = lazyZodSchema(() => z.object({ serverId: Id, accountId: Id }).strict());
export type EntityDragScopeV1 = Readonly<z.infer<typeof EntityDragScopeV1Schema>>;

// Reuse the existing exact SessionAddress grammar, rather than interpreting raw Session ids.
export const EntityDragSessionAddressV1Schema = VoiceTrackedSessionAddressV1Schema;
const scope = EntityDragScopeV1Schema;
const address = EntityDragSessionAddressV1Schema;

/** Identity only. Files from the OS remain boundary-local handles outside this union. */
export const EntityDragItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), scope, address }).strict(),
    z.object({ kind: z.literal('session-folder'), scope, folderId: Id }).strict(),
    z.object({ kind: z.literal('artifact'), scope, artifactId: Id }).strict(),
    z.object({ kind: z.literal('artifact-folder'), scope, folderId: Id }).strict(),
    z.object({ kind: z.literal('session-workspace'), scope, workspaceId: Id }).strict(),
    z.object({ kind: z.literal('workspace-tab'), scope, tabId: Id }).strict(),
    z.object({ kind: z.literal('destination'), scope, href: Id.refine(href => href.startsWith('/') && !href.startsWith('//')) }).strict(),
    // A local navigation preference is carried only within its own customization list.
    z.object({ kind: z.literal('navigation-item'), scope, surfaceId: Id, itemId: Id }).strict(),
    z.object({ kind: z.literal('repository-file'), scope, machineId: Id, workspaceId: Id.optional(), path: Id }).strict(),
    z.object({ kind: z.literal('session-board-item'), scope, address, viewId: Id, itemId: Id }).strict(),
    z.object({ kind: z.literal('work-board-item'), scope, boardId: Id, item: BoardItemRefV1Schema }).strict(),
    // A configured widget placed on a WorkBoard: its qualified instance ref is `scope` + this Board + id.
    z.object({ kind: z.literal('work-board-widget'), scope, boardId: Id, instanceId: Id }).strict(),
    z.object({ kind: z.literal('widget-area-instance'), scope, ref: WidgetInstanceRefV1Schema }).strict(),
    z.object({ kind: z.literal('widget-layout-group'), scope, ref: WidgetInstanceRefV1Schema }).strict(),
    z.object({ kind: z.literal('companion-item'), scope, address, item: SessionCompanionPresentationItemRefV1Schema }).strict(),
    z.object({ kind: z.literal('home-section'), scope, sectionId: Id }).strict(),
    z.object({ kind: z.literal('pool-member'), scope, pool: QualifiedConnectedAccountGroupRefSchema, member: asProtocolZod(QualifiedConnectedAccountRefSchema) }).strict(),
    z.object({ kind: z.literal('pending-input'), scope, address, localId: Id }).strict(),
    z.object({ kind: z.literal('todo'), scope, todoId: Id }).strict(),
    // The source contribution validates reference against its declared schema before registration.
    // Widget placements consume the widgets program's contract through this contributed arm.
    z.object({ kind: z.literal('plugin'), scope, contribution: asProtocolZod(PluginContributionIdentityV1Schema), reference: PluginUiJsonValueV1Schema }).strict(),
]).superRefine((item, context) => {
    if ('address' in item && item.address.serverId !== item.scope.serverId) {
        context.addIssue({ code: 'custom', path: ['address', 'serverId'], message: 'Session address must belong to the carried Home.' });
    }
    if (item.kind === 'widget-area-instance' || item.kind === 'widget-layout-group') {
        const owner = item.ref.surface.owner.kind;
        if (item.kind === 'widget-area-instance' ? owner !== 'project' && owner !== 'pluginArea' && owner !== 'corePage'
            : !supportsWidgetGroupsV1(owner)) {
            context.addIssue({ code: 'custom', path: ['ref', 'surface', 'owner'], message: 'Widget area reference required.' });
        }
        if (item.ref.surface.serverId !== item.scope.serverId || item.ref.surface.accountId !== item.scope.accountId) {
            context.addIssue({ code: 'custom', path: ['ref', 'surface'], message: 'Widget reference must belong to the carried Account.' });
        }
    }
    // A WorkBoard placement belongs to scope; its live-work reference may name another Home.
    // BoardItemRef's qualified identity remains intact and does not select the Board's writer.
}));
export type EntityDragItemV1 = Readonly<z.infer<typeof EntityDragItemV1Schema>>;
export type EntityDragKindV1 = Exclude<EntityDragItemV1['kind'], 'plugin'> | `plugin:${string}/${string}`;

/** Kind membership comes from the same item grammar, including qualified plugin identity. */
export function isEntityDragKindV1(kind: unknown): kind is EntityDragKindV1 {
    return typeof kind === 'string' && (kind.startsWith('plugin:')
        ? parseQualifiedPluginContributionKey(kind.slice(7)) !== null
        : kind !== 'plugin' && EntityDragItemV1Schema.options.some(option => option.shape.kind.value === kind));
}

export function entityDragKindV1(item: EntityDragItemV1): EntityDragKindV1 {
    return item.kind === 'plugin'
        ? `plugin:${item.contribution.pluginId}/${item.contribution.localId}`
        : item.kind;
}

export function entityDragScopesEqualV1(left: EntityDragScopeV1, right: EntityDragScopeV1): boolean {
    return left.serverId === right.serverId && left.accountId === right.accountId;
}

/** Named outcome marks from the shared release-preview icon vocabulary; presentation only. */
export const EntityDropGlyphV1Schema = lazyZodSchema(() => z.enum([
    'nest', 'above', 'below', 'folder', 'topLevel', 'open', 'tab', 'goTo', 'split', 'splitVertical',
    'here', 'copy', 'attach', 'upload', 'add', 'move', 'board', 'refused',
]));
export const EntityDropPreviewV1Schema = lazyZodSchema(() => z.object({ verb: Id, target: Id, consequence: Id.optional(), glyph: EntityDropGlyphV1Schema.optional() }).strict());
export const EntityDropReasonV1Schema = lazyZodSchema(() => z.object({ code: Id, message: Id }).strict());
export type EntityDropPreviewV1 = Readonly<z.infer<typeof EntityDropPreviewV1Schema>>;
export type EntityDropReasonV1 = Readonly<z.infer<typeof EntityDropReasonV1Schema>>;

/** A semantic request; its bound Action host still owns policy, routing and execution. */
export const EntityDropEffectV1Schema = lazyZodSchema(() => z.object({
    actionId: Id,
    input: PluginUiJsonValueV1Schema,
    preview: EntityDropPreviewV1Schema,
}).strict());
export type EntityDropEffectV1 = Readonly<z.infer<typeof EntityDropEffectV1Schema>>;

export const EntityDropAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({ status: z.literal('allowed'), effect: EntityDropEffectV1Schema }).strict(),
    z.object({ status: z.literal('refused'), reason: EntityDropReasonV1Schema, preview: EntityDropPreviewV1Schema.optional() }).strict(),
]));
export type EntityDropAdmissionV1 = Readonly<z.infer<typeof EntityDropAdmissionV1Schema>>;

export const EntityDropOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({ status: z.literal('applied') }).strict(),
    z.object({ status: z.literal('refused'), reason: EntityDropReasonV1Schema }).strict(),
    z.object({ status: z.literal('unknown'), reason: EntityDropReasonV1Schema }).strict(),
]));
export type EntityDropOutcomeV1 = Readonly<z.infer<typeof EntityDropOutcomeV1Schema>>;
