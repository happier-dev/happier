import * as React from 'react';
import { act } from 'react';
import { expect, it, onTestFinished } from 'vitest';
import { HappierComposerChip } from '@happier-dev/plugin-ui/presentation';
import type { SessionPermissionMode } from '@happier-dev/protocol/sessions/metadata/sessionPermissionModes';

import '@/sync/syncEngine';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { useHydratedBulkSessionAuthoringFacts } from '@/components/sessions/authoring/bulk/useHydratedBulkSessionAuthoringFacts';
import { useCrossSessionAuthoringFieldControl } from '@/components/sessions/authoring/controls/useCrossSessionAuthoringFieldControl';
import { storage } from '@/sync/domains/state/storageStore';
import { useBulkSessionControlTargets } from './BulkSessionControlTargets';
import { useBulkSessionTargetNames } from './useBulkSessionTargetIdentities';

it('keeps probes and chips quiet on unrelated target publications and intersects once on an authoring change', async () => {
    let permissionMode: SessionPermissionMode = 'default';
    let metadataVersion = 1;
    let catalogRevision = 1;
    let title = 'First target';
    const sessionIds = ['a', 'b', 'c'];
    const boundary = createSessionReadBatchHttpBoundary(request => {
        const id = request.path.match(/^\/v2\/sessions\/([abc])$/)?.[1];
        if (!id) return undefined;
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
            id, active: true, metadataVersion: id === 'a' ? metadataVersion : 1,
            metadata: { path: '/repo', host: 'host', flavor: 'codex', machineId: 'machine',
                permissionMode: id === 'a' ? permissionMode : 'default',
                sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: catalogRevision, currentModelId: 'default',
                    availableModels: [{ id: 'default', name: 'Default' }, { id: 'other', name: `Other ${catalogRevision}` }] },
            },
        }) });
    });
    const homes = await serveAccountHomes({
        homes: [{ key: 'home', serverUrl: 'https://bulk-controls.test', accountId: 'account' }],
        route: request => boundary.handle(request),
    });
    onTestFinished(() => homes.dispose());
    const previous = storage.getState();
    onTestFinished(() => storage.setState(previous, true));
    const serverId = homes.homes.home!.id;
    const addresses = sessionIds.map(sessionId => ({ serverId, sessionId }));
    const row = createSessionFixture({ id: 'a', serverId, metadataVersion,
        metadata: { path: '/repo', host: 'host', name: title } });
    storage.setState({ sessionListRowsByServerId: { [serverId]: { a: row } } });

    const counts = createCommittedFiberRenderCounter();
    let readRoot: ReturnType<typeof readTestRendererRoot> | undefined;
    const selections: string[] = [];
    let firstTargetName: string | undefined;
    function ComposerControls() {
        const { facts } = useHydratedBulkSessionAuthoringFacts(addresses);
        [firstTargetName] = useBulkSessionTargetNames(addresses);
        const { targets, probes } = useBulkSessionControlTargets(facts);
        const control = useCrossSessionAuthoringFieldControl({
            field: 'permissionMode', targets: targets ?? noTargets, agentSwitchingEnabled: true, mixedLabel: 'Mixed',
        });
        const label = control.kind === 'options' ? control.unselectedLabel ?? control.selectedOptionId : '';
        React.useEffect(() => { selections.push(label); }, [control, label]);
        return <>{probes}<HappierComposerChip onPress={noop} accessibilityLabel={label} /></>;
    }
    const screen = await renderScreen(<React.Profiler id="bulk-controls"
        onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <ComposerControls />
    </React.Profiler>);
    onTestFinished(() => screen.unmount());
    await expect.poll(() => selections.at(-1)).toBe('default');
    await flushHookEffects();
    readRoot = readTestRendererRoot(screen.tree.root);
    const publish = async (seq: number) => {
        await act(async () => storage.setState({ sessionListRowsByServerId: {
            [serverId]: { a: {
                ...row, seq, updatedAt: seq, metadataVersion, thinking: seq % 2 === 0,
                metadata: { ...row.metadata!, name: title },
            } },
        } }));
        await flushHookEffects();
    };

    counts.start();
    selections.length = 0;
    for (let seq = 2; seq <= 51; seq++) await publish(seq);
    const initialReads = boundary.componentRequests.length;
    catalogRevision++;
    metadataVersion++;
    await publish(52);
    await expect.poll(() => boundary.componentRequests.length).toBeGreaterThan(initialReads);
    await flushHookEffects();
    expect.soft({
        probes: counts.read().renders.get('MachineProbe') ?? 0,
        chips: counts.read().rendersFor(HappierComposerChip),
        intersections: selections,
    }).toEqual({ probes: 0, chips: 0, intersections: [] });

    counts.start();
    title = 'Renamed target';
    metadataVersion++;
    await publish(53);
    expect(firstTargetName).toBe('Renamed target');
    expect.soft(counts.read().renders.get('MachineProbe') ?? 0).toBe(0);

    counts.start();
    permissionMode = 'read-only';
    metadataVersion++;
    await publish(54);
    await expect.poll(() => selections.at(-1)).toBe('Mixed');
    expect(selections).toEqual(['Mixed']);
    expect(counts.read().rendersFor(HappierComposerChip)).toBeGreaterThan(0);
});

const noTargets = Object.freeze([]);
const noop = () => {};
