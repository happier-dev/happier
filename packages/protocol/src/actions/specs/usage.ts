import { UsageQueryBatchInputSchema } from '../../inputs/usageQuery.js';
import { UsageQueryBatchResultSchema } from '../../usage/resolveUsagePageAggregation.js';
import { UsageExportInputSchema, UsageFileResultSchema } from '../../usage/usageExport.js';
import { UsageRecapComposeInputSchema, UsageRecapComposeResultSchema, UsageRecapExportResultSchema, USAGE_RECAP_STYLES, USAGE_RECAP_FORMATS } from '../../usage/usageRecap.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { UsageCalendarExportInputSchema } from '../../usage/usageCalendarExport.js';
import { UsageModelPriceCatalogSchema } from '../../usage/usageModelPriceCatalog.js';
import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export { USAGE_ACTION_IDS, type UsageActionId } from '../../usage/usageActionIdsV1.js';

const common = {
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account',
  placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { commands: [], acceptsServerId: true },
} satisfies Pick<PreNormalizedActionSpec, 'safety' | 'sideEffectClass' | 'requiredAuthority' | 'executionPlacement' | 'placements' | 'surfaces' | 'cli'>;

export const USAGE_ACTION_SPECS = [
  { ...common, id: 'usage.prices.get', title: 'Read model prices',
    description: 'Read the current public standard API price catalog and its provenance. Account data is never sent to the price source.',
    bindings: { mcpToolName: 'usage_prices_get' }, inputSchema: lazyZodSchema(() => z.object({}).strict()), outputSchema: UsageModelPriceCatalogSchema,
    inputHints: { fields: [] } },
  { ...common, id: 'usage.prices.refresh', title: 'Refresh model prices', sideEffectClass: 'write',
    description: 'Fetch and cache the fixed public LiteLLM catalog when server configuration permits it. No Account or session data is sent; failure retains cached or bundled prices with visible provenance.',
    bindings: { mcpToolName: 'usage_prices_refresh' }, inputSchema: lazyZodSchema(() => z.object({}).strict()), outputSchema: UsageModelPriceCatalogSchema,
    inputHints: { fields: [] } },
  { ...common, id: 'usage.calendar.export', title: 'Export usage calendar',
    description: 'Return calendar file bytes for explicitly selected admitted quota resets and subscription renewals. This does not connect to or write a calendar service.',
    bindings: { mcpToolName: 'usage_calendar_export' }, inputSchema: UsageCalendarExportInputSchema, outputSchema: UsageFileResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'selectedEvents', title: 'Selected reset and renewal facts', widget: 'json', required: true }] } },
  { ...common, id: 'usage.recap.export', title: 'Export a private usage recap', executionPlacement: 'client',
    description: 'Render the same authorized selected-field recap on the executing client and return PNG file bytes. A headless caller receives compose data with explicit image unavailability. Save, Copy and Share remain explicit local operations.',
    bindings: { mcpToolName: 'usage_recap_export' }, inputSchema: UsageRecapComposeInputSchema, outputSchema: UsageRecapExportResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'style', title: 'Style', widget: 'select', options: USAGE_RECAP_STYLES.map(value => ({ value, label: value })) },
      { path: 'format', title: 'Format', widget: 'select', options: USAGE_RECAP_FORMATS.map(value => ({ value, label: value })) },
      { path: 'selectedFields', title: 'Selected fields', widget: 'text_list' }] } },
  { ...common, id: 'usage.recap.compose', title: 'Compose a private usage recap',
    description: 'Compose a private selected-field preview from the same authorized usage query. Names and dollars are excluded by default. Missing historical detail stays unavailable. This operation produces data without opening a share sheet or publishing.',
    bindings: { mcpToolName: 'usage_recap_compose' }, inputSchema: UsageRecapComposeInputSchema, outputSchema: UsageRecapComposeResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'style', title: 'Style', widget: 'select', options: USAGE_RECAP_STYLES.map(value => ({ value, label: value })) },
      { path: 'format', title: 'Format', widget: 'select', options: USAGE_RECAP_FORMATS.map(value => ({ value, label: value })) },
      { path: 'selectedFields', title: 'Selected fields', widget: 'text_list' }] } },
  { ...common, id: 'usage.query', title: 'Query usage', description: 'Read the current authorized personal usage snapshot for a batch of independently resolved queries. Source harvesting and vendor refresh do not block this read.',
    bindings: { mcpToolName: 'usage_query' }, inputSchema: UsageQueryBatchInputSchema, outputSchema: UsageQueryBatchResultSchema,
    inputHints: { fields: [{ path: 'queries', title: 'Usage queries', widget: 'json', required: true }] } },
  { ...common, id: 'usage.export', title: 'Export usage', description: 'Serialize explicitly selected authorized usage facts as JSON, CSV or text file bytes. Local Save, Copy and Share remain explicit client operations.',
    bindings: { mcpToolName: 'usage_export' }, inputSchema: UsageExportInputSchema, outputSchema: UsageFileResultSchema,
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
      { path: 'format', title: 'Format', widget: 'select', required: true, options: [{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'text', label: 'Text' }] },
      { path: 'fields', title: 'Selected facts', widget: 'text_list', listSeparator: 'newline', required: true }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
