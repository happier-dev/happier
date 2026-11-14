import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDraftAcpBackend } from '@/components/settings/acpCatalog/createDraftAcpBackend';
import { applyAcpCatalogSnapshot, getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';

installUiListsCommonModuleMocks();
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { AgentCollectionList } = await import('./AgentCollectionList');
const { useAgentAdministrationCatalog } = await import('./useAgentAdministrationCatalog');

const scope = { serverId: 'partial-agents-home', accountId: 'partial-agents-account' };
let previousState = storage.getState();
beforeEach(async () => {
    await loadSyncSingletonForTests();
    previousState = storage.getState();
    storage.setState({ settingsScope: scope });
    const draft = createDraftAcpBackend();
    // The HTTP boundary carries JSON, not the editor draft's optional undefined fields.
    const opened = openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: JSON.parse(JSON.stringify({
        v: 1, definitions: [
            { ...draft, id: 'working', name: 'working', title: 'Working agent', launch: { kind: 'command', command: 'agent', args: [] } },
            { id: 'broken', name: 'broken', title: 'Broken agent', launch: { command: 42 } },
        ],
    })) } });
    if (opened.status !== 'partial') throw new Error('Expected the real decoder to isolate the malformed sibling');
    applyAcpCatalogSnapshot(scope, { ...opened, revision: 1 }, true);
});
afterEach(() => {
    standardCleanup();
    resetAcpCatalogSnapshotsForTests();
    storage.setState(previousState, true);
});

describe('Agents collection partial inventory', () => {
    it.each(['rail', 'page'] as const)('renders the valid and typed invalid sibling in the %s', async (variant) => {
        const loaded = getAcpCatalogSnapshot(scope)!;
        function Collection() {
            const catalog = useAgentAdministrationCatalog({ loadProjection: false });
            return <AgentCollectionList catalog={catalog} variant={variant} />;
        }
        const screen = await renderScreen(<Collection />);
        // Mounting observes the catalog and starts a read; settle that read at the snapshot ingress.
        await act(async () => { applyAcpCatalogSnapshot(scope, loaded.catalog, true); });
        expect(screen.findHostByTestId('settings-agents-collection.custom.working')).not.toBeNull();
        const invalid = screen.findHostByTestId('settings-agents-collection.invalid.definitions[1]');
        expect(invalid).not.toBeNull();
        const visible = invalid!.findAll(node => typeof node.type === 'string').flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
        expect(visible).toContain('Broken agent');
        expect(visible).toContain('settingsAgents.collection.invalidConfiguration');
        expect(visible).toContain('invalid_definition');
        expect(visible).toContain('definitions[1]');
        expect(screen.findByTestId('settings-agents-collection.custom.broken')).toBeNull();
        expect(invalid!.props.onPress ?? invalid!.props.onClick).toBeUndefined();
    });
});
