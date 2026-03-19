import { z } from 'zod';
import {
  findActionInputFieldHint,
  getActionSpecForCatalogSurface,
  getSerializedActionSpecForSurface,
  searchSerializedActionSpecsForSurface,
  serializeActionFieldOptions,
  type ActionId,
  type ResolvedActionOption,
} from '@happier-dev/protocol';

export const actionSpecSearchSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
}).passthrough();

export const actionSpecGetSchema = z.object({ id: z.string().min(1) }).passthrough();

export const actionOptionsResolveSchema = z.object({
  actionId: z.string().min(1).optional(),
  fieldPath: z.string().min(1).optional(),
  optionsSourceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  query: z.string().optional(),
}).passthrough().superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'actionId + fieldPath or optionsSourceId is required',
      path: ['actionId'],
    });
  }
});

export type ActionSpecDiscoveryResult<T> =
  | Readonly<{ ok: true; result: T }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type ResolveActionOptionsPayload = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  options: readonly ResolvedActionOption[];
}>;

function filterResolvedActionOptions(
  options: readonly ResolvedActionOption[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly ResolvedActionOption[] {
  const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
  const limit = typeof params?.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(200, Math.floor(params.limit)))
    : null;

  const filtered = query
    ? options.filter((option) =>
        [option.value, option.label, option.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query))
    : [...options];

  return limit === null ? filtered : filtered.slice(0, limit);
}

type ResolveActionOptions = (args: Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  sessionId: string | null;
  limit: number | null;
  query: string | null;
}>) => Promise<ActionSpecDiscoveryResult<ResolveActionOptionsPayload> | null>;

type SearchActionSpecsPayload = Readonly<{
  actionSpecs: ReturnType<typeof searchSerializedActionSpecsForSurface>;
}>;

type GetActionSpecPayload = Readonly<{
  actionSpec: NonNullable<ReturnType<typeof getSerializedActionSpecForSurface>>;
}>;

export async function searchActionSpecsForMcpSurface(
  args: unknown,
  isActionEnabled: (id: ActionId) => boolean,
): Promise<ActionSpecDiscoveryResult<SearchActionSpecsPayload>> {
  const parsed = actionSpecSearchSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' };

  return {
    ok: true,
    result: {
      actionSpecs: searchSerializedActionSpecsForSurface({
        surface: 'mcp',
        query: parsed.data.query ?? '',
        limit: parsed.data.limit,
        isActionEnabled,
      }),
    },
  };
}

export async function getActionSpecForMcpSurface(
  args: unknown,
  isActionEnabled: (id: ActionId) => boolean,
): Promise<ActionSpecDiscoveryResult<GetActionSpecPayload>> {
  const parsed = actionSpecGetSchema.safeParse(args);
  if (!parsed.success) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' };

  try {
    const actionSpec = getSerializedActionSpecForSurface({
      id: parsed.data.id as ActionId,
      surface: 'mcp',
      isActionEnabled,
    });
    if (!actionSpec) {
      return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled' };
    }
    return { ok: true, result: { actionSpec } };
  } catch {
    return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Unknown action spec' };
  }
}

export async function resolveActionOptionsForMcpSurface(
  args: unknown,
  isActionEnabled: (id: ActionId) => boolean,
  resolveActionOptions: ResolveActionOptions,
): Promise<ActionSpecDiscoveryResult<ResolveActionOptionsPayload>> {
  const parsed = actionOptionsResolveSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' };

  const actionId = typeof parsed.data.actionId === 'string' ? (parsed.data.actionId as ActionId) : null;
  const fieldPath = typeof parsed.data.fieldPath === 'string' ? parsed.data.fieldPath : null;
  const directOptionsSourceId = typeof parsed.data.optionsSourceId === 'string' ? parsed.data.optionsSourceId : null;

  let resolvedActionId: ActionId | null = actionId;
  let resolvedFieldPath: string | null = fieldPath;
  let resolvedOptionsSourceId: string | null = directOptionsSourceId;

  if (actionId && fieldPath) {
    try {
      const actionSpec = getSerializedActionSpecForSurface({
        id: actionId,
        surface: 'mcp',
        isActionEnabled,
      });
      if (!actionSpec) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled' };
      }

      const spec = getActionSpecForCatalogSurface({
        id: actionId,
        surface: 'mcp',
        isActionEnabled,
      });
      if (!spec) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled' };
      }
      const field = findActionInputFieldHint(spec, fieldPath);
      if (!field) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Unknown action field' };

      const staticOptions = serializeActionFieldOptions(field);
      if (staticOptions.length > 0) {
        return {
          ok: true,
          result: {
            actionId: spec.id,
            fieldPath,
            optionsSourceId: null,
            options: filterResolvedActionOptions(staticOptions, {
              query: parsed.data.query ?? null,
              limit: parsed.data.limit ?? null,
            }),
          },
        };
      }

      resolvedActionId = spec.id;
      resolvedFieldPath = fieldPath;
      resolvedOptionsSourceId = field.optionsSourceId ?? directOptionsSourceId ?? null;
    } catch {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Unknown action spec' };
    }
  }

  let resolved: ActionSpecDiscoveryResult<ResolveActionOptionsPayload> | null;
  try {
    resolved = await resolveActionOptions({
      actionId: resolvedActionId,
      fieldPath: resolvedFieldPath,
      optionsSourceId: resolvedOptionsSourceId,
      sessionId: typeof parsed.data.sessionId === 'string' ? parsed.data.sessionId : null,
      limit: typeof parsed.data.limit === 'number' ? parsed.data.limit : null,
      query: typeof parsed.data.query === 'string' ? parsed.data.query : null,
    });
  } catch {
    return { ok: false, errorCode: 'action_options_resolve_failed', error: 'Options source resolution failed' };
  }

  if (!resolved) return { ok: false, errorCode: 'options_source_not_supported', error: 'Options source is not supported' };
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    result: {
      ...resolved.result,
      options: filterResolvedActionOptions(resolved.result.options, {
        query: parsed.data.query ?? null,
        limit: parsed.data.limit ?? null,
      }),
    },
  };
}
