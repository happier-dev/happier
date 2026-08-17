import { z } from 'zod';

import { PluginMachineExecutionOriginV1Schema } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import { PluginReleaseRefV1Schema } from '../plugins/availability/v1.js';
import {
  NormalizedPluginAccountCollectionContractV1Schema,
  PluginCollectionCandidatePreparationBindingV1Schema,
  PluginCollectionContractRefV1Schema,
} from '../plugins/data/collectionsV1.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';

/**
 * The machine route is a receiver-side identity check, not an artifact or
 * release selector. Prepare additionally carries the caller's already
 * selected exact materialization; retirement deliberately does not, so it
 * can clean an exact retained stage after its candidate becomes non-executable.
 */
const DaemonPluginCollectionCandidatePreparationTargetV1Schema = z.object({
  serverIdentityId: PluginMachineExecutionOriginV1Schema.shape.serverIdentityId,
  machineId: PluginMachineExecutionOriginV1Schema.shape.materializationRef.shape.machineId,
}).strict();

const DaemonPluginCollectionCandidatePreparationSourceV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  collectionContracts: z.array(NormalizedPluginAccountCollectionContractV1Schema).readonly(),
}).strict();

const DaemonPluginCollectionCandidatePreparationCandidateV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  /** Public exact artifact/graph integrity fact; never a daemon generation id. */
  artifactDigest: PluginUiArtifactDigestV1Schema,
  /** Exact trusted machine materialization selected before daemon execution. */
  origin: PluginMachineExecutionOriginV1Schema,
  collectionContracts: z.array(PluginCollectionContractRefV1Schema).readonly(),
}).strict();

function addUniqueCollectionIssues(
  contracts: readonly Readonly<{ collectionId: string }>[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  contracts.forEach((contract, index) => {
    if (seen.has(contract.collectionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'collectionId'],
        message: 'Candidate Collection contracts must name each collection at most once.',
      });
    }
    seen.add(contract.collectionId);
  });
}

const DaemonPluginCollectionCandidatePreparationPrepareRequestV1Schema = z.object({
  version: z.literal(1),
  daemonTarget: DaemonPluginCollectionCandidatePreparationTargetV1Schema,
  operation: z.literal('prepare'),
  source: DaemonPluginCollectionCandidatePreparationSourceV1Schema,
  candidate: DaemonPluginCollectionCandidatePreparationCandidateV1Schema,
}).strict().superRefine((value, context) => {
  if (value.source.release.pluginId !== value.candidate.release.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'release', 'pluginId'],
      message: 'Source and candidate release must belong to one plugin.',
    });
  }
  if (value.candidate.origin.serverIdentityId !== value.daemonTarget.serverIdentityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'origin', 'serverIdentityId'],
      message: 'Candidate origin must match the exact daemon target server identity.',
    });
  }
  if (value.candidate.origin.materializationRef.machineId !== value.daemonTarget.machineId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'origin', 'materializationRef', 'machineId'],
      message: 'Candidate origin must match the exact daemon target machine.',
    });
  }
  if (value.candidate.origin.materializationRef.pluginId !== value.candidate.release.pluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidate', 'origin', 'materializationRef', 'pluginId'],
      message: 'Candidate origin must belong to the candidate release plugin.',
    });
  }
  value.source.collectionContracts.forEach((contract, index) => {
    if (contract.pluginId !== value.source.release.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'collectionContracts', index, 'pluginId'],
        message: 'Source Collection contracts must belong to the source release plugin.',
      });
    }
  });
  value.candidate.collectionContracts.forEach((contract, index) => {
    if (contract.pluginId !== value.candidate.release.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate', 'collectionContracts', index, 'pluginId'],
        message: 'Candidate Collection contracts must belong to the candidate release plugin.',
      });
    }
  });
  addUniqueCollectionIssues(value.source.collectionContracts, ['source', 'collectionContracts'], context);
  addUniqueCollectionIssues(value.candidate.collectionContracts, ['candidate', 'collectionContracts'], context);
});

const DaemonPluginCollectionCandidatePreparationRetireRequestV1Schema = z.object({
  version: z.literal(1),
  daemonTarget: DaemonPluginCollectionCandidatePreparationTargetV1Schema,
  operation: z.literal('retire'),
  bindings: z.array(PluginCollectionCandidatePreparationBindingV1Schema).readonly(),
}).strict();

/**
 * One host-private daemon execution family. It transports only static facts,
 * artifact integrity, and opaque Data-stage bindings; callbacks and daemon
 * immutable generation identity stay in the daemon process.
 */
export const DaemonPluginCollectionCandidatePreparationRequestV1Schema = z.discriminatedUnion(
  'operation',
  [
    DaemonPluginCollectionCandidatePreparationPrepareRequestV1Schema,
    DaemonPluginCollectionCandidatePreparationRetireRequestV1Schema,
  ],
);
export type DaemonPluginCollectionCandidatePreparationRequestV1 = z.infer<
  typeof DaemonPluginCollectionCandidatePreparationRequestV1Schema
>;

export const DaemonPluginCollectionCandidatePreparationResponseV1Schema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      version: z.literal(1),
      kind: z.literal('prepared'),
      bindings: z.array(PluginCollectionCandidatePreparationBindingV1Schema).readonly(),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal('retired'),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal('unavailable'),
      code: z.enum([
        'invalid_request',
        'daemon_target_mismatch',
        'daemon_target_unavailable',
        'candidate_contract_mismatch',
        'candidate_currentness_changed',
        'candidate_preparation_unavailable',
      ]),
    }).strict(),
  ],
);
export type DaemonPluginCollectionCandidatePreparationResponseV1 = z.infer<
  typeof DaemonPluginCollectionCandidatePreparationResponseV1Schema
>;
