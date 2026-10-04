import { z } from 'zod';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { UiSurfaceCapabilityRequestV1Schema } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { PluginHostedHtmlSourceV1Schema } from '../../plugins/contributions/ui/hostedHtmlSourceV1.js';
import { PluginUiLaunchInputV1Schema } from '../../plugins/ui/semanticCommands.js';
import { SessionSurfaceDeclarativeDocumentV1Schema } from './declarative/authoring.js';

const HeightSizeSchema = z.enum(['compact', 'regular', 'tall']);
export const SessionSurfaceItemV1Schema = z.object({
  v: z.literal(1),
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
    z.object({ kind: z.literal('installedSurface'), surface: asProtocolZod(PluginContributionIdentityV1Schema) }).strict(),
  ]),
  input: PluginUiLaunchInputV1Schema.optional(),
}).strict();
export type SessionSurfaceItemV1 = Readonly<z.infer<typeof SessionSurfaceItemV1Schema>>;

/** Compare opened records before sealing; this does not prove encrypted record history. */
export function isSessionSurfaceItemSourceCompatible(previous: SessionSurfaceItemV1, next: SessionSurfaceItemV1): boolean {
  if (previous.source.kind !== next.source.kind) return false;
  if (previous.source.kind !== 'installedSurface') return true;
  return next.source.kind === 'installedSurface'
    && previous.source.surface.pluginId === next.source.surface.pluginId
    && previous.source.surface.localId === next.source.surface.localId;
}
