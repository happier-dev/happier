import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import type { DetectedMcpServerV1 } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { DaemonMcpServersDetectResponse } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { mcpServerImportIdentityV1 } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { FoundMachineGroup, FoundQuietMachines, type FoundMachineGroupCopy, type FoundQuietLine } from '@/components/capabilities/found/FoundMachineGroup';
import { foldQuietFoundMachines, partitionFoundMachines, resolveFoundMachineBody } from '@/components/capabilities/found/foundMachineModel';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { FoundMachineScanOf } from '@/sync/domains/capabilities/found/useFoundMachineScans';
import { useReachMachines, type ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { mcpServerRoute } from './collection/mcpServerCollectionModel';
import { McpFoundAdoptionPanel } from './found/McpFoundAdoptionPanel';
import { useFoundMcpServers } from './found/useFoundMcpServers';
import { useMcpFoundAdoption } from './found/useMcpFoundAdoption';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { formatDetectedWarning, resolveDetectedProviderName, resolveTransportLabel } from './mcpServerUi';
import { useMcpServerCatalogForServer, useMcpServersSettings } from './useMcpServersSettings';

type McpFoundScan = FoundMachineScanOf<DaemonMcpServersDetectResponse>;
type Execution = ReturnType<typeof useFoundMcpServers>['execution'];

/**
 * `/settings/mcp/found` (P7 §T6/§T9): the MCP servers each machine's agents already have set up, one section
 * per machine of the Account and, inside it, grouped by Agent. Opening the page reads every machine REACH
 * knows to be reachable, once; "Check again" is the user asking, so it reads every machine. An offline machine
 * keeps its last known servers with Add off; a machine whose read fails says so in its own section. Add runs
 * the canonical adopt continuation, which asks for every value the config names.
 */
export const McpDetectedServersScreen = React.memo(function McpDetectedServersScreen() {
    const router = useRouter();
    const { approval: importApproval, scope: catalogScope } = useMcpServersSettings();
    const { machines } = useReachMachines();
    const ordered = React.useMemo(() => [...machines].sort((a, b) => Number(a.online !== true) - Number(b.online !== true)), [machines]);
    const machineIds = React.useMemo(() => ordered.map((machine) => machine.machineId), [ordered]);
    const found = useFoundMcpServers(machineIds);
    const { scan, execution } = found;
    const serverId = found.scope?.serverId ?? null;

    // Only a machine REACH knows to be reachable is read on open: one whose presence is unknown is not asked yet.
    const presence = useMachinePresenceSummaries(serverId, machineIds);
    const reachableIds = React.useMemo(
        () => machineIds.filter((_, index) => presence[index]?.reachability === 'reachable'),
        [machineIds, presence],
    );
    const scanned = React.useRef(new Set<string>());
    React.useEffect(() => {
        if (!execution.ready) return;
        for (const machineId of reachableIds) {
            if (scanned.current.has(machineId)) continue;
            scanned.current.add(machineId);
            fireAndForget(scan(machineId), { tag: 'McpFound.scan' });
        }
    }, [execution.ready, reachableIds, scan]);
    // An explicit request reaches every machine, reachable now or not; its own outcome answers.
    const checkAgain = React.useCallback(() => {
        for (const machineId of machineIds) fireAndForget(scan(machineId), { tag: 'McpFound.checkAgain' });
    }, [machineIds, scan]);

    const snapshot = useMcpServerCatalogForServer(serverId ?? undefined);
    const catalogRevision = snapshot.status === 'ready' && snapshot.authority === 'active' && !snapshot.stale
        && typeof snapshot.revision === 'number' ? snapshot.revision : null;
    const catalog = snapshot.value ?? null;
    const inHappierByIdentity = React.useMemo(
        () => new Map((catalog?.servers ?? []).map((server) => [mcpServerImportIdentityV1(server), server.id])),
        [catalog],
    );
    const savedSecretCatalog = useSavedSecretCatalog({ scope: execution.binding?.scope ?? null });
    const secrets = React.useMemo(() => [...savedSecretCatalog.materializedSecrets], [savedSecretCatalog.materializedSecrets]);
    const adoptionExecution = React.useMemo(() => ({ execute: execution.execute, ready: execution.ready, isCurrent: execution.isCurrent }),
        [execution.execute, execution.ready, execution.isCurrent]);
    const scopeKey = JSON.stringify([execution.binding?.scope]);

    const open = React.useCallback((id: string, replace: boolean) => {
        const result = runGuardedNavigation(() => replace ? router.replace(mcpServerRoute(id) as never) : router.push(mcpServerRoute(id) as never));
        if (result !== true) fireAndForget(result, { tag: 'McpDetectedServersScreen.open' });
    }, [router]);

    const scanOf = React.useCallback((machine: ReachMachine): McpFoundScan =>
        found.scans.find((entry) => entry.machineId === machine.machineId)
            ?? { machineId: machine.machineId, result: null, scanning: false, failure: null, cause: null }, [found.scans]);
    const { sections, quietLines } = React.useMemo(() => {
        const known = partitionFoundMachines(ordered, (machine) => scanOf(machine).result !== null);
        // Machines being read or with nothing found have no section of their own (as on the Skills page); a
        // machine with a warning keeps its section, since the warning is its own news.
        const quiet = foldQuietFoundMachines(known.sections, (machine) => {
            const scan = scanOf(machine);
            const result = scan.result?.ok ? scan.result : null;
            if (result?.warnings?.length) return null;
            const body = resolveFoundMachineBody({ failure: scan.failure, items: result?.servers ?? null });
            return body.kind === 'empty' ? 'empty' : body.kind === 'looking' ? 'looking' : null;
        });
        const lines: FoundQuietLine[] = [
            ...(quiet.looking > 0 ? [{ id: 'looking', kind: 'loading' as const,
                title: t('capabilities.mcpFound.quietLooking', { count: quiet.looking }) }] : []),
            ...(quiet.empty > 0 ? [{ id: 'empty', kind: 'empty' as const,
                title: t('capabilities.mcpFound.quietEmpty', { count: quiet.empty, others: quiet.sections.length > 0 }) }] : []),
            ...(known.unseenOffline > 0 ? [{ id: 'unseenOffline', kind: 'unavailable' as const,
                title: t('capabilities.mcpFound.offlineUnseen', { count: known.unseenOffline }) }] : []),
        ];
        return { sections: quiet.sections, quietLines: lines };
    }, [ordered, scanOf]);
    const checking = found.scans.some((entry) => entry.scanning);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="mcp.found.header"
                title={t('capabilities.mcp.foundOnMachines')}
                alwaysShowTitle
                description={t('capabilities.mcpFound.purpose')}
                actions={machineIds.length > 0 ? (
                    <SectionActionButton
                        testID="mcp.found.checkAgain"
                        title={t('capabilities.mcpFound.checkAgain')}
                        icon="arrow-clockwise"
                        // Busy keeps the label and takes no presses; disabled would dim the whole control to a stray mark.
                        loading={checking}
                        disabled={!execution.ready}
                        onPress={checkAgain}
                    />
                ) : undefined}
            />
            {importApproval.approvalId && catalogScope ? (
                <ActionApprovalPendingNotice testID="mcp.detected.import.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(importApproval.approvalId!)}?serverId=${encodeURIComponent(catalogScope.serverId)}`)} />
            ) : null}
            {execution.approval.approvalId && serverId ? (
                <ActionApprovalPendingNotice testID="mcp.detected.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(execution.approval.approvalId!)}?serverId=${encodeURIComponent(serverId)}`)} />
            ) : null}
            {machineIds.length === 0 ? (
                <SurfaceStateCard
                    testID="mcp.found.noMachines"
                    size="page"
                    kind="empty"
                    title={t('capabilities.mcpFound.noMachinesTitle')}
                    reason={t('capabilities.mcpFound.noMachinesBody')}
                />
            ) : null}
            {sections.map((machine) => (
                <McpFoundMachineSection
                    key={machine.machineId}
                    machine={machine}
                    scan={scanOf(machine)}
                    catalog={catalog}
                    catalogRevision={catalogRevision}
                    inHappierByIdentity={inHappierByIdentity}
                    execution={adoptionExecution}
                    scopeKey={scopeKey}
                    secrets={secrets}
                    secretScope={execution.binding?.scope ?? null}
                    onScan={scan}
                    onOpen={open}
                />
            ))}
            <FoundQuietMachines testID="mcp.found.quiet" lines={quietLines} />
        </ItemList>
    );
});

