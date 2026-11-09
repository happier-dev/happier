import * as React from 'react';

import { ConnectedAccountConfigurationForm } from '@/components/settings/connectedServices/account/ConnectedAccountConfigurationForm';
import { ConnectedAccountManualForm } from '@/components/settings/connectedServices/account/ConnectedAccountManualForm';
import { ConnectedAccountSetupStepCue } from '@/components/settings/connectedServices/account/ConnectedAccountSetupStepCue';
import { ConnectedServiceSetupFlowBody } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupFlowBody';
import {
    ConnectedServiceSetupPanel,
    type ConnectedServiceSetupCatalogEntry,
} from '@/components/settings/connectedServices/setup/ConnectedServiceSetupPanel';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';

import { CLAUDE as CLAUDE_SERVICE, GITHUB as GITHUB_SERVICE, entry as registryEntry, type Svc } from './connectedServicesFixtures';

const noop = () => {};
const VERCEL: Svc = { pluginId: 'happier.machine.vercel', localId: 'vercel-account' };
const fixtureTarget = { serverIdentityId: 'fixture-home', machineId: 'fixture-macbook' };
const fixtureMachine = { target: fixtureTarget, displayName: 'MacBook Pro', serverLabel: 'Personal Home', availability: 'online' as const,
    observation: 'live' as const, observedAt: Date.now() };
const SELECTION: MachineAdministrationTargetSelectionV1 = {
    candidates: [fixtureMachine], pickerRows: [], selectedTarget: fixtureTarget,
    state: { kind: 'online', target: fixtureTarget, machine: fixtureMachine },
    selectedTargetServerMatchesActiveAccount: false, canExecute: false,
    selectTarget: noop, clearTarget: noop, resolveExecutionTarget: () => null,
};
const REGISTRY: ConnectedServiceRegistrySnapshot = {
    scopeKey: 'fixture', status: 'ready', errorReason: null,
    entries: [registryEntry(VERCEL, null, 'Vercel', [{ id: 'token', kind: 'manual' }])],
};
const CATALOG_ENTRY: ConnectedServiceSetupCatalogEntry = {
    serviceKey: `${VERCEL.pluginId}/${VERCEL.localId}`, service: VERCEL, entry: REGISTRY.entries[0]!, legacyServiceId: null,
    label: 'Vercel', usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'tools', canAdd: true,
};
const SETTINGS_FIELDS = [
    { id: 'teamId', title: 'Team ID', secret: false, required: true, schema: { type: 'string', minLength: 1 }, presentation: { order: 1, placeholder: 'team_…' } },
    { id: 'projectId', title: 'Project ID', secret: false, required: true, schema: { type: 'string', minLength: 1 }, presentation: { order: 2, placeholder: 'prj_…' } },
] as const;
const TOKEN_FIELDS = [{ id: 'token', title: 'Access token', secret: true, schema: { type: 'string', minLength: 1 } }] as const;

type Stage = 'settings' | 'signIn' | 'oneStep';

/** The flow as the controller renders it: the shared step cue (only on a flow with a settings step), then the step's real form. */
function FixtureFlow(props: Readonly<{ stage: Stage }>) {
    return (
        <ConnectedServiceSetupFlowBody
            state="ready"
            flow={(
                <>
                    {props.stage === 'oneStep' ? null : <ConnectedAccountSetupStepCue step={props.stage} signInLabel="Access token" />}
                    {props.stage === 'settings' ? (
                        <ConnectedAccountConfigurationForm
                            embedded
                            title="Vercel"
                            fields={SETTINGS_FIELDS as never}
                            values={{}}
                            configuredSecretFieldIds={[]}
                            saving={false}
                            onSubmit={noop}
                        />
                    ) : (
                        <ConnectedAccountManualForm
                            embedded
                            title="Vercel"
                            fields={TOKEN_FIELDS as never}
                            submitting={false}
                            onCancel={noop}
                            onSubmit={noop}
                        />
                    )}
                </>
            )}
        />
    );
}

