import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUtf8String,
  type ProtocolSchemaOutput,
} from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  definePluginUiSemanticCommandProtocolSchemaV1,
  PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1,
} from '../ui/semanticCommands.js';
import { PLUGIN_UI_ICON_TOKENS_V1 } from './ui/tokens.js';

/**
 * The declarative Universal Search provider family.
 *
 * It is deliberately NOT `composerReferences`. A composer reference answers
 * "what model-facing context should this message carry", resolves to text and
 * is inserted into a draft. A search provider answers "which entities match
 * what the reader typed", returns host-rendered rows, and the reader opens or
 * executes one through the incumbent semantic-command owner. Overloading one
 * family onto the other would make a provider's insertion contract decide a
 * navigation, so the two stay separate families with separate contracts.
 *
 * Everything a provider needs beyond `{ id, action }` already belongs to the
 * referenced Action: title, description, icon, availability, execution target,
 * currentness and cancellation. The host owns debounce, minimum query length,
 * empty-query policy, section order, row caps and rendering. Neither side is
 * restated here.
 */

/**
 * The bounds below are the incumbent bounded-page family's, not new numbers.
 *
 * `composerReferenceProviders.ts` already answers "how much may one typed query
 * and one bounded page of rows carry across this transport" — 256 query bytes,
 * 32 rows and a 128-code-point label. A search response is the same shape of
 * thing over the same transport, so it inherits those answers rather than
 * inventing a second set for one product to reason about. Only the subtitle
 * differs: a search row's context line carries a repository and a state where a
 * composer candidate's carries a short description.
 */

/** One typed query carries at most this much text; the host bounds the field. */
export const MAX_PLUGIN_SEARCH_QUERY_UTF8_BYTES_V1 = 256;
/** One provider section renders at most this many rows. */
export const MAX_PLUGIN_SEARCH_ITEMS_V1 = 32;
/** A provider-local row identity is opaque to the host and bounded like every other contribution id. */
export const MAX_PLUGIN_SEARCH_ITEM_ID_UTF8_BYTES_V1 = 256;
export const MAX_PLUGIN_SEARCH_TITLE_CODE_POINTS_V1 = 128;
export const MAX_PLUGIN_SEARCH_SUBTITLE_CODE_POINTS_V1 = 256;

/**
 * A row's activation target is bounded by the boundary it crosses, not by a
 * nearby number: the semantic command union's own members are a bounded launch
 * input, a bounded plugin-local sub-path and a bounded instance key, plus the
 * discriminator, destination reference and JSON framing around them.
 */
export const MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1 =
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1
  + PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1
  + PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1
  + 512;

/**
 * The declarative half of one search provider.
 *
 * `action` is a bare same-plugin local id. A qualified reference is deliberately
 * absent: a provider that could point at another plugin's Action would make the
 * declaring plugin's section execute a contribution it does not own, and the
 * eligibility rules below are checked against the declaring manifest.
 */
export const PluginSearchProviderContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  action: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginSearchProviderContributionV1 = z.infer<
  typeof PluginSearchProviderContributionV1Schema
>;

/**
 * The one query input every search provider Action consumes.
 *
 * It is a composable Protocol schema rather than a hand-written JSON Schema so
 * that an author declares this exact value on the Action, keeps the handler's
 * inferred input type, and gets the same admission at the Action boundary that
 * the host applies on the wire. Because both sides hold one value, no
 * JSON-Schema normalization or deep-equivalence comparison exists anywhere in
 * this vertical.
 */
export const PluginSearchQueryV1Schema = defineProtocolObject({
  query: defineProtocolUtf8String({
    maxUtf8Bytes: MAX_PLUGIN_SEARCH_QUERY_UTF8_BYTES_V1,
    minLength: 1,
  }),
  /** The host's row cap for this section. A provider may return fewer, never more. */
  limit: defineProtocolNumber({ integer: true, minimum: 1, maximum: MAX_PLUGIN_SEARCH_ITEMS_V1 }),
}, { policy: 'closed' });
export type PluginSearchQueryV1 = ProtocolSchemaOutput<typeof PluginSearchQueryV1Schema>;

const searchItemIconToken = defineProtocolUnion([
  defineProtocolLiteral(PLUGIN_UI_ICON_TOKENS_V1[0]),
  defineProtocolLiteral(PLUGIN_UI_ICON_TOKENS_V1[1]),
  // The token set has exactly one owner; this projects it rather than listing
  // its members a second time.
  ...PLUGIN_UI_ICON_TOKENS_V1.slice(2).map((token) => defineProtocolLiteral(token)),
]);

/**
 * The activation target is carried as one bounded value and parsed by the
 * incumbent semantic-command owner.
 *
 * Restating the `executeAction | openSurface` union in this DSL would create a
 * second parser for one contract — including a second answer to sub-path
 * normalization — so this binds that owner's own composable projection. A row
 * whose command that union refuses is refused here, rather than being carried
 * to activation as a value nothing can run.
 */
