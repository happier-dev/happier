import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

// Only native/platform presentation boundaries are replaced; the mounted
// caller, Account scope, catalog subscription and catalog resolver stay real.
installNewSessionComponentsCommonModuleMocks();

const initialState = getStorage().getState();
const scope = { serverId: 'profile-compatibility-home', accountId: 'profile-compatibility-account' };

afterEach(() => {
    standardCleanup();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    getStorage().setState(initialState, true);
});

describe('Profile compatibility catalog availability', () => {
    it('keeps built-in compatibility visible while the configured ACP catalog changes availability', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        getStorage().setState({ settingsScope: null });
        const screen = await renderScreen(<ProfileCompatibilityIcon profile={{
            isBuiltIn: true, compatibility: { codex: true }, compatibilityByTargetKey: {},
        }} />);
        expect(screen.findAllByType(AgentIcon).map(node => node.props.agentId)).toEqual(['codex']);

        await act(async () => {
            applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
            getStorage().setState({ settingsScope: scope });
        });
        expect(screen.findAllByType(AgentIcon).map(node => node.props.agentId)).toEqual(['codex']);

        await act(async () => {
            applyAcpCatalogSnapshot(scope, { status: 'loading' }, true);
        });
        expect(screen.findAllByType(AgentIcon).map(node => node.props.agentId)).toEqual(['codex']);

        await act(async () => {
            applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        });
        expect(screen.findAllByType(AgentIcon).map(node => node.props.agentId)).toEqual(['codex']);

        await act(async () => {
            applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true);
        });
        expect(screen.findAllByType(AgentIcon).map(node => node.props.agentId)).toEqual(['codex']);
        await screen.unmount();
    });
});