/**
 * The managed-machine purpose setup frame: its one header, then the sign-in. A brand-new account has nothing to choose from, so
 * the page carries no chooser. The page's hooks need a machine's descriptors, so the frame composes the
 * real panel and forms at the flow's states: settings step, sign-in step, and a one-step service (no cue).
 */
function AddAccountFrame(props: Readonly<{ stage: Stage }>) {
    return (
        <ItemList pageColumn="wide">
            <ConnectedServiceSetupPanel
                chrome="page"
                target={{ kind: 'service', serviceKey: CATALOG_ENTRY.serviceKey }}
                catalog={[CATALOG_ENTRY]}
                registry={REGISTRY}
                targetSelection={SELECTION}
                targetLocked
                onTargetChange={noop}
                onClose={noop}
                renderServiceFlow={() => <FixtureFlow stage={props.stage} />}
            />
        </ItemList>
    );
}

const CLAUDE_ENTRY: ConnectedServiceSetupCatalogEntry = {
    serviceKey: `${CLAUDE_SERVICE.pluginId}/${CLAUDE_SERVICE.localId}`, service: CLAUDE_SERVICE,
    entry: registryEntry(CLAUDE_SERVICE, 'claude-subscription', 'Claude', [{ id: 'oauth', kind: 'oauthAuthorizationCode' }]),
    legacyServiceId: 'claude-subscription', label: 'Claude', usedBy: ['Claude', 'OpenCode'], usedByAgentIds: ['claude', 'opencode'],
    connectedCount: 2, section: 'agents', canAdd: true,
};
const GITHUB_ENTRY: ConnectedServiceSetupCatalogEntry = {
    serviceKey: `${GITHUB_SERVICE.pluginId}/${GITHUB_SERVICE.localId}`, service: GITHUB_SERVICE,
    entry: registryEntry(GITHUB_SERVICE, 'github', 'GitHub', [{ id: 'fine-grained-pat', kind: 'manual' }]),
    legacyServiceId: 'github', label: 'GitHub', usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'tools', canAdd: true,
};
const CLOUD_ENTRY: ConnectedServiceSetupCatalogEntry = { ...CATALOG_ENTRY, category: 'cloud-machines' };

/**
 * The Connect catalog frame. CS1: the managed-machine Connect for a
 * cloud service alone: no "Signed in on a machine?" tile (no agent uses it), no chooser (nothing to choose), its one
 * group shown bare. CS2: the whole catalog: Agent sign-in blocks with the agent's own login, then the other groups.
 */
function ConnectServiceFrame(props: Readonly<{ catalog: readonly ConnectedServiceSetupCatalogEntry[] }>) {
    return (
        <ItemList pageColumn="wide">
            <ConnectedServiceSetupPanel
                chrome="page"
                target={{ kind: 'catalog' }}
                catalog={props.catalog}
                registry={REGISTRY}
                targetSelection={SELECTION}
                targetLocked
                onTargetChange={noop}
                onClose={noop}
                renderServiceFlow={() => null}
            />
        </ItemList>
    );
}

/** AA1 settings step, AA2 sign-in step, AA3 a one-step service, CS1/CS2 the Connect a service page. Null for a frame this slice does not own. */
export function renderAddAccountFrame(frame: string): React.ReactNode | null {
    const id = frame.endsWith('p') && ['AA1', 'AA2', 'AA3', 'CS1', 'CS2'].includes(frame.slice(0, -1)) ? frame.slice(0, -1) : frame;
    switch (id) {
        case 'AA1': return <AddAccountFrame stage="settings" />;
        case 'AA2': return <AddAccountFrame stage="signIn" />;
        case 'AA3': return <AddAccountFrame stage="oneStep" />;
        case 'CS1': return <ConnectServiceFrame catalog={[CLOUD_ENTRY]} />;
        case 'CS2': return <ConnectServiceFrame catalog={[CLAUDE_ENTRY, CLOUD_ENTRY, GITHUB_ENTRY]} />;
        default: return null;
    }
}
