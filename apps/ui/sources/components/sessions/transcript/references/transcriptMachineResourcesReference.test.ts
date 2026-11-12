import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';

import { createProcessesAnswer } from '@/components/machines/processes/testkit/processesAnswerFixture';

import { readTranscriptMachineResourcesCall } from './transcriptMachineResourcesReference';

const toolName = (
  id: 'machines.processes.list' | 'machines.storage.trash.move' | 'machines.storage.deleteNow' | 'machines.processes.kill' | 'machines.processes.leftBehind.cleanUp',
) => getActionSpec(id).bindings!.mcpToolName!;
const ref = {
  itemId: 'wt',
  path: '/w/wt',
  identity: { dev: '1', ino: '2', kind: 'directory' },
  collectedAt: 1,
  collectedBy: { accountId: 'a', kind: 'agent' },
};

describe('readTranscriptMachineResourcesCall', () => {
  it.each(['machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const)('renders %s analysing through the shared proposal reader', (actionId) => {
    const input = actionId === 'machines.processes.kill'
      ? { machineId: 'm1', targets: [{ ref: 'process-1', expect: { level: 'proven' } }], tree: true }
      : { machineId: 'm1', refs: ['process-1'] };
    const call = readTranscriptMachineResourcesCall({ name: toolName(actionId), state: 'running', input, result: null });
    expect(call).toMatchObject({ kind: 'proposing', actionId, proposal: { items: [{ key: 'process-1' }] } });
  });
  it.each(['machines.storage.trash.move', 'machines.storage.deleteNow'] as const)('renders %s still being proposed through its real tool binding and strict input', (actionId) => {
    const call = readTranscriptMachineResourcesCall({
      name: toolName(actionId),
      state: 'running',
      result: null,
      input: getActionSpec(actionId).inputSchema.parse({
        machineId: 'm1',
        items: [{ ref, expect: 'e', ...(actionId === 'machines.storage.trash.move' ? { claimedVerdict: 'safe' } : {}) }],
      }),
    });
    expect(call).toMatchObject({
      kind: 'proposing',
      actionId,
    });
    expect(
      call?.kind === 'proposing'
        ? call.proposal?.items.map((item) => item.key)
        : null,
    ).toEqual(['wt']);
  });

  it('leaves a finished proposal call to its approval card, and an unreadable census to the generic row', () => {
    expect(
      readTranscriptMachineResourcesCall({
        name: toolName('machines.storage.trash.move'),
        state: 'completed',
        result: {},
        input: { machineId: 'm1', items: [] },
      }),
    ).toBeNull();
    expect(
      readTranscriptMachineResourcesCall({
        name: toolName('machines.processes.list'),
        state: 'completed',
        result: { nope: true },
        input: { machineId: 'm1' },
      }),
    ).toBeNull();
    expect(
      readTranscriptMachineResourcesCall({
        name: 'some_other_tool',
        state: 'running',
        result: null,
        input: {},
      }),
    ).toBeNull();
  });

    it('renders a completed census as the Processes rows for its machine', () => {
        const answer = createProcessesAnswer();
        const call = readTranscriptMachineResourcesCall({
            name: toolName('machines.processes.list'), state: 'completed', result: answer, input: { machineId: 'edge-1', serverId: 'home-a' },
        });
        expect(call).toMatchObject({ kind: 'processes', machineId: 'edge-1', serverId: 'home-a' });
        expect(readTranscriptMachineResourcesCall({
            name: 'mcp__happier__action_execute', state: 'completed', result: answer,
            input: { actionId: 'machines.processes.list', input: JSON.stringify({ machineId: 'edge-1', serverId: 'home-a' }) },
        })).toMatchObject({ kind: 'processes', machineId: 'edge-1', serverId: 'home-a' });
    });
});
