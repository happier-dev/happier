import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { UsageQueryBatchInputSchema, UsageHistoryReadInputSchema, UsageHistoryReadStateSchema, USAGE_HISTORY_OPERATIONS } from '../../inputs/usageQuery.js';
import { USAGE_HISTORY_ACTION_IDS } from '../../usage/usageActionIdsV1.js';
import { UsageQueryBatchResultSchema } from '../../usage/resolveUsagePageAggregation.js';
import { UsageExportInputSchema, UsageFileResultSchema } from '../../usage/usageExport.js';
import { UsageRecapPrivateComposeInputSchema, UsageRecapPublicComposeInputSchema, UsageRecapComposeResultSchema, UsageRecapExportResultSchema, UsageRecapPrivateDeliveryInputSchema, UsageRecapPublicDeliveryInputSchema, UsageRecapDeliveryResultSchema, USAGE_RECAP_STYLES, USAGE_RECAP_FORMATS } from '../../usage/usageRecap.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { UsageCalendarExportInputSchema } from '../../usage/usageCalendarExport.js';
import { UsageModelPriceReadInputSchema, UsageModelPriceReadResultSchema } from '../../usage/usageModelPriceDelivery.js';
import type { InputFieldHint } from '../../inputs/inputFields.js';
import type { z } from '../../zodRuntimePolicy.js';
import type { UsageActionId } from '../../usage/usageActionIdsV1.js';

export { USAGE_ACTION_IDS, type UsageActionId } from '../../usage/usageActionIdsV1.js';

const common = {
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account',
  placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { commands: [], acceptsServerId: true },
} satisfies Pick<PreNormalizedActionSpec, 'safety' | 'sideEffectClass' | 'requiredAuthority' | 'executionPlacement' | 'placements' | 'surfaces' | 'cli'>;

const recapSourceSelectionField = { path: 'sourceSelection', title: 'Private usage sources', widget: 'select',
  options: [{ value: 'whole_usage', label: 'Whole usage' }, { value: 'happier_only', label: 'Happier only' }] } satisfies InputFieldHint;
const recapAppearanceFields = [
  { path: 'style', title: 'Style', widget: 'select', options: USAGE_RECAP_STYLES.map(value => ({ value, label: value })) },
  { path: 'format', title: 'Format', widget: 'select', options: USAGE_RECAP_FORMATS.map(value => ({ value, label: value })) },
  { path: 'selectedFields', title: 'Selected fields', widget: 'text_list', listSeparator: 'newline' },
] satisfies InputFieldHint[];
const privateRecapFields = [{ path: 'query', title: 'Private Usage query', widget: 'json', required: true,
  inputType: { hostType: 'usageQuery' } }, recapSourceSelectionField, ...recapAppearanceFields] satisfies InputFieldHint[];
const publicRecapFields = [{ path: 'source', title: 'Public source', widget: 'json', required: true },
  ...recapAppearanceFields] satisfies InputFieldHint[];
const recapDeliveryField = { path: 'intent', title: 'Delivery', widget: 'select', required: true,
  options: ['copy', 'save', 'share'].map(value => ({ value, label: value })) } satisfies InputFieldHint;

type UsageActionSpec<Id extends UsageActionId, Input extends z.ZodMiniType, Output extends z.ZodMiniType> =
  Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema' | 'surfaceBindings'> & Readonly<{
    id: Id; inputSchema: Input; outputSchema: Output;
  }>;

// Keep per-id schema correlations without expanding schema implementations into
// the factory's inferred declaration, matching the Execution Run spec boundary.
export type UsageActionSpecs = readonly [
  UsageActionSpec<typeof USAGE_HISTORY_ACTION_IDS.read, typeof UsageHistoryReadInputSchema, typeof UsageHistoryReadStateSchema>,
  UsageActionSpec<'usage.recap.deliver', typeof UsageRecapPublicDeliveryInputSchema, typeof UsageRecapDeliveryResultSchema>,
  UsageActionSpec<'usage.recap.private.deliver', typeof UsageRecapPrivateDeliveryInputSchema, typeof UsageRecapDeliveryResultSchema>,
  UsageActionSpec<'usage.prices.get', typeof UsageModelPriceReadInputSchema, typeof UsageModelPriceReadResultSchema>,
  UsageActionSpec<'usage.prices.refresh', typeof UsageModelPriceReadInputSchema, typeof UsageModelPriceReadResultSchema>,
  UsageActionSpec<'usage.calendar.export', typeof UsageCalendarExportInputSchema, typeof UsageFileResultSchema>,
  UsageActionSpec<'usage.recap.export', typeof UsageRecapPublicComposeInputSchema, typeof UsageRecapExportResultSchema>,
  UsageActionSpec<'usage.recap.private.export', typeof UsageRecapPrivateComposeInputSchema, typeof UsageRecapExportResultSchema>,
  UsageActionSpec<'usage.recap.compose', typeof UsageRecapPublicComposeInputSchema, typeof UsageRecapComposeResultSchema>,
  UsageActionSpec<'usage.recap.private.compose', typeof UsageRecapPrivateComposeInputSchema, typeof UsageRecapComposeResultSchema>,
  UsageActionSpec<'usage.query', typeof UsageQueryBatchInputSchema, typeof UsageQueryBatchResultSchema>,
  UsageActionSpec<'usage.export', typeof UsageExportInputSchema, typeof UsageFileResultSchema>,
];

