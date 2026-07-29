import { describe, expect, it } from 'vitest';

import { getActionSpec } from '../../actions/actionSpecs.js';
import {
  ExternalSessionDestructiveQuiescenceResultV1Schema,
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
  doesExternalSessionDestructiveQuiescencePermitAdmissionV1,
} from './takeoverV1.js';
import {
  mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1,
} from './takeoverCompatV1.js';

const sourceIdentity = {
  machineId: 'machine-1',
  linkedSessionId: 'session-1',
  remoteSessionId: 'remote-1',
  linkGeneration: 'link-generation-1',
  sourceKey: 'exampleSource:instance-1',
  qualifiedIdentity: {
    v: 1,
    agent: {
      pluginId: 'com.example.agent',
      localId: 'assistant',
    },
    source: {
      kind: 'exampleSource',
      contractVersion: 1,
    },
  },
} as const;

const processIdentity = {
  machineId: 'machine-1',
  pid: 42,
  startedAtMs: 1_000,
} as const;

const stoppedEvidence = {
  kind: 'operating_system_process_state',
  processState: 'verified_stopped',
  observedAtMs: 2_000,
  sourceIdentity,
  processIdentity,
} as const;

describe('External Sessions takeover safety contract', () => {
  it('accepts optional machine identity while rejecting canonical force or bypass flags', () => {
    expect(ExternalSessionTakeoverInputV1Schema.parse({
      linkedSessionId: 'session-1',
      machineId: 'machine-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'external-linked',
    })).toEqual({
      linkedSessionId: 'session-1',
      machineId: 'machine-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'external-linked',
    });
    expect(ExternalSessionTakeoverInputV1Schema.safeParse({
      linkedSessionId: 'session-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'persisted',
    }).success).toBe(true);

    const actionSpec = getActionSpec('sessions.external.takeover');
    const actionInput = actionSpec.inputSchema;
    expect(actionSpec.inputHints?.fields.map((field) => field.path)).not.toContain('forceStop');
    for (const unsafe of [
      { forceStop: true },
      { force: true },
      { bypass: true },
    ]) {
      expect(actionInput.safeParse({
        linkedSessionId: 'session-1',
        machineId: 'machine-1',
        targetRuntimeMode: 'terminal',
        storageMode: 'external-linked',
        ...unsafe,
      }).success).toBe(false);
    }
  });

  it('fails closed when a released legacy takeover request carries stop authority', () => {
    const mapped = mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1({
      linkedSessionId: 'session-1',
      forceStop: true,
    });

    expect(ExternalSessionTakeoverInputV1Schema.safeParse(mapped).success).toBe(false);
  });

  it('requires destructive quiescence evidence bound to the exact source and process identity', () => {
    const stopped = ExternalSessionDestructiveQuiescenceResultV1Schema.parse({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity,
      evidence: stoppedEvidence,
    });
    expect(stopped).toEqual({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity,
      evidence: stoppedEvidence,
    });
    expect(doesExternalSessionDestructiveQuiescencePermitAdmissionV1(stopped)).toBe(true);

    for (const status of ['verified_running', 'unknown'] as const) {
      const result = ExternalSessionDestructiveQuiescenceResultV1Schema.parse({
        status,
        sourceIdentity,
        processIdentity,
        evidence: {
          ...stoppedEvidence,
          processState: status,
        },
      });
      expect(doesExternalSessionDestructiveQuiescencePermitAdmissionV1(result)).toBe(false);
    }

    expect(ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity,
      evidence: {
        ...stoppedEvidence,
        processIdentity: {
          ...processIdentity,
          startedAtMs: processIdentity.startedAtMs + 1,
        },
      },
    }).success).toBe(false);

    expect(ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity,
      evidence: {
        ...stoppedEvidence,
        sourceIdentity: {
          ...sourceIdentity,
          linkGeneration: 'stale-link-generation',
        },
      },
    }).success).toBe(false);

    expect(ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity,
      evidence: {
        ...stoppedEvidence,
        sourceIdentity: {
          ...sourceIdentity,
          sourceKey: 'exampleSource:different-instance',
        },
      },
    }).success).toBe(false);

    expect(ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
      status: 'verified_stopped',
      sourceIdentity,
      processIdentity: {
        ...processIdentity,
        machineId: 'different-machine',
      },
      evidence: {
        ...stoppedEvidence,
        processIdentity: {
          ...processIdentity,
          machineId: 'different-machine',
        },
      },
    }).success).toBe(false);
  });

  it('does not admit presentation status as destructive quiescence evidence', () => {
    expect(ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
      status: 'idle',
      observedAtMs: 2_000,
      expiresAtMs: 3_000,
      linkGeneration: 1,
    }).success).toBe(false);
  });

  it('exposes portable actionable process and writer failures without local forensic data', () => {
    for (const errorCode of [
      'external_process_active',
      'external_process_unknown',
      'external_writer_conflict',
    ] as const) {
      expect(ExternalSessionTakeoverResultV1Schema.safeParse({
        ok: false,
        errorCode,
        error: errorCode,
        gracefulStopAvailable: errorCode === 'external_process_active',
        details: {
          machineId: 'machine-1',
          observedAtMs: 2_000,
          evidenceKind: 'operating_system_process_state',
          process: processIdentity,
          sourceKind: 'exampleSource',
        },
      }).success).toBe(true);
    }

    expect(ExternalSessionTakeoverResultV1Schema.safeParse({
      ok: false,
      errorCode: 'external_process_active',
      error: 'external_process_active',
      gracefulStopAvailable: false,
      details: {
        machineId: 'machine-1',
        observedAtMs: 2_000,
        evidenceKind: 'operating_system_process_state',
        path: '/private/source/session.jsonl',
      },
    }).success).toBe(false);

    expect(ExternalSessionTakeoverResultV1Schema.safeParse({
      ok: false,
      errorCode: 'external_process_active',
      error: 'external_process_active',
      gracefulStopAvailable: false,
      details: {
        machineId: 'machine-1',
        observedAtMs: 2_000,
        evidenceKind: 'operating_system_process_state',
        process: {
          ...processIdentity,
          machineId: 'different-machine',
        },
      },
    }).success).toBe(false);
  });
});
