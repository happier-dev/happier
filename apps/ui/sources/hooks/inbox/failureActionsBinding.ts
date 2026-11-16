import type { PluginUiFailureActionsBindingV1 } from '@happier-dev/protocol/plugins/contributions/ui/failureActions';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type FailureActionsBinding = PluginUiFailureActionsBindingV1 & Readonly<{ pluginId: string }>;

/** An ambiguous contribution never silently chooses one plugin's investigation flow. */
export function readFailureActionsBinding(scope: ServerAccountScope | null): FailureActionsBinding | null {
  if (!scope) return null;
  const model = readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true });
  const declarations = Object.values(model?.surfacePlacementsById ?? {}).filter(view => view.failureActions !== undefined);
  if (declarations.length !== 1) return null;
  const view = declarations[0];
  return { pluginId: view.pluginId, ...view.failureActions! };
}
