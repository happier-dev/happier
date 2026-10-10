import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { WidgetSnapshotDocumentV1Schema, WidgetSnapshotMetadataV1Schema } from './declarative/snapshot.js';
import { WidgetInstanceV1Schema as InstanceSchema } from '../../widgets/widgetInstanceV1.js';
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
import { getWidgetSharedInputIssuesV1 } from '../../widgets/widgetSharedInputAdmissionV1.js';
import { UiSurfaceCapabilityRequestV1Schema } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { PluginHostedHtmlSourceV1Schema } from '../../plugins/contributions/ui/hostedHtmlSourceV1.js';
import { PluginUiLaunchInputV1Schema } from '../../plugins/ui/semanticCommands.js';
import { SessionSurfaceDeclarativeDocumentV1Schema } from './declarative/authoring.js';

const HeightSizeSchema = lazyZodSchema(() => z.enum(['compact', 'regular', 'tall']));
export const SessionSurfaceItemDestinationV1Schema = lazyZodSchema(() => z.enum(['transcript', 'board', 'both']));
export type SessionSurfaceItemDestinationV1 = z.infer<typeof SessionSurfaceItemDestinationV1Schema>;
export const SessionSurfaceItemV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  /** Creation intent; Pin and Unpin belong to layout and do not rewrite it. */
  destination: SessionSurfaceItemDestinationV1Schema.optional(),
  title: z.string().trim(),
  frame: z.enum(['card', 'full_bleed', 'frameless']),
  height: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto'), fallback: HeightSizeSchema }).strict(),
    z.object({ mode: z.literal('fixed'), size: HeightSizeSchema }).strict(),
  ]),
  source: z.discriminatedUnion('kind', [
    // Development host projection: no saved prose, marks, result id or executable authority.
    z.object({ kind: z.literal('walkthrough'), comparison: z.enum(['session', 'workingTree']) }).strict(),
    z.object({ kind: z.literal('declarative'), document: SessionSurfaceDeclarativeDocumentV1Schema }).strict(),
    z.object({
      kind: z.literal('hostedHtml'),
      source: PluginHostedHtmlSourceV1Schema,
      // The capability grammar owns canonical host Action ids, whose closed
      // family includes Board Actions. Defer this edge until parse time so the
      // public schemas can share that owner without an initialization cycle.
      requestedCapabilities: z.lazy(() => UiSurfaceCapabilityRequestV1Schema).optional(),
    }).strict(),
    z.object({
      kind: z.literal('widget'),
      // Account-private definitions must be explicitly copied into shared content.
      instance: WidgetInstanceV1Schema.superRefine((instance, context) => {
        if (instance.definition.kind === 'artifact') context.addIssue({ code: 'custom', path: ['definition'], message: 'A shared Session widget cannot reference an Account-private definition.' });
        for (const issue of getWidgetSharedInputIssuesV1(instance)) {
          context.addIssue({ code: 'custom', path: issue.inputPath ? ['bindings', issue.inputPath] : ['definition'],
            message: issue.reasonCode === 'widget_shared_resource_input_literal'
              ? 'Shared live Resource reads must use the viewer-resolved widget inputs, not authored input literals.'
              : issue.inputPath ? 'Shared connection inputs require viewer intent.'
                : 'A shared definition cannot contain a private Connected Account selection.' });
        }
      }),
    }).strict(),
  ]),
  input: PluginUiLaunchInputV1Schema.optional(),
  snapshot: WidgetSnapshotMetadataV1Schema.optional(),
}).strict().superRefine((item, context) => {
  if (item.snapshot !== undefined && (item.input !== undefined || item.source.kind !== 'declarative'
    || !WidgetSnapshotDocumentV1Schema.safeParse(item.source.document).success)) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'A snapshot requires inert declarative content without launch input' });
  }
}));
export type SessionSurfaceItemV1 = Readonly<z.infer<typeof SessionSurfaceItemV1Schema>>;
/** Persisted content drops additive fields before the strict Action/result owners consume it. */
defineStoredReadProjection(SessionSurfaceItemV1Schema, () => createStoredReadSchema(SessionSurfaceItemV1Schema.clone())
  .transform(item => ({ ...item, destination: item.destination ?? 'board' as const })));
export const SessionSurfaceItemV1StoredSchema = createStoredReadSchema(SessionSurfaceItemV1Schema);

/** A Board widget's instance identity is its existing canonical record identity. */
export function isSessionSurfaceItemIdentityCorrespondingV1(itemId: string, item: SessionSurfaceItemV1): boolean {
  return item.source.kind !== 'widget' || item.source.instance.id === itemId;
}

/** Compare opened records before sealing; this does not prove encrypted record history. */
export function isSessionSurfaceItemSourceCompatible(previous: SessionSurfaceItemV1, next: SessionSurfaceItemV1): boolean {
  if ((previous.destination ?? 'board') !== (next.destination ?? 'board')) return false;
  if (previous.source.kind !== next.source.kind) return false;
  if (previous.source.kind !== 'widget') return true;
  if (next.source.kind !== 'widget' || previous.source.instance.id !== next.source.instance.id) return false;
  const before = previous.source.instance.definition;
  const after = next.source.instance.definition;
  if (before.kind === 'installed') return after.kind === 'installed'
    && before.surface.pluginId === after.surface.pluginId && before.surface.localId === after.surface.localId;
  if (before.kind === 'builtin') return after.kind === 'builtin' && before.id === after.id;
  if (before.kind === 'inline') return after.kind === 'inline' && before.definition.id === after.definition.id;
  return false;
}
