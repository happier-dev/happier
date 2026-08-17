import { describe, expect, it } from 'vitest';

import {
  DaemonPluginCollectionCandidatePreparationRequestV1Schema,
  DaemonPluginCollectionCandidatePreparationResponseV1Schema,
} from './pluginCollectionCandidatePreparation.js';

const sourceContract = {
  pluginId: 'acme.tasks',
  collectionId: 'tasks',
  schemaVersion: 1,
  migrations: [],
  contractDigest: 'a'.repeat(43),
  rowIdField: 'id',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['id', 'title'],
    additionalProperties: false,
  },
  serverReadable: ['id', 'title'],
  indexes: [],
  uiQueries: [],
  relations: [],
  readableSchemaVersions: [1],
  identityFields: [],
} as const;

const targetRef = {
  pluginId: 'acme.tasks',
  collectionId: 'tasks',
  schemaVersion: 2,
  contractDigest: 'b'.repeat(43),
} as const;

const daemonTarget = {
  serverIdentityId: 'srv_account_a',
  machineId: 'machine-a',
} as const;

const candidate = {
  release: { pluginId: 'acme.tasks', version: '2.0.0' },
  artifactDigest: `sha256:${'c'.repeat(64)}`,
  origin: {
    serverIdentityId: daemonTarget.serverIdentityId,
    materializationRef: {
      pluginId: 'acme.tasks',
      machineId: daemonTarget.machineId,
      materializationId: 'materialization-target-a',
    },
  },
  collectionContracts: [targetRef],
} as const;

const binding = {
  source: {
    pluginId: sourceContract.pluginId,
    collectionId: sourceContract.collectionId,
    schemaVersion: sourceContract.schemaVersion,
    contractDigest: sourceContract.contractDigest,
  },
  target: targetRef,
  candidate: {
    releaseVersion: candidate.release.version,
    artifactDigest: candidate.artifactDigest,
  },
} as const;

describe('DaemonPluginCollectionCandidatePreparation V1', () => {
  it('binds one exact trusted machine artifact to source contracts without forwarding daemon generation identity', () => {
    const request = {
      version: 1,
      daemonTarget,
      operation: 'prepare',
      source: {
        release: { pluginId: 'acme.tasks', version: '1.0.0' },
        collectionContracts: [sourceContract],
      },
      candidate,
    } as const;

    expect(DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonPluginCollectionCandidatePreparationRequestV1Schema.safeParse({
      ...request,
      candidate: {
        ...candidate,
        immutableGenerationId: 'forged-daemon-generation',
      },
    }).success).toBe(false);
    expect(DaemonPluginCollectionCandidatePreparationRequestV1Schema.safeParse({
      ...request,
      candidate: {
        ...candidate,
        origin: {
          ...candidate.origin,
          materializationRef: {
            ...candidate.origin.materializationRef,
            machineId: 'machine-b',
          },
        },
      },
    }).success).toBe(false);

    expect(DaemonPluginCollectionCandidatePreparationResponseV1Schema.parse({
      version: 1,
      kind: 'prepared',
      bindings: [binding],
    })).toEqual({
      version: 1,
      kind: 'prepared',
      bindings: [binding],
    });
  });

  it('allows retained stage retirement without requiring the candidate module to remain executable', () => {
    const request = {
      version: 1,
      daemonTarget,
      operation: 'retire',
      bindings: [binding],
    } as const;

    expect(DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonPluginCollectionCandidatePreparationResponseV1Schema.parse({
      version: 1,
      kind: 'retired',
    })).toEqual({ version: 1, kind: 'retired' });
  });
});
