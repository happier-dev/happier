import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ProjectDefinitionInspectOutputSchema } from '../projectDefinitionActionFamily.js';
import { readProjectManifestDocument } from '../../workspaces/projectSetup/projectManifestDocument.js';
import type { ProjectManifestV1 } from '../../workspaces/projectSetup/projectManifestV1.js';
import type { ProjectExecutionChoiceV1 } from '../../workspaces/projectWorkerPreferencesV1.js';
import { resolveProjectActionMachineV1, type ProjectPlacementActionExecutorV1 } from './projectActionPlacement.js';
import type { ManagedMachineV1 } from '../../machines/managed/managedMachineV1.js';

const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
const native = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
const exact = { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } } as const satisfies ProjectExecutionChoiceV1;
const pool = { kind: 'workers', destination: { kind: 'pool', poolId: '4e9648b6-6b2d-47dc-9e3f-d927a430102d', selection: 'automatic' } } as const satisfies ProjectExecutionChoiceV1;

function sourceReads(manifest?: ProjectManifestV1, workerStatus?: unknown, managed?: ManagedMachineV1) {
  const bytes = JSON.stringify(manifest);
  const inspection = ProjectDefinitionInspectOutputSchema.parse({
    definition: manifest ? { basis: { kind: 'present', hash: createHash('sha256').update(bytes!).digest('hex') },
      document: readProjectManifestDocument(bytes!) } : { basis: { kind: 'absent' }, document: null },
    detection: { entries: [{ source: native, usage: 'script' }], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
    importCandidates: [],
  });
  const reads: string[] = [];
  // These are remote SOURCE/Home Action responses. Placement, declaration
  // parsing, precedence and all strict response validation remain real.
  const executeCanonicalAction: ProjectPlacementActionExecutorV1 = async (actionId, input) => {
    reads.push(actionId);
    if (actionId === 'projects.inspect') {
      expect(input).toEqual({ workspace, read: { kind: 'placement' } });
      return { ok: true, result: inspection };
    }
    if (actionId === 'projects.worker.preferences.get') return { ok: true, result: { status: 'ready', revision: 1,
      provenance: 'saved', preference: { enabled: true, destination: exact.destination, unavailable: 'fail', allowAdHoc: false, scriptOverrides: {} } } };
    if (actionId === 'projects.worker.status') return { ok: true, result: workerStatus ?? { eligible: true, load: { kind: 'unknown' },
      candidate: { serverId: 'home', machineId: 'worker' }, explanation: 'load_unknown' } };
    if (actionId === 'machines.managed.list') return { ok: true, result: { machines: managed ? [managed] : [] } };
    if (actionId === 'machines.pools.resolve') return { ok: true, result: { kind: 'resolved', poolId: pool.destination.poolId,
      machineId: 'worker', priorityTier: 0 } };
    throw new Error(`Unexpected placement read: ${actionId}`);
  };
  return { reads, executeCanonicalAction, place: (selection: { kind: 'native'; source: typeof native } | { kind: 'named'; name: string },
    choice?: ProjectExecutionChoiceV1, context: Parameters<typeof resolveProjectActionMachineV1>[0]['context'] = {}) =>
    resolveProjectActionMachineV1({ actionId: 'projects.script.run', input: { workspace, selection, ...(choice ? { choice } : {}) },
      context, ...(managed ? { homeId: 'home' } : {}), executeCanonicalAction, createRequestKey: () => 'request' }) };
}

describe('Project Action declaration placement ceiling', () => {
  it('enforces an explicit primary compute constraint before worker effects while omitted constraints stay portable', async () => {
    const h = sourceReads();
    const executeCanonicalAction: ProjectPlacementActionExecutorV1 = async (id, input) => {
      const result = await h.executeCanonicalAction(id, input);
      return id === 'projects.worker.preferences.get' ? { ok: true, result: {
        status: 'ready', revision: 1, provenance: 'saved', preference: { enabled: true,
          destination: exact.destination, unavailable: 'fail', allowAdHoc: true, scriptOverrides: {} },
      } } : result;
    };
    const place = (extra: object = {}, context = {}) => resolveProjectActionMachineV1({
      actionId: 'projects.compute.exec', input: { workspace, executable: '/usr/bin/tool', argv: [], cwd: '/repo', ...extra },
      context, executeCanonicalAction, createRequestKey: () => 'request',
    });
    expect(await place({ execution: 'primary' })).toEqual({ ok: true, machineId: 'source' });
    expect(await place({ execution: 'primary', choice: exact })).toMatchObject({ ok: false, errorCode: 'primary_only' });
    expect(await place({ execution: 'primary' }, { executionRunTargetMachineId: 'worker' }))
      .toMatchObject({ ok: false, errorCode: 'primary_only' });
    expect(h.reads.filter(id => id === 'projects.worker.status' || id === 'machines.pools.resolve')).toHaveLength(0);
    expect(await place()).toEqual({ ok: true, machineId: 'worker' });
  });
  it('starts independent SOURCE and preference reads together before resolving placement', async () => {
    const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } });
    let releaseInspection!: () => void;
    const inspectionReady = new Promise<void>(resolve => { releaseInspection = resolve; });
    const pending = resolveProjectActionMachineV1({ actionId: 'projects.script.run',
      input: { workspace, selection: { kind: 'named', name: 'check' } }, context: {}, createRequestKey: () => 'request',
      executeCanonicalAction: async (actionId, input) => {
        const response = h.executeCanonicalAction(actionId, input);
        if (actionId === 'projects.inspect') await inspectionReady;
        return await response;
      } });
    try {
      // Home preferences are independent of SOURCE bytes. Holding the real
      // remote inspection response must not delay issuing that Home read.
      expect(h.reads).toContain('projects.worker.preferences.get');
    } finally { releaseInspection(); }
    expect(await pending).toEqual({ ok: true, machineId: 'worker' });
  });
  it.each([true, false])('preserves SOURCE refusal precedence over an early preference rejection (source fails=%s)', async sourceFails => {
    const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } });
    const error = new Error('Home unavailable');
    const pending = resolveProjectActionMachineV1({ actionId: 'projects.script.run',
      input: { workspace, selection: { kind: 'named', name: 'check' } }, context: {}, createRequestKey: () => 'request',
      executeCanonicalAction: async (actionId, input) => {
        if (actionId === 'projects.worker.preferences.get') throw error;
        if (actionId === 'projects.inspect' && sourceFails) return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' };
        return await h.executeCanonicalAction(actionId, input);
      } });
    if (sourceFails) expect(await pending).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
    else await expect(pending).rejects.toBe(error);
  });
  it.each(['asleep', 'starting'] as const)('addresses an exact %s managed target before guest status, leaving wake and admission to the original finite root', async state => {
    const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Worker', choices: {} };
    const managed: ManagedMachineV1 = { id: 'managed', homeId: 'home', custodianAccountId: 'account', launch,
      controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound',
      resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
      creationState: 'active', enrolledMachineId: 'worker', desired: state === 'asleep' ? 'stop' : 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
      ...(state === 'starting' ? { submittedNativeEffect: { intent: 'start' as const, intentRevision: 1,
        requestId: 'start', controller: { machineId: 'controller', installationId: 'installation' } } } : {}),
    };
    const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } },
      { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'unavailable' }, managed);
    expect(await h.place({ kind: 'named', name: 'check' }, exact)).toEqual({ ok: true, machineId: 'worker' });
    expect(h.reads).not.toContain('projects.worker.status');
    // Revoking retained wake cannot use offline presence as finite eligibility.
    const refused = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } },
      { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'unavailable' }, { ...managed, wakeOnAcceptedMessage: false });
    expect(await refused.place({ kind: 'named', name: 'check' }, exact)).toMatchObject({ ok: false });
    for (const invalid of [{ ...managed, archivedAt: 1 }, { ...managed, desired: 'delete' as const },
      { ...managed, allocation: 'may-exist' as const, resource: undefined },
      { ...managed, observation: { ...managed.observation!, storage: 'lost' as const } }, { ...managed, enrolledMachineId: 'another' }]) {
      const stale = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } },
        { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'unavailable' }, invalid);
      expect(await stale.place({ kind: 'named', name: 'check' }, exact)).toMatchObject({ ok: false });
    }
  });
  it.each([false, true])('retains exact copy-setup facts at the existing frontdoor and rejects stale Machine facts (stale=%s)', async stale => {
    const workerCopy = { serverId: 'home', sourceWorkspaceRefId: 'checkout', sourceMachineId: 'source', targetMachineId: stale ? 'another-worker' : 'worker' };
    const h = sourceReads({ version: 1, scripts: { check: { execution: 'portable', source: native } } },
      { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'worker_copy_missing', workerCopy });
    expect(await h.place({ kind: 'named', name: 'check' }, exact)).toMatchObject(stale
      ? { ok: false, errorCode: 'invalid_action_output' }
      : { ok: false, errorCode: 'worker_copy_missing', details: { kind: 'no_worker_can_accept', unavailable: 'fail', reason: 'worker_copy_missing', workerCopy } });
  });
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
