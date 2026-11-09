import * as React from 'react';
import { normalizePluginUiSubPathV1 } from '@happier-dev/protocol/plugins/ui';
import { hrefForDestinationRef, useCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceDestinationRow } from './WorkspaceDestinationRow';

type DestinationRowInput = import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost').PluginDestinationRowInput;

function renderDestinationRowWithHref(href: string | null, input: DestinationRowInput): React.ReactNode {
    if (!href) return input.children;
    if (!input.renderWithSecondaryActions) return <WorkspaceDestinationRow href={href}>{input.children}</WorkspaceDestinationRow>;
    const renderWithSecondaryActions = input.renderWithSecondaryActions;
    return <WorkspaceDestinationRow href={href} existingMenu>{actions => renderWithSecondaryActions({
        secondaryActions: actions.items.map(item => ({ id: item.id, label: item.title, disabled: item.disabled })),
        onSecondaryAction: id => { actions.select(id); },
    })}</WorkspaceDestinationRow>;
}

/** Core supplies its canonical route directly and needs no plugin-page catalog subscription. */
export function renderCoreDestinationRow(input: DestinationRowInput): React.ReactNode {
    return renderDestinationRowWithHref('href' in input ? input.href : null, input);
}

/** Public destinations reach the same catalog and workspace owner as shell rows. */
export function usePluginDestinationRowRenderer() {
    const catalog = useCompactAppDestinations();
    const pages = React.useMemo(() => new Map(catalog.flatMap(page => page.kind === 'plugin'
        && page.container === 'appPage' && page.availability === 'available' && page.activation === 'navigate'
        ? [[JSON.stringify([page.destination.pluginId, page.destination.localId]), page] as const] : [])), [catalog]);
    return React.useCallback((input: DestinationRowInput) => {
        let href: string | null;
        if ('href' in input) href = input.href;
        else {
            // A mounted plugin qualifies its local id before reaching this shared host renderer.
            if (typeof input.destination === 'string') return input.children;
            const page = pages.get(JSON.stringify([input.destination.pluginId, input.destination.localId]));
            const subPath = normalizePluginUiSubPathV1(input.subPath ?? '');
            href = page && subPath !== null ? hrefForDestinationRef(catalog, { kind: page.id, params: {
                ...page.destination, ...(subPath ? { subPath } : {}),
            } }) : null;
        }
        return renderDestinationRowWithHref(href, input);
    }, [catalog, pages]);
}
