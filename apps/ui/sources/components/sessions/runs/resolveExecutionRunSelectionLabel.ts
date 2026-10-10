import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';

import { t } from '@/text';

const PROVENANCE_KEY = {
  inherited: 'runPage.menu.selectionInherited',
  explicit: 'runPage.menu.selectionExplicit',
  independent: 'runPage.menu.selectionIndependent',
  retained: 'runPage.menu.selectionRetained',
} as const satisfies Record<ExecutionRunResolvedSelection['source'], string>;

/**
 * Where a Run's model came from and what it runs through, from the host's resolved launch record
 * (plan R2/D9): "Inherit session · DeepSeek · deepseek-v4", "Chosen for this run · …". The route is
 * named only when the Run uses a Provider connection the Account still knows; nothing is guessed.
 */
export function resolveExecutionRunSelectionLabel(
  selection: ExecutionRunResolvedSelection | undefined,
  connectionLabel: (connectionId: string) => string | null,
): string | null {
  if (!selection) return null;
  const connectionId = selection.modelSelection?.providerConnectionId ?? null;
  const model =
    selection.modelSelection?.modelId ??
    selection.teamCredentialModel?.modelId ??
    selection.modelId ??
    null;
  return [
    t(PROVENANCE_KEY[selection.source]),
    connectionId ? connectionLabel(connectionId) : null,
    model,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
