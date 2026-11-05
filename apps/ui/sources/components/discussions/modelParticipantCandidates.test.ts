import { describe, expect, it } from 'vitest';

import { projectModelParticipantCandidates } from '@/components/discussions/modelParticipantCandidates';

const machines = [
  { id: 'm-laptop', name: 'MacBook Pro' },
  { id: 'm-vps', name: 'build-vps' },
  { id: 'm-idle', name: 'spare-box' },
];

describe('projectModelParticipantCandidates', () => {
  it('matches an external Agent by model catalog names supplied by Session authoring', () => {
    const rows = projectModelParticipantCandidates({
      machines: [{ id: 'run', name: 'Run host', reachable: true }],
      sessions: [{ agentId: 'vendor/reviewer', machineId: 'run', lastActivityAt: 1 }],
      query: 'GPT review', agentLabel: () => 'Reviewer', agentSearchText: () => 'GPT review gpt-review',
    });
    expect(rows).toEqual([{ kind: 'agent', agentId: 'vendor/reviewer', machineId: 'run', machineName: 'Run host' }]);
  });

  it('opens setup on the selected Run machine even when previous Sessions used another machine', () => {
    const input = {
      machines: [{ id: 'old', name: 'Laptop', reachable: false }, { id: 'run', name: 'Run host', reachable: true }],
      sessions: [{ agentId: 'vendor/agent', machineId: 'old', lastActivityAt: 1 }],
      preferredMachineId: 'run', query: '',
    };
    expect(projectModelParticipantCandidates(input)).toEqual([
      { kind: 'agent', agentId: 'vendor/agent', machineId: 'run', machineName: 'Run host' },
    ]);
    // An explicit offline target is retained; the setup must explain its actual presence.
    expect(projectModelParticipantCandidates({ ...input, preferredMachineId: 'old' })[0]?.machineId).toBe('old');
    // An id absent from this Home cannot borrow another Home's machine.
    expect(projectModelParticipantCandidates({ ...input, preferredMachineId: 'foreign' })[0]?.machineId).toBe('old');
  });

  it('offers each Agent the viewer uses once, on the Machine of its latest session, newest first', () => {
    const rows = projectModelParticipantCandidates({
      machines,
      query: '',
      sessions: [
        { agentId: 'codex', machineId: 'm-vps', lastActivityAt: 10 },
        { agentId: 'gemini', machineId: 'm-laptop', lastActivityAt: 30 },
        { agentId: 'codex', machineId: 'm-laptop', lastActivityAt: 20 },
        { agentId: null, machineId: 'm-idle', lastActivityAt: 40 },
        { agentId: 'claude', machineId: 'm-gone', lastActivityAt: 50 },
      ],
    });
    expect(rows).toEqual([
      { kind: 'agent', agentId: 'gemini', machineId: 'm-laptop', machineName: 'MacBook Pro' },
      { kind: 'agent', agentId: 'codex', machineId: 'm-laptop', machineName: 'MacBook Pro' },
    ]);
  });

  it('prefers the latest session on a Machine that answers now, over a newer one on a Machine that does not', () => {
    const rows = projectModelParticipantCandidates({
      machines: [{ id: 'm-laptop', name: 'MacBook Pro', reachable: false }, { id: 'm-vps', name: 'build-vps', reachable: true }],
      query: '',
      sessions: [
        { agentId: 'codex', machineId: 'm-laptop', lastActivityAt: 20 },
        { agentId: 'codex', machineId: 'm-vps', lastActivityAt: 10 },
        { agentId: 'claude', machineId: 'm-laptop', lastActivityAt: 5 },
      ],
    });
    expect(rows).toEqual([
      { kind: 'agent', agentId: 'codex', machineId: 'm-vps', machineName: 'build-vps' },
      { kind: 'agent', agentId: 'claude', machineId: 'm-laptop', machineName: 'MacBook Pro' },
    ]);
  });

  it('falls back to one setup row per Machine when no session names an Agent and Machine', () => {
    const rows = projectModelParticipantCandidates({ machines, query: '', sessions: [{ agentId: 'codex', machineId: null, lastActivityAt: 1 }] });
    expect(rows.map(row => [row.kind, row.machineId])).toEqual([['machine', 'm-laptop'], ['machine', 'm-vps'], ['machine', 'm-idle']]);
  });

  it('offers no Machine fallback while the session listing has not landed, so Agent rows never replace Machine rows', () => {
    expect(projectModelParticipantCandidates({ machines, query: '', sessions: [], sessionsSettled: false })).toEqual([]);
  });

  it('a search reaches every Machine by name, and Agents by their label or Machine', () => {
    const rows = projectModelParticipantCandidates({
      machines,
      query: 'vps',
      agentLabel: id => ({ codex: 'Codex', gemini: 'Gemini' })[id] ?? id,
      sessions: [
        { agentId: 'codex', machineId: 'm-vps', lastActivityAt: 2 },
        { agentId: 'gemini', machineId: 'm-laptop', lastActivityAt: 3 },
      ],
    });
    expect(rows).toEqual([
      { kind: 'agent', agentId: 'codex', machineId: 'm-vps', machineName: 'build-vps' },
      { kind: 'machine', machineId: 'm-vps', machineName: 'build-vps' },
    ]);
    const byAgent = projectModelParticipantCandidates({
      machines, query: 'gem', agentLabel: id => (id === 'gemini' ? 'Gemini' : id),
      sessions: [{ agentId: 'gemini', machineId: 'm-laptop', lastActivityAt: 3 }],
    });
    expect(byAgent.map(row => row.kind)).toEqual(['agent']);
  });
});
