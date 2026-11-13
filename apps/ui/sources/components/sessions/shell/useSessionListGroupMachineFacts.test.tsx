import { afterEach, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { buildSessionListProjectHeaderViewModels, type SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';
import { useSessionListGroupMachineFacts } from './useSessionListGroupMachineFacts';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

it('keeps the header facts when a list update leaves every colliding header unchanged', async () => {
    // Two Project headers share a label, so each carries its Machine's name. Another Session's turn
    // rebuilds the list items without touching either header: every row and header reading these
    // facts must not redraw (P03 Q16: every mounted row re-rendered on each list update).
    const machines = ['laptop-a', 'laptop-b'].map(id => createMachineFixture({ id,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Laptop', host: 'laptop.local' },
    }));
    const listItems = computeVisibleSessionListIndex({ source: [], resolveSessionRow: () => null,
        hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
        sessionListLayoutChoice: 'projects', presentation: { enabled: false, presentation: 'grouped' },
        workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
        viewerAccountIdByServerId: new Map([['home', 'run-viewer']]),
        workflowRuns: machines.map(machine => ({ serverId: 'home', summary: createWorkflowRunSummaryFixture({
            id: machine.id, ownerAccountId: 'run-viewer', startedBy: 'user', where: { machineId: machine.id, directory: '/home/happier' },
        }) })),
    })!;
    const headerState = buildSessionListProjectHeaderViewModels({
        listItems, machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceLabels: undefined, workspaceRefs: [],
    });
    storage.setState({ machineDisplayById: Object.fromEntries(machines.map(machine => [machine.id, machine])) });

    const harness = await renderHook(({ items }: { items: typeof listItems }) => (
        useSessionListGroupMachineFacts({ listItems: items, headerState })
    ), { initialProps: { items: listItems } });
    expect([...harness.getCurrent().projectHeaderViewModelByGroupKey.values()].every(header => header.machineDetail?.name)).toBe(true);
    const before = harness.getCurrent();
    const republished: SessionListProjectHeaderViewModelState[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
        const next = await harness.rerender({ items: [...listItems] });
        if (next !== before) republished.push(next);
    }
    expect(republished).toHaveLength(0);
});