function createUsageActionSpecs(): UsageActionSpecs {
  return [
  { ...common, id: USAGE_HISTORY_ACTION_IDS.read, approval: { result: 'none' }, title: 'Read Usage history',
    sideEffectClass: 'write', executionPlacement: 'client',
    description: 'Explicitly read missing Session facts for a selected Usage window, observe its progress, or cancel its admitted local read. Derived facts persist through the Session content owner.',
    bindings: { mcpToolName: 'usage_history_read' }, inputSchema: UsageHistoryReadInputSchema, outputSchema: UsageHistoryReadStateSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'operation', title: 'Operation', widget: 'select', options: USAGE_HISTORY_OPERATIONS.map(value => ({ value, label: value })) }] } },
  { ...common, id: 'usage.recap.deliver', approval: {result: 'none'}, title: 'Copy, save or share a usage recap',
    approvalPolicy: { uiConfirmation: 'direct' },
    safety: 'danger', sideEffectClass: 'external', executionPlacement: 'client',
    description: 'Compose and render selected admitted facts, then perform the explicit device delivery intent. Cancellation and unconfirmed system-sheet outcomes are reported without claiming delivery. Native Save opens the system sheet; it does not promise a photo-library write.',
    bindings: { mcpToolName: 'usage_recap_deliver' }, inputSchema: UsageRecapPublicDeliveryInputSchema, outputSchema: UsageRecapDeliveryResultSchema,
    inputHints: { fields: [...publicRecapFields, recapDeliveryField] } },
  { ...common, id: 'usage.recap.private.deliver', approval: { result: 'none' }, title: 'Copy, save or share a private usage recap',
    approvalPolicy: { uiConfirmation: 'direct' }, safety: 'danger', sideEffectClass: 'external', executionPlacement: 'client',
    description: 'Compose and render selected authorized private Usage facts, then perform the explicit device delivery intent. Cancellation and unconfirmed system-sheet outcomes do not claim delivery. Caller-provided bytes and paths are refused.',
    bindings: { mcpToolName: 'usage_recap_private_deliver' }, inputSchema: UsageRecapPrivateDeliveryInputSchema, outputSchema: UsageRecapDeliveryResultSchema,
    inputHints: { fields: [...privateRecapFields, recapDeliveryField] } },
  { ...common, id: 'usage.prices.get', approval: {result: 'none'}, title: 'Read model prices',
    serverTransport: { method: 'GET', path: '/v1/account/usage/prices' },
    description: 'Read public standard API prices and provenance. Agent/MCP reads return modelCount and provenance by default; supply modelIds to read exact catalog entries. Unknown model ids remain absent. UI/CLI reads without selectors return the full catalog. Account data is never sent to the price source.',
    bindings: { mcpToolName: 'usage_prices_get' }, inputSchema: UsageModelPriceReadInputSchema, outputSchema: UsageModelPriceReadResultSchema,
    inputHints: { fields: [{ path: 'modelIds', title: 'Exact model ids', widget: 'text_list', listSeparator: 'newline' }] } },
  { ...common, id: 'usage.prices.refresh', approval: {result: 'none'}, title: 'Refresh model prices', sideEffectClass: 'write',
    serverTransport: { method: 'POST', path: '/v1/account/usage/prices/refresh' },
    description: 'Fetch and cache the fixed public LiteLLM catalog when server configuration permits it. Agent/MCP reads return modelCount and provenance by default; supply modelIds to read exact catalog entries. Unknown model ids remain absent. No Account or session data is sent; failure retains cached or bundled prices with visible provenance.',
    bindings: { mcpToolName: 'usage_prices_refresh' }, inputSchema: UsageModelPriceReadInputSchema, outputSchema: UsageModelPriceReadResultSchema,
    inputHints: { fields: [{ path: 'modelIds', title: 'Exact model ids', widget: 'text_list', listSeparator: 'newline' }] } },
  { ...common, id: 'usage.calendar.export', approval: {result: 'none'}, title: 'Export usage calendar',
    description: 'Return calendar file bytes for explicitly selected admitted quota resets and subscription renewals. This does not connect to or write a calendar service.',
    bindings: { mcpToolName: 'usage_calendar_export' }, inputSchema: UsageCalendarExportInputSchema, outputSchema: UsageFileResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'selectedEvents', title: 'Selected reset and renewal facts', widget: 'json', required: true }] } },
  { ...common, id: 'usage.recap.export', approval: {result: 'none'}, title: 'Export a usage recap', executionPlacement: 'client',
    description: 'Render the captured Account’s current admitted public profile and return PNG file bytes without reading private Usage. Headless callers receive compose data with explicit image unavailability. Save, Copy and Share require explicit delivery.',
    bindings: { mcpToolName: 'usage_recap_export' }, inputSchema: UsageRecapPublicComposeInputSchema, outputSchema: UsageRecapExportResultSchema,
    inputHints: { fields: publicRecapFields } },
  { ...common, id: 'usage.recap.private.export', approval: { result: 'none' }, title: 'Export a private usage recap', executionPlacement: 'client',
    description: 'Render an authorized selected-field private Usage query and return PNG file bytes. Headless callers receive compose data with explicit image unavailability. Save, Copy and Share require explicit delivery.',
    bindings: { mcpToolName: 'usage_recap_private_export' }, inputSchema: UsageRecapPrivateComposeInputSchema, outputSchema: UsageRecapExportResultSchema,
    inputHints: { fields: privateRecapFields } },
  { ...common, id: 'usage.recap.compose', approval: {result: 'none'}, title: 'Compose a usage recap',
    description: 'Compose a selected-field preview from the captured Account’s current admitted public profile without reading private Usage. Private names and dollars are refused. This produces data without opening a share sheet or publishing.',
    bindings: { mcpToolName: 'usage_recap_compose' }, inputSchema: UsageRecapPublicComposeInputSchema, outputSchema: UsageRecapComposeResultSchema,
    inputHints: { fields: publicRecapFields } },
  { ...common, id: 'usage.recap.private.compose', approval: { result: 'none' }, title: 'Compose a private usage recap',
    description: 'Compose a selected-field preview from an authorized private Usage query. Names and dollars are excluded by default. Missing detail stays unavailable. This produces data without opening a share sheet or publishing.',
    bindings: { mcpToolName: 'usage_recap_private_compose' }, inputSchema: UsageRecapPrivateComposeInputSchema, outputSchema: UsageRecapComposeResultSchema,
    inputHints: { fields: privateRecapFields } },
  { ...common, id: 'usage.query', approval: {result: 'none'}, title: 'Query usage', description: 'Read the current authorized personal usage snapshot for a batch of independently resolved queries. Source harvesting and vendor refresh do not block this read. Agent/MCP reads return accounting totals, breakdowns and Work summary counts by default; select one Session with session to read Work allocations and transcript detail. Narrow period and filters and select include flags or workProjection: summary to request only needed facts. Evidence omitted for delivery is listed in each slice’s incomplete.omittedSections with narrow_query recovery. Summary accounting remains admitted, not truncated.',
    bindings: { mcpToolName: 'usage_query' }, inputSchema: UsageQueryBatchInputSchema, outputSchema: UsageQueryBatchResultSchema,
    inputHints: { fields: [{ path: 'queries', title: 'Usage queries', widget: 'json', required: true }] } },
  { ...common, id: 'usage.export', approval: {result: 'none'}, title: 'Export usage', description: 'Serialize explicitly selected authorized usage facts as JSON, CSV or text file bytes. Local Save, Copy and Share remain explicit client operations.',
    bindings: { mcpToolName: 'usage_export' }, inputSchema: UsageExportInputSchema, outputSchema: UsageFileResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'format', title: 'Format', widget: 'select', required: true, options: [{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'text', label: 'Text' }] },
      { path: 'fields', title: 'Selected facts', widget: 'text_list', listSeparator: 'newline', required: true }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const USAGE_ACTION_SPECS: UsageActionSpecs = lazyActionSpecArray(createUsageActionSpecs);
