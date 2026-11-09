import * as React from 'react';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useRegistrySuggestions } from '@/registries/useRegistrySuggestions';
import { capabilityDismissalState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';

import { buildMcpServerCollection, type McpServerCollectionRow } from '../collection/mcpServerCollectionModel';
import { useMcpSignInViewOf } from '../signIn/useMcpSignInViewOf';
import { useMcpServersSettings } from '../useMcpServersSettings';
import { useMcpServerMachineFacts } from '../status/useMcpServerMachineFacts';
import { buildMcpHome, type McpHome } from './mcpHomeModel';

/**
 * The homepage's data: the Account's servers, their sign-in grants and saved keys, the registry's
 * suggestions (P4's one rule) and this device's first-visit dismissal, folded by `buildMcpHome`.
 */
export function useMcpHome() {
  const { settings, snapshot, scope, reload } = useMcpServersSettings();
  const previousRows = React.useRef<readonly McpServerCollectionRow[]>([]);
  const rows = React.useMemo(
    () => buildMcpServerCollection(settings, '', previousRows.current, snapshot.brandMarks),
    [settings, snapshot.brandMarks],
  );
  React.useEffect(() => { previousRows.current = rows; }, [rows]);
  const signInOf = useMcpSignInViewOf(settings, scope);
  const { machines } = useReachMachines();
  const machineFactsOf = useMcpServerMachineFacts(machines);
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  const { resolveReference } = savedSecretCatalog;
  const secretAvailability = React.useMemo(() => ({ resolveReference }), [resolveReference]);
  const shelf = useRegistrySuggestions('mcpServer');
  const dismissedAt = usePersistentUiStateValue(capabilityDismissalState, 'mcpFirstVisitDismissedAt') ?? null;
  const suggestions = React.useMemo(
    () =>
      shelf.items.map((item) => ({
        key: `suggestion:${item.sourceId}:${item.itemId}`,
        iconUrl: item.iconUrl ?? null,
        brandMark: item.brandMark,
        title: item.title,
      })),
    [shelf.items],
  );
  const previousModel = React.useRef<McpHome | undefined>(undefined);
  const model = React.useMemo(
    () =>
      buildMcpHome({
        rows,
        signInOf,
        savedSecretCatalog: secretAvailability,
        firstVisitDismissed: dismissedAt !== null,
        suggestions,
        machineFactsOf,
        previous: previousModel.current,
      }),
    [dismissedAt, machineFactsOf, rows, secretAvailability, signInOf, suggestions],
  );
  React.useEffect(() => { previousModel.current = model; }, [model]);
  const dismissFirstVisit = React.useCallback(
    () => capabilityDismissalState.set('mcpFirstVisitDismissedAt', Date.now()),
    [],
  );
  const loading = snapshot.status === 'loading' && settings.servers.length === 0;
  // A partial read that shows nothing is not "no servers yet": it says it couldn't load, with a retry.
  const unavailable =
    (snapshot.status === 'unavailable' || snapshot.status === 'partial') &&
    settings.servers.length === 0;
  return {
    model,
    suggestions,
    shelf,
    loading,
    unavailable,
    reload,
    dismissFirstVisit,
  };
}
