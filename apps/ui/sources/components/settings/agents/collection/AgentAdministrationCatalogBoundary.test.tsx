import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { AgentAdministrationCatalog } from './useAgentAdministrationCatalog';

installUiListsCommonModuleMocks();
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { AgentAdministrationCatalogBoundary, useBoundaryAgentAdministrationCatalog } = await import('./AgentAdministrationCatalogBoundary');

afterEach(standardCleanup);

describe('AgentAdministrationCatalogBoundary', () => {
    it('builds one catalog for the rail and the index, and keeps it through an unrelated store write', async () => {
        await loadSyncSingletonForTests();
        const seen = { rail: [] as AgentAdministrationCatalog[], index: [] as AgentAdministrationCatalog[] };
        const Probe = React.memo(function Probe(props: Readonly<{ into: AgentAdministrationCatalog[] }>) {
            props.into.push(useBoundaryAgentAdministrationCatalog());
            return null;
        });
        await renderScreen(
            <AgentAdministrationCatalogBoundary>
                <AgentAdministrationCatalogBoundary><Probe into={seen.rail} /></AgentAdministrationCatalogBoundary>
                <Probe into={seen.index} />
            </AgentAdministrationCatalogBoundary>,
        );
        expect(seen.rail.at(-1)).toBeDefined();
        expect(seen.index.at(-1)).toBe(seen.rail.at(-1));
        const rendersBefore = seen.rail.length + seen.index.length;
        await act(async () => { storage.setState({ lastSyncAt: Date.now() + 1 } as never); });
        expect(seen.rail.length + seen.index.length).toBe(rendersBefore);
    });

    it('lets a surface rendered alone own its catalog', async () => {
        await loadSyncSingletonForTests();
        const probe = vi.fn();
        const Probe = () => { probe(useBoundaryAgentAdministrationCatalog()); return null; };
        await renderScreen(<AgentAdministrationCatalogBoundary><Probe /></AgentAdministrationCatalogBoundary>);
        expect(probe).toHaveBeenCalled();
    });
});
