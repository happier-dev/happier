import * as React from 'react';

import { useAgentAdministrationCatalog, type AgentAdministrationCatalog } from './useAgentAdministrationCatalog';

const AgentAdministrationCatalogContext = React.createContext<AgentAdministrationCatalog | null>(null);

function AgentAdministrationCatalogOwner(props: Readonly<{ children: React.ReactNode }>) {
    const catalog = useAgentAdministrationCatalog();
    return <AgentAdministrationCatalogContext.Provider value={catalog}>{props.children}</AgentAdministrationCatalogContext.Provider>;
}

/**
 * The Agents collection's one catalog build. The rail and the index page both read the catalog the
 * machine store feeds, so the nearest boundary builds it once and every Agents surface below shares it.
 * A surface rendered alone becomes its own boundary.
 */
export function AgentAdministrationCatalogBoundary(props: Readonly<{ children: React.ReactNode }>) {
    return React.useContext(AgentAdministrationCatalogContext) !== null
        ? <>{props.children}</>
        : <AgentAdministrationCatalogOwner>{props.children}</AgentAdministrationCatalogOwner>;
}

/** The shared catalog; only valid below an `AgentAdministrationCatalogBoundary`. */
export function useBoundaryAgentAdministrationCatalog(): AgentAdministrationCatalog {
    const catalog = React.useContext(AgentAdministrationCatalogContext);
    if (catalog === null) throw new Error('useBoundaryAgentAdministrationCatalog requires an AgentAdministrationCatalogBoundary');
    return catalog;
}
