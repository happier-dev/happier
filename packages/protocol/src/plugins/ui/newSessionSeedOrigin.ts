import * as zMini from '../../zodRuntimePolicy.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { WorkspaceAnchorV1Schema, WorkspaceAnchorSourceV1Schema } from '../../workspace/anchors/v1.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginUiInstanceKeyV1Schema } from './semanticCommands.js';

// Keep the existing anchor vocabulary and refinements, with closed routing ingress.
const OriginFileAnchorV1Schema = lazyZodSchema(() => z.union(WorkspaceAnchorV1Schema._zod.def.options.map(option => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(option))));

/** Original destination, independent of the editable execution placement. */
export const PluginUiNewSessionSeedOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('project'),
  accountId: z.string().check(z.trim(), z.minLength(1)),
  workspace: WorkspaceAddressV1Schema,
  page: z.enum(['overview', 'code', 'changes', 'scripts', 'services', 'context']),
  /** Omitted by incumbent setup/discussion seeds; ordinary New session is never setup evidence. */
  purpose: z.optional(z.literal('session')),
  comparisonId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  layoutId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  attachedDashboard: z.optional(z.strictObject({ sourceId: z.string().check(z.trim(), z.minLength(1)), artifactId: z.string().check(z.trim(), z.minLength(1)),
    serverId: z.optional(z.string().check(z.trim(), z.minLength(1))) })),
  codeLocation: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('folder'), path: z.string() }),
    z.strictObject({ kind: z.literal('file'), path: z.string().check(z.minLength(1)) }),
  ])),
  resource: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), path: z.string().check(z.minLength(1)), anchor: z.optional(OriginFileAnchorV1Schema),
      anchorSource: zMini.optional(WorkspaceAnchorSourceV1Schema) }),
    z.strictObject({ kind: z.literal('commit'), sha: z.string().check(z.trim(), z.minLength(1)) }),
  ])),
  surface: z.optional(z.enum(['overview', 'code', 'changes', 'scripts', 'services', 'context', 'browse', 'git', 'tabs', 'terminal', 'browser'])),
  companion: z.optional(z.union([
    z.enum(['files', 'git', 'scripts', 'services', 'terminal', 'browser']),
    z.strictObject({ kind: z.literal('plugin'), destination: asProtocolZod(PluginContributionIdentityV1Schema),
      instanceKey: zMini.optional(PluginUiInstanceKeyV1Schema) }),
  ])),
}));
export type PluginUiNewSessionSeedOriginV1 = z.infer<typeof PluginUiNewSessionSeedOriginV1Schema>;
export const StoredPluginUiNewSessionSeedOriginV1Schema = createStoredReadSchema(PluginUiNewSessionSeedOriginV1Schema);
