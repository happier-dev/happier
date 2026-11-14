import * as React from 'react';

import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

export function formatAcpBackendCommand(command: string, args: readonly string[]): string {
    return [command, ...args].filter(Boolean).join(' ');
}

/** The custom ACP agents the Account defines, sorted for display: the Agents collection's custom rows. */
export function useAcpCatalogBackends() {
    const scope = useAccountSettingsScope();
    const { snapshot } = useAcpCatalog(scope);
    const definitions = snapshot?.data?.definitions;
    const diagnostics = snapshot?.catalog.status === 'partial' ? snapshot.catalog.diagnostics : undefined;
    const backends = React.useMemo(
        () => (definitions ?? []).slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name)),
        [definitions],
    );
    const invalidDefinitions = React.useMemo(
        () => diagnostics?.filter(diagnostic => diagnostic.reason === 'invalid_definition') ?? [],
        [diagnostics],
    );
    return { backends, invalidDefinitions, brandMarks: snapshot?.brandMarks } as const;
}
