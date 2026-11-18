import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '../actions/executor/types.js';
import { z } from '../zodRuntimePolicy.js';
import type { InputOption } from './inputFields.js';
import { readNonEmptyString } from './inputRecords.js';

/** The host option source a widget field names to pick one of the selected Home's saved Checks. */
export const SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1 =
  'health.checks.saved' as const;

/**
 * One saved Check, by the address its own pages use (the Automation and its health-check trigger). The address names
 * the Check only; reading it decrypts the viewer's own definition and results, so the value never carries its content.
 */
export const SavedHealthCheckRefV1Schema = z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  automationId: z.string().check(z.minLength(1)),
  triggerId: z.string().check(z.minLength(1)),
});
export type SavedHealthCheckRefV1 = z.infer<typeof SavedHealthCheckRefV1Schema>;

/** A saved Check as the host names it (the name its Checks list shows), with what it is beside it. */
export type SavedHealthCheckOptionV1 = Readonly<{
  automationId: string;
  triggerId: string;
  label: string;
  description?: string;
}>;
export type SavedHealthChecksListResultV1 = Readonly<{
  items: readonly SavedHealthCheckOptionV1[];
}>;

/**
 * `health.checks.saved`: the selected Home's saved Checks, named by the host that can open their private definitions.
 * The list itself is the host's (`savedHealthChecksList`); this source only addresses each one on the selected Home.
 */
export async function resolveSavedHealthCheckOptionsV1(
  params: Readonly<{
    deps: Pick<ActionExecutorDeps, 'savedHealthChecksList'>;
    ctx: ActionExecutorContext;
    readFailure: (result: unknown) => ActionExecuteFailure | null;
  }>,
): Promise<
  ActionExecuteFailure | Readonly<{ ok: true; result: readonly InputOption[] }>
> {
  const serverId = readNonEmptyString(params.ctx.serverId);
  if (!serverId)
    return {
      ok: false,
      errorCode: 'server_not_selected',
      error: 'server_not_selected',
    };
  if (!params.deps.savedHealthChecksList) {
    return {
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:health.checks.saved',
    };
  }
  const listed = await params.deps.savedHealthChecksList(
    { serverId },
    params.ctx,
  );
  const failure = params.readFailure(listed);
  if (failure) return failure;
  params.ctx.signal?.throwIfAborted();
  if ('ok' in listed)
    return {
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    };
  return {
    ok: true,
    result: listed.items.map((item) => ({
      value: {
        serverId,
        automationId: item.automationId,
        triggerId: item.triggerId,
      },
      label: item.label,
      ...(item.description === undefined
        ? {}
        : { description: item.description }),
    })),
  };
}