/** A finding is named by the Agent that configures it and its name; a rescan hands back new objects for the same finding. */
const isSameFinding = (left: DetectedMcpServerV1 | null | undefined, right: DetectedMcpServerV1) =>
    left?.provider === right.provider && left?.name === right.name;

/** Inside a machine, servers group by the Agent that has them set up; each Agent keeps the scan's order. */
function groupByAgent(servers: readonly DetectedMcpServerV1[]): readonly DetectedMcpServerV1[] {
    const order = new Map<string, number>();
    for (const server of servers) if (!order.has(server.provider)) order.set(server.provider, order.size);
    return servers
        .map((server, index) => ({ server, index, agent: order.get(server.provider)! }))
        .sort((a, b) => a.agent - b.agent || a.index - b.index)
        .map((entry) => entry.server);
}

function serverCommand(server: DetectedMcpServerV1): string {
    return server.transport === 'stdio'
        ? [server.stdio?.command ?? '', ...(server.stdio?.args ?? [])].filter(Boolean).join(' ')
        : server.remote?.url ?? '';
}

const McpFoundMachineSection = React.memo(function McpFoundMachineSection(props: Readonly<{
    machine: ReachMachine;
    scan: McpFoundScan;
    catalog: McpServerCatalogV1 | null;
    catalogRevision: number | null;
    inHappierByIdentity: ReadonlyMap<string, string>;
    execution: Pick<Execution, 'execute' | 'ready' | 'isCurrent'>;
    scopeKey: string;
    secrets: React.ComponentProps<typeof McpFoundAdoptionPanel>['secrets'];
    secretScope: ServerAccountScope | null;
    onScan: (machineId: string) => Promise<void>;
    onOpen: (serverId: string, replace: boolean) => void;
}>) {
    const { machine, scan, onOpen } = props;
    const name = machine.name ?? machine.machineId;
    // Each machine owns its own Add continuation, so a value prompt opens under that machine's row.
    const adoption = useMcpFoundAdoption({ machineId: machine.machineId, machineOnline: machine.online, scopeKey: props.scopeKey,
        catalog: props.catalog, catalogRevision: props.catalogRevision, execution: props.execution });
    const adoptedServerId = adoption.state.status === 'adopted' ? adoption.state.serverId : null;
    React.useEffect(() => {
        if (adoptedServerId) onOpen(adoptedServerId, true);
    }, [adoptedServerId, onOpen]);

    const result = scan.result?.ok ? scan.result : null;
    const body = resolveFoundMachineBody({ failure: scan.failure, items: result?.servers ?? null });
    const servers = React.useMemo(() => groupByAgent(body.kind === 'rows' ? body.items : []), [body]);
    const canAdd = adoption.canBegin;
    const copy: FoundMachineGroupCopy = {
        looking: t('capabilities.mcpFound.looking'),
        nothingHere: t('capabilities.mcpFound.nothingHere'),
        scanFailed: t('capabilities.mcpFound.scanFailed', { machine: name }),
        tryAgain: t('capabilities.mcpFound.tryAgain'),
        olderMachine: t('capabilities.mcpFound.olderMachine', { machine: name }),
        lastKnown: (time) => t('capabilities.mcpFound.lastKnown', { time }),
        offlineBring: t('capabilities.mcpFound.offlineBring', { machine: name }),
    };

    return (
        <FoundMachineGroup
            machine={machine}
            body={body}
            failed={scan.failure === 'failed'}
            cause={scan.cause}
            hasLastKnown={result !== null}
            count={servers.length}
            copy={copy}
            onTryAgain={() => void props.onScan(machine.machineId)}
            testIDPrefix="mcp.found"
        >
            {(result?.warnings ?? []).map((warning, index) => (
                <SurfaceStateCard
                    key={`${warning.provider}:${warning.code}:${index}`}
                    testID={`mcp.found.warning.${machine.machineId}`}
                    size="line"
                    kind="error"
                    title={formatDetectedWarning(warning)}
                />
            ))}
            {servers.map((server) => {
                const inHappier = props.inHappierByIdentity.get(mcpServerImportIdentityV1(server)) ?? null;
                const adopting = isSameFinding(adoption.item, server);
                const rowId = `${machine.machineId}.${server.provider}.${server.name}`;
                return (
                    <React.Fragment key={`${server.provider}:${server.name}`}>
                        <CapabilityRow
                            testID={`mcp.found.row.${rowId}`}
                            mark={<HappierBrandMark brand={{ displayName: server.name }} pixelSize={20} externallyLabelled />}
                            title={server.name}
                            description={server.enabled === false
                                ? t('capabilities.mcpFound.offIn', { agent: resolveDetectedProviderName(server.provider) })
                                : t('capabilities.mcpFound.setUpIn', { agent: resolveDetectedProviderName(server.provider) })}
                            facts={{ presentation: 'row', extra: [
                                resolveTransportLabel(server.transport),
                                { text: serverCommand(server), mono: true },
                            ] }}
                            action={inHappier ? (
                                <Text variant="meta" style={styles.held} testID={`mcp.found.action.${rowId}`}>
                                    {t('capabilities.mcpFound.inHappier')}
                                </Text>
                            ) : adopting ? undefined : (
                                <RoundButton
                                    testID={`mcp.found.action.${rowId}`}
                                    accessibilityLabel={`${t('capabilities.mcpFound.add')} ${server.name}`}
                                    size="small"
                                    display="secondary"
                                    title={t('capabilities.mcpFound.add')}
                                    disabled={!canAdd}
                                    onPress={() => void adoption.begin(server)}
                                />
                            )}
                            stackActionWhenNarrow
                            {...(inHappier ? { onPress: () => onOpen(inHappier, false) } : {})}
                            density="page"
                        />
                        {adopting ? (
                            <McpFoundAdoptionPanel
                                testID="mcp.detected.adopt"
                                adoption={adoption}
                                secrets={props.secrets}
                                scope={props.secretScope}
                            />
                        ) : null}
                    </React.Fragment>
                );
            })}
        </FoundMachineGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    held: { color: theme.colors.text.secondary },
}));
