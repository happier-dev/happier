import { normalizeUsageQueryBatchInput, getUsageQueryKey, UsageQueryBatchInputSchema, type UsageQueryBatchInput } from '../../inputs/usageQuery.js';
import { UsageQueryBatchResultSchema, type UsageQueryBatchResult } from '../../usage/resolveUsagePageAggregation.js';
import { UsageExportInputSchema, buildUsageFileResult } from '../../usage/usageExport.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from './types.js';
import type { UsageActionId } from '../specs/usage.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { UsageRecapComposeInputSchema, UsageRecapExportResultSchema, usageRecapImageFileName,
  type UsageRecapComposed } from '../../usage/usageRecap.js';
import { composeUsageRecap } from '../../usage/composeUsageRecap.js';
import { UsageCalendarExportInputSchema, buildUsageCalendarFileResult } from '../../usage/usageCalendarExport.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '../../connect/providerAccountUsageHistory.js';
import { sameQualifiedConnectedAccountRef } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '../../usage/usageModelPriceCatalog.js';

export type UsageActionPorts = Readonly<{
  prices?: Readonly<{
    get(context: ActionExecutorContext): Promise<UsageModelPriceCatalog | ActionExecuteFailure>;
    refresh(context: ActionExecutorContext): Promise<UsageModelPriceCatalog | ActionExecuteFailure>;
  }>;
  query(request: UsageQueryBatchInput, context: ActionExecutorContext): Promise<UsageQueryBatchResult | ActionExecuteFailure>;
  /** Optional authorized retained-B opener for explicitly selected calendar accounts. Never refreshes a provider. */
  readQuota?(input: ConnectedServiceQuotaGetInputV1, context: ActionExecutorContext): Promise<ConnectedServiceQuotaGetResultV1 | ActionExecuteFailure>;
  /** Optional client-only rasterization boundary. Headless hosts can read query/B facts without image rendering. */
  renderRecap?(compose: UsageRecapComposed, context: ActionExecutorContext): Promise<
    Readonly<{ kind: 'rendered'; base64: string }> | Readonly<{ kind: 'unavailable'; reason: 'render_target_unavailable' | 'render_failed' }>>;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

export async function executeUsageAction(actionId: UsageActionId, value: unknown, ports: UsageActionPorts | undefined, context: ActionExecutorContext): Promise<ActionExecuteResult> {
  if (context.signal?.aborted) return failure('cancelled');
  if (!ports) return failure('unsupported_action');
  if (actionId === 'usage.prices.get' || actionId === 'usage.prices.refresh') {
    if (!ports.prices) return failure('unsupported_action');
    const raw = await ports.prices[actionId === 'usage.prices.get' ? 'get' : 'refresh'](context);
    if (context.signal?.aborted) return failure('cancelled');
    const refusal = readActionFailureEnvelope(raw);
    if (refusal) return refusal;
    const parsed = UsageModelPriceCatalogSchema.safeParse(raw);
    return parsed.success ? { ok: true, result: parsed.data } : failure('usage_price_catalog_invalid');
  }
  const read = async (input: UsageQueryBatchInput): Promise<UsageQueryBatchResult | ActionExecuteFailure> => {
    const { queries } = normalizeUsageQueryBatchInput(input);
    const raw = await ports.query({ queries }, context);
    if (context.signal?.aborted) return failure('cancelled');
    const refusal = readActionFailureEnvelope(raw);
    if (refusal) return refusal;
    const parsed = UsageQueryBatchResultSchema.safeParse(raw);
    if (!parsed.success) return failure('usage_query_result_invalid');
    const wanted = new Set(queries.map(getUsageQueryKey));
    if (parsed.data.results.length !== wanted.size || parsed.data.results.some(slice =>
      !wanted.delete(slice.key) || getUsageQueryKey(slice.requestedQuery) !== slice.key || getUsageQueryKey(slice.shownQuery) !== slice.key)) {
      return failure('usage_query_result_invalid');
    }
    return parsed.data;
  };
  if (actionId === 'usage.query') {
    const result = await read(UsageQueryBatchInputSchema.parse(value));
    return 'ok' in result ? result : { ok: true, result };
  }
  if (actionId === 'usage.recap.compose' || actionId === 'usage.recap.export') {
    const request = UsageRecapComposeInputSchema.parse(value);
    const queried = await read({ queries: [request.query] });
    if ('ok' in queried) return queried;
    const snapshot = queried.results[0];
    if (!snapshot) return failure('usage_query_result_invalid');
    const compose = composeUsageRecap({ input: request, snapshot });
    if (actionId === 'usage.recap.compose') return { ok: true, result: compose };
    if (compose.kind !== 'composed') return { ok: true, result: { kind: 'unavailable', reason: 'compose_unavailable', compose } };
    if (!ports.renderRecap) return { ok: true, result: { kind: 'unavailable', reason: 'render_target_unavailable', compose } };
    const rendered = await ports.renderRecap(compose, context);
    if (context.signal?.aborted) return failure('cancelled');
    if (rendered.kind === 'unavailable') return { ok: true, result: { kind: 'unavailable', reason: rendered.reason, compose } };
    const result = UsageRecapExportResultSchema.safeParse({ kind: 'exported', compose,
      file: { v: 1, mediaType: 'image/png', fileName: usageRecapImageFileName(compose), base64: rendered.base64,
        selectedFields: compose.selectedFields, asOfMs: compose.asOfMs } });
    return result.success ? { ok: true, result: result.data } : failure('usage_recap_result_invalid');
  }
  if (actionId === 'usage.calendar.export') {
    const request = UsageCalendarExportInputSchema.parse(value);
    if (ports.readQuota) {
      const accounts = request.selectedEvents.map(event => event.account).filter((account, index, all) =>
        all.findIndex(candidate => sameQualifiedConnectedAccountRef(candidate, account)) === index);
      const results = await Promise.all(accounts.map(account => ports.readQuota!({ source: { bindingKind: 'account', ref: account } }, context)));
      if (context.signal?.aborted) return failure('cancelled');
      const quota: ConnectedServiceQuotaGetResultV1[] = [];
      for (const [index, raw] of results.entries()) {
        const refusal = readActionFailureEnvelope(raw);
        if (refusal) return refusal;
        const result = ConnectedServiceQuotaGetResultV1Schema.safeParse(raw);
        if (!result.success || result.data.source.bindingKind !== 'account'
          || !sameQualifiedConnectedAccountRef(result.data.source.ref, accounts[index]!)) return failure('usage_quota_result_invalid');
        quota.push(result.data);
      }
      const file = buildUsageCalendarFileResult(request, quota);
      return file ? { ok: true, result: file } : failure('usage_calendar_fact_unavailable');
    }
    const queried = await read({ queries: [request.query] });
    if ('ok' in queried) return queried;
    const file = buildUsageCalendarFileResult(request, queried.results[0]?.quota ?? []);
    return file ? { ok: true, result: file } : failure('usage_calendar_fact_unavailable');
  }
  const request = UsageExportInputSchema.parse(value);
  const queried = await read({ queries: [request.query] });
  if ('ok' in queried) return queried;
  const slice = queried.results[0];
  if (!slice?.accounting) return failure('usage_accounting_unavailable');
  const asOfMs = slice.sources.find(source => source.source === 'accounting')?.asOfMs ?? null;
  return { ok: true, result: buildUsageFileResult(request, slice.accounting, asOfMs) };
}
