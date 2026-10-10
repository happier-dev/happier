import * as React from 'react';
import type { JsonValue, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { TriageEvidenceDisclosureProvider, type TriageEvidenceDisclosureV1 } from '@happier-dev/triage-sources/ui';
import { createTriageMountedUiActionHandler, createTriageMountedSourceRevealActionHandler, createTriageMountedSourceInsertActionHandler } from '../actions/mountedUi.js';
import { bindTriageMountedUiActions } from './mountedActions.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { TriageMountedUiInputV1Schema, TriageMountedSourceInsertInputV1Schema, TriageMountedSourceRevealInputV1Schema } from '../actions/mountedUiProtocol.js';
import { PluginActionConfirmationV2Schema } from '@happier-dev/protocol';

/** Source tests mount the real parent dispatcher; only the host Action/approval transport is a boundary fixture. */
export function SourcePanelActionsFixture(props: Readonly<{
  scope: PluginEphemeralSharedScope; disclosure?: TriageEvidenceDisclosureV1; children: React.ReactNode;
}>) {
  const hostApi = usePluginHostApi();
  const panel = useTriageSourcePanelActionsV1(props.scope, 'source-test', 'issue', true, hostApi);
  React.useLayoutEffect(() => bindTriageMountedUiActions(props.scope, 'source-test', async () => ({ status: 'unavailable' })), [props.scope]);
  const disclosure = React.useMemo<TriageEvidenceDisclosureV1>(() => ({
    available: props.disclosure?.available ?? false,
    disclose: props.disclosure?.disclose ?? (async () => ({ kind: 'inert' })),
    panelActions: panel.actions,
  }), [panel.actions, props.disclosure]);
  return <TriageEvidenceDisclosureProvider disclosure={disclosure}>{props.children}</TriageEvidenceDisclosureProvider>;
}

export async function invokeSourcePanelFixtureAction(scope: PluginEphemeralSharedScope, localId: string,
  input: JsonValue, context: RenderContext, signal: AbortSignal,
  confirm?: (input: Readonly<{ message: string; title?: string }>) => boolean | Promise<boolean>) {
  const action = PLUGIN_MANIFEST.contributes.actions?.find((candidate) => candidate.id === localId);
  const confirmation = PluginActionConfirmationV2Schema.safeParse(action?.confirmation);
  if (action?.confirmation !== undefined && !confirmation.success) throw new Error('Invalid Action confirmation fixture');
  if (confirmation.success && confirm !== undefined) {
    const { title, body } = confirmation.data;
    const message = body === undefined ? '' : typeof body === 'string' ? body : body.fallback;
    const heading = title === undefined ? undefined : typeof title === 'string' ? title : title.fallback;
    if (!await confirm({ ...(heading === undefined ? {} : { title: heading }), message })) return { status: 'rejected' as const };
  }
  // The client Action host projects absent occurrence authority as null, rather
  // than exposing the full mounted SurfaceContext through this bounded API.
  const ui = { ...context.hostApi, context: async (options?: Parameters<typeof context.hostApi.context>[0]) => ({
    targetedContributions: (await context.hostApi.context(options)).targetedContributions ?? null,
  }) };
  const invocation = { plugin: { id: 'happier.triage', version: '0.0.0' },
    contribution: { id: localId, qualifiedId: `happier.triage/actions/${localId}` },
    invocationSurface: 'ui' as const, signal, ui, ephemeralSharedScope: scope };
  if (localId === 'ui/reveal-source-user-v1') return await createTriageMountedSourceRevealActionHandler()(TriageMountedSourceRevealInputV1Schema.parse(input), invocation);
  if (localId === 'ui/insert-selected-evidence-v1') return await createTriageMountedSourceInsertActionHandler()(TriageMountedSourceInsertInputV1Schema.parse(input), invocation);
  return await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(input), invocation);
}
