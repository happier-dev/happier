import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { resolveSessionServerStartCandidateSelection } from './serverStartDraftCandidateSelection';

describe('Session server-start candidate selection', () => {
    it('keeps the selected server, machine, path, and readiness on one candidate', () => {
        const mountedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: false,
            activeAt: 0,
        });
        const selectedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: true,
            activeAt: Date.now(),
            metadata: {
                host: 'selected.example',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
                happyHomeDir: '/selected/.happier',
                homeDir: '/selected',
            },
        });
        const candidate = {
            projectKey: { id: 'project-selected' },
            serverId: 'server-selected',
            machineId: 'shared-machine-id',
            rootPath: '/selected/project',
            reachable: true,
            worktrees: [],
        };

        const selection = resolveSessionServerStartCandidateSelection({
            mountedTarget: { serverId: 'server-mounted', machineId: 'shared-machine-id' },
            selectedCandidate: candidate,
            activeServerId: 'server-mounted',
            activeMachines: [mountedMachine],
            machineListByServerId: { 'server-selected': [selectedMachine] },
        });

        expect(selection).toEqual({
            candidate,
            target: { serverId: 'server-selected', machineId: 'shared-machine-id' },
            machine: selectedMachine,
            directory: '/selected/project',
            machineReady: true,
        });
    });
});
