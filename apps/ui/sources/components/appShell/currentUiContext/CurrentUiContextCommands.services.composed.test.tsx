import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildLocalServiceInventoryState, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Dimensions } from 'react-native';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DetectedLocalServicesPane } = await import('@/components/sessions/localServices/DetectedLocalServicesPane');
const { ServiceOutputDisclosure } = await import('@/components/sessions/localServices/ServiceOutputDisclosure');
const { useNativeLogViewer } = await import('@/components/machines/services/useMachineServiceLogViewer');
const { createNativeLogView } = await import('@/components/machines/services/MachineServiceLogs');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Services navigation', serverUrl: 'https://services-navigation.test',
        serverIdentityId: 'srv_services_navigation', accountId: 'account', currentAccount: true, active: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl('https://services-navigation.test', { serverId }))!);
});
afterEach(async () => { standardCleanup(); vi.restoreAllMocks(); await homes.reset(); });

async function readCommands() {
    const executor = createDefaultActionExecutor();
    const context = { serverId, surface: 'agent' as const, authority: 'account_automation' as const };
    const read = await executor.execute('ui.current_context.read', {}, context);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Current UI unavailable');
    return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
}

async function invoke(title: string, input?: { before: number; after: number }) {
    const executor = createDefaultActionExecutor();
    const context = { serverId, surface: 'agent' as const, authority: 'account_automation' as const };
    const commands = await readCommands();
    const command = commands.find(candidate => candidate.title === title);
    expect(command, title).toBeDefined();
    await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id, ...(input ? { input } : {}) }, context))
            .toMatchObject({ ok: true });
    });
}

it.each([1200, 390])('changes Services scope, opens and closes the selected detail, and navigates Add service through mounted Agent commands at width %s', async width => {
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
    const inventoryState = buildLocalServiceInventoryState({ rows: [] });
    const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), { v: 1,
        machineId: 'machine', updatedAt: 1, targets: [{ id: 'worker', source: 'managed_service', machineId: 'machine',
            title: 'Worker', cwd: '/repo', confidence: 'high', state: 'available', actions: ['start'] }] });
    const add = vi.fn();
    function Pane({ empty = false }: { empty?: boolean }) {
        const [scope, setScope] = React.useState<'workspace' | 'machine'>('workspace');
        return <DetectedLocalServicesPane inventoryState={inventoryState} launcherState={empty
            ? applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), { v: 1, machineId: 'machine', updatedAt: 1, targets: [] })
            : launcherState} scope={scope} onChangeScope={setScope} onAddService={add} publicPreviewState={null}
            renderServicePlacement={() => <Text testID="service-placement">Runs here</Text>}
            machine={{ name: 'Development machine', homeDir: null, reachability: 'reachable' }} testID="services-nav" />;
    }
    const screen = await renderMountedCurrentUiContext(<Pane />);
    await invoke(t('localServices.scope.machine'));
    expect(screen.findByTestId('services-nav-scope-toggle:machine')!.props.accessibilityState?.selected).toBe(true);
    await invoke('Worker');
    expect(screen.findAllByTestId('service-placement').length).toBeGreaterThan(0);
    if (width === 390) {
        expect(screen.findAllByTestId('services-nav-detail').length).toBeGreaterThan(0);
        expect((await readCommands()).some(command => command.title === 'Worker')).toBe(false);
    }
    await invoke(t('localServices.pane.backToServices'));
    if (width === 390) {
        expect(screen.findAllByTestId('service-placement')).toHaveLength(0);
    } else {
        expect(screen.findAllByType(ExpandableItem).every(row => row.props.expanded === false)).toBe(true);
    }
    await screen.update(<Pane empty />);
    await invoke(t('localServices.pane.addService'));
    expect(add).toHaveBeenCalledOnce();
});

it('discloses sanitized failure output through its mounted command and closes it on the next invocation', async () => {
    const screen = await renderMountedCurrentUiContext(<ServiceOutputDisclosure testID="failed-service"
        output={{ kind: 'reviewOutput', label: t('localServices.row.reviewOutput'), lines: ['Sanitized start failure'] }} />);
    expect(screen.findAllByTestId('failed-service-output-lines')).toHaveLength(0);
    await invoke(t('localServices.row.reviewOutput'));
    expect(screen.getTextContent()).toContain('Sanitized start failure');
    await invoke(t('localServices.row.reviewOutput'));
    expect(screen.findAllByTestId('failed-service-output-lines')).toHaveLength(0);
});

it('pauses and follows logs, reveals selected Find context, and jumps to the latest loaded line through mounted commands', async () => {
    const view = createNativeLogView();
    const read = async () => {};
    const containsFocus = () => true;
    const isInputFocused = () => false;
    const first = { kind: 'read' as const, readAt: 1, value: { kind: 'page' as const,
        page: { sourceRevision: 'source', text: 'before\nneedle\nafter\nlatest', nextCursor: null, truncated: false } } };
    let logs: ReturnType<typeof useNativeLogViewer>;
    function Logs() {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        logs = useNativeLogViewer({ first, read, accountLifetime: binding, reference: null, sourceKey: 'source',
            active: true, fileName: 'worker.log', view, surfaceId: 'services-nav-log', containsFocus, isInputFocused });
        return null;
    }
    await renderMountedCurrentUiContext(<Logs />);
    await flushHookEffects();
    await invoke(t('machineServices.logs.stopFollowing'));
    expect(logs!.follow).toBe(false);
    await invoke(t('machineServices.logs.follow'));
    expect(logs!.follow).toBe(true);
    await act(async () => logs!.viewer!.find.open());
    await act(async () => logs!.viewer!.find.setQuery('needle'));
    const contextCommand = (await readCommands()).find(command => command.title === t('common.details'));
    expect(contextCommand?.description).toBeTruthy();
    // Discover the invocation operands from the public descriptor, as the caller must.
    const contextInput: { before: number; after: number } = JSON.parse(contextCommand!.description!.match(/\{[^{}]+\}/)![0]);
    await invoke(t('common.details'), contextInput);
    expect(logs!.viewer!.lines.map(line => line.plainText)).toEqual(['before', 'needle', 'after']);
    await invoke(t('settingsSession.transcript.jumpToBottomButtonLabel'));
    expect(logs!.viewer!.viewState?.revealedLine).toBe(4);
    expect(logs!.viewer!.lines).toHaveLength(4);
});
