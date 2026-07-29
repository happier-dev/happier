import {
  getActionSpec,
  type BrowserDiagnosticsSnapshotV1,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from './store';
import { redactBrowserDiagnosticsSnapshotForViewer } from './snapshotEgress';

/**
 * DEV-5: the `browser.diagnostics.*` runtime-action route owner. Until this owner existed the
 * runtime-action executor hard-returned `browser_diagnostics_route_unavailable` for the whole
 * family, so the devtools snapshot/clear leaves were dark even when the daemon store was live.
 *
 * Dispatch model (per the §14 DEV-5 plan):
 *  - `snapshot`            -> the daemon diagnostics store `getSnapshot()` through the agent/remote
 *                            egress redactor; runtime actions are not a verified local-owner viewer.
 *  - `clear`              -> the store `clearView` (the action input always carries a `viewId`, so a
 *                            clear is per-view; `clearSession` is reached via the lifecycle bridge).
 *  - pause/resume/eval/getProperties/releaseObjectGroup/elementPicker.start/cancel
 *                         -> the live sidecar interaction transport (the SAME CDP transport the
 *                            control adapter opened). Absent (no live sidecar) => honest fail-closed
 *                            `browser_diagnostics_route_unavailable`, never a fake success.
 */
export type BrowserDiagnosticsActionRouteFailure = Readonly<{
  ok: false;
  errorCode: 'invalid_parameters' | 'runtime_action_disabled';
  error: string;
}>;

/**
 * Live interactive-diagnostics transport: the eval/object-inspector/element-picker/pause-resume
 * verbs require a live CDP page surface, which only exists when the managed-Chromium sidecar is
 * running. The production implementation rides the sidecar `transport.dispatchPageCommand`; in
 * environments without a live sidecar it is simply absent and the verbs fail closed.
 */
export type BrowserDiagnosticsInteractionTransport = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<unknown>;
  releaseObjectGroupsForView?(
    input: Readonly<{ browserSessionId: string; viewId: string }>,
  ): void | Promise<void>;
  dispose(): void | Promise<void>;
}>;

export type BrowserDiagnosticsActionRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<unknown>;
}>;

const INTERACTION_ACTION_IDS = new Set<RuntimeActionIdV1>([
  'browser.diagnostics.pause',
  'browser.diagnostics.resume',
  'browser.diagnostics.eval',
  'browser.diagnostics.getProperties',
  'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start',
  'browser.diagnostics.elementPicker.cancel',
]);

const invalidParameters: BrowserDiagnosticsActionRouteFailure = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
};

function disabled(reason: string): BrowserDiagnosticsActionRouteFailure {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

function parseViewInput(
  actionId: RuntimeActionIdV1,
  input: unknown,
): { ok: true; browserSessionId: string; viewId: string } | { ok: false } {
  const parsed = getActionSpec(actionId).inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false };
  const data = parsed.data as Record<string, unknown>;
  const browserSessionId = typeof data.browserSessionId === 'string' ? data.browserSessionId : '';
  const viewId = typeof data.viewId === 'string' ? data.viewId : '';
  if (!browserSessionId || !viewId) return { ok: false };
  return { ok: true, browserSessionId, viewId };
}

export function createBrowserDiagnosticsActionRoutes(input: Readonly<{
  store: Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>;
  interaction?: BrowserDiagnosticsInteractionTransport;
}>): BrowserDiagnosticsActionRoutes {
  const { store, interaction } = input;
  return {
    async dispatch(actionId, rawInput): Promise<BrowserDiagnosticsSnapshotV1 | BrowserDiagnosticsActionRouteFailure | unknown> {
      if (actionId === 'browser.diagnostics.snapshot') {
        const parsed = parseViewInput(actionId, rawInput);
        if (!parsed.ok) return invalidParameters;
        return redactBrowserDiagnosticsSnapshotForViewer(store.getViewSnapshot({
          browserSessionId: parsed.browserSessionId,
          viewId: parsed.viewId,
        }), 'agent');
      }
      if (actionId === 'browser.diagnostics.clear') {
        const parsed = parseViewInput(actionId, rawInput);
        if (!parsed.ok) return invalidParameters;
        await interaction?.releaseObjectGroupsForView?.({
          browserSessionId: parsed.browserSessionId,
          viewId: parsed.viewId,
        });
        store.clearView({ browserSessionId: parsed.browserSessionId, viewId: parsed.viewId });
        return { ok: true } as const;
      }
      if (INTERACTION_ACTION_IDS.has(actionId)) {
        if (!interaction) return disabled('browser_diagnostics_route_unavailable');
        const parsed = getActionSpec(actionId).inputSchema.safeParse(rawInput ?? {});
        if (!parsed.success) return invalidParameters;
        return await interaction.dispatch(actionId, parsed.data);
      }
      return invalidParameters;
    },
  };
}