const searchItemCommand = definePluginUiSemanticCommandProtocolSchemaV1({
  maxSerializedUtf8Bytes: MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1,
});

const protocolBoolean = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

/**
 * One host-rendered row.
 *
 * It carries display data and one activation target, and nothing else. No
 * callback, URL, router path, raw relevance score, HTML, preview metadata,
 * pagination cursor or host-internal id: each of those would either move
 * rendering, ranking or navigation authority out of the host, or let one
 * provider's number be compared against another's.
 */
export const PluginSearchItemV1Schema = defineProtocolObject({
  /** Stable within the provider. The host namespaces it before it becomes a row identity. */
  id: defineProtocolUtf8String({
    maxUtf8Bytes: MAX_PLUGIN_SEARCH_ITEM_ID_UTF8_BYTES_V1,
    minLength: 1,
  }),
  title: defineProtocolUtf8String({
    // Code points bound what the row shows; bytes bound what it costs.
    maxUtf8Bytes: MAX_PLUGIN_SEARCH_TITLE_CODE_POINTS_V1 * 4,
    minLength: 1,
    maxLength: MAX_PLUGIN_SEARCH_TITLE_CODE_POINTS_V1,
  }),
  subtitle: defineProtocolUtf8String({
    maxUtf8Bytes: MAX_PLUGIN_SEARCH_SUBTITLE_CODE_POINTS_V1 * 4,
    minLength: 1,
    maxLength: MAX_PLUGIN_SEARCH_SUBTITLE_CODE_POINTS_V1,
  }).optional(),
  icon: searchItemIconToken.optional(),
  command: searchItemCommand,
}, { policy: 'closed' });
export type PluginSearchItemV1 = ProtocolSchemaOutput<typeof PluginSearchItemV1Schema>;

/**
 * `truncated` is required so a bounded answer is never presented as a complete
 * one. A provider that returned `limit` rows and stopped says so; the host
 * renders that fact rather than implying the reader has seen everything.
 */
export const PluginSearchResultV1Schema = defineProtocolObject({
  items: defineProtocolArray(PluginSearchItemV1Schema, { maxItems: MAX_PLUGIN_SEARCH_ITEMS_V1 }),
  truncated: protocolBoolean,
}, { policy: 'closed' });
export type PluginSearchResultV1 = ProtocolSchemaOutput<typeof PluginSearchResultV1Schema>;

/** The declared Action facts a search provider's query Action must carry. */
type DeclaredQueryActionV1 = Readonly<{
  id: string;
  scopes?: readonly string[];
  surfaces?: readonly string[];
  placementBindings?: readonly string[];
  dangerLevel?: string;
}>;

/**
 * The one admission rule for `contributes.searchProviders`.
 *
 * It lives beside the schemas it enforces so the reference rule and the
 * eligibility rule cannot drift into two owners. The catalog's generic
 * `action → actions` reference rule already proves the target exists as a
 * contribution; this adds the facts that make the target a *search query*
 * Action rather than any declared Action:
 *
 *  - `safe`, because a universal-search keystroke must never be a consequential
 *    action a reader did not choose;
 *  - `global`, because the surface has no session/message/workspace subject to
 *    scope it to;
 *  - the `ui` origin, because the caller is a present-user host surface;
 *  - no ordinary placement, because the section is the only affordance — a
 *    query Action is not also a command-palette entry.
 *
 * It deliberately does not compare declared schemas: the declaration is the
 * canonical composable value above, ordinary Action dispatch validates against
 * it, and the universal boundary parses the returned result through the same
 * owner. A provider that answers off-contract fails there, honestly, instead of
 * being admitted or refused by a JSON-Schema equivalence walk.
 */
export function validatePluginSearchProviderContributionsV1(
  value: Readonly<{
    searchProviders: readonly PluginSearchProviderContributionV1[];
    actions: readonly DeclaredQueryActionV1[];
  }>,
  ctx: z.RefinementCtx,
): void {
  const providerIds = new Set<string>();
  value.searchProviders.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['searchProviders', index, 'id'],
        message: 'Duplicate search provider contribution id',
      });
    }
    providerIds.add(provider.id);
    const path = ['searchProviders', index, 'action'] as const;
    const action = value.actions.find((candidate) => candidate.id === provider.action);
    if (!action) {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Search provider action must reference a declared same-plugin Action',
      });
      return;
    }
    if (action.dangerLevel !== 'safe') {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Search provider query Actions must be declared safe',
      });
    }
    if (!action.scopes?.includes('global')) {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Search provider query Actions must declare the global scope',
      });
    }
    if (!action.surfaces?.includes('ui')) {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Search provider query Actions must declare the ui surface',
      });
    }
    if (action.placementBindings === undefined || action.placementBindings.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Search provider query Actions must declare no ordinary Action placement',
      });
    }
  });
}
