import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ProjectDefinitionInspectOutputSchema } from '../projectDefinitionActionFamily.js';
import { readProjectManifestDocument } from '../../workspaces/projectSetup/projectManifestDocument.js';
import type { ProjectManifestV1 } from '../../workspaces/projectSetup/projectManifestV1.js';
import type { ProjectExecutionChoiceV1 } from '../../workspaces/projectWorkerPreferencesV1.js';
import { resolveProjectActionMachineV1, type ProjectPlacementActionExecutorV1 } from './projectActionPlacement.js';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
const native = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
const exact = { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } } as const satisfies ProjectExecutionChoiceV1;
const pool = { kind: 'workers', destination: { kind: 'pool', poolId: '4e9648b6-6b2d-47dc-9e3f-d927a430102d', selection: 'automatic' } } as const satisfies ProjectExecutionChoiceV1;

function sourceReads(manifest?: ProjectManifestV1) {
  const bytes = JSON.stringify(manifest);
  const inspection = ProjectDefinitionInspectOutputSchema.parse({
    definition: manifest ? { basis: { kind: 'present', hash: createHash('sha256').update(bytes!).digest('hex') },
      document: readProjectManifestDocument(bytes!) } : { basis: { kind: 'absent' }, document: null },
    detection: { entries: [{ source: native, usage: 'script' }], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
    importCandidates: [],
  });
  const reads: string[] = [];
  // These are remote SOURCE/Home Action responses. Placement, declaration
  // parsing, precedence and all strict response validation remain real.
  const executeCanonicalAction: ProjectPlacementActionExecutorV1 = async actionId => {
    reads.push(actionId);
    if (actionId === 'projects.inspect') return { ok: true, result: inspection };
    if (actionId === 'projects.worker.preferences.get') return { ok: true, result: { status: 'ready', revision: 1,
      provenance: 'saved', preference: { enabled: true, destination: exact.destination, unavailable: 'fail', allowAdHoc: false, scriptOverrides: {} } } };
    if (actionId === 'projects.worker.status') return { ok: true, result: { eligible: true, load: { kind: 'unknown' },
      candidate: { serverId: 'home', machineId: 'worker' }, explanation: 'load_unknown' } };
    if (actionId === 'machines.pools.resolve') return { ok: true, result: { kind: 'resolved', poolId: pool.destination.poolId,
      machineId: 'worker', priorityTier: 0 } };
    throw new Error(`Unexpected placement read: ${actionId}`);
  };
  return { reads, place: (selection: { kind: 'native'; source: typeof native } | { kind: 'named'; name: string },
    choice?: ProjectExecutionChoiceV1, context: Parameters<typeof resolveProjectActionMachineV1>[0]['context'] = {}) =>
    resolveProjectActionMachineV1({ actionId: 'projects.script.run', input: { workspace, selection, ...(choice ? { choice } : {}) },
      context, executeCanonicalAction, createRequestKey: () => 'request' }) };
}

describe('Project Action declaration placement ceiling', () => {
  it.each([{ label: 'exact', choice: exact }, { label: 'pool', choice: pool }])(
    'refuses detected native $label worker intent before worker or pool admission', async ({ choice }) => {
      const h = sourceReads();
      expect(await h.place({ kind: 'native', source: native }, choice)).toMatchObject({ ok: false, errorCode: 'primary_only' });
      expect(h.reads).not.toContain('projects.worker.status');
      expect(h.reads).not.toContain('machines.pools.resolve');
    });

  it('keeps detected native execution on SOURCE despite enabled workspace workers', async () => {
    const h = sourceReads();
    expect(await h.place({ kind: 'native', source: native })).toEqual({ ok: true, machineId: 'source' });
    expect(h.reads).not.toContain('projects.worker.status');
    expect(h.reads).not.toContain('machines.pools.resolve');
  });

  it('refuses an accepted worker for a named native declaration with no portable execution permission', async () => {
    const h = sourceReads({ version: 1, scripts: { check: { source: native } } });
    expect(await h.place({ kind: 'named', name: 'check' }, undefined, { executionRunTargetMachineId: 'worker' }))
      .toMatchObject({ ok: false, errorCode: 'primary_only' });
  });

  it('retains explicitly portable named native execution for exact, pool, default and accepted worker choices', async () => {
    for (const choice of [exact, pool, undefined]) {
      const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } });
      expect(await h.place({ kind: 'named', name: 'check' }, choice)).toEqual({ ok: true, machineId: 'worker' });
    }
    const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } });
    expect(await h.place({ kind: 'named', name: 'check' }, undefined, { executionRunTargetMachineId: 'worker' }))
      .toEqual({ ok: true, machineId: 'worker' });
  });
});
