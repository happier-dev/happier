import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '../purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { resolveSystemToolLaunchPurposeDeclarations } from '../requestAuth/agentPurposeDeclarations';
import type { ActionPurposeBindingAdmissionInput } from '../purposeBindings/teamDirectMaterialAdmission';
import { assertLaunchPurposeDeliverySupported, mergeLaunchPurposeDeclarationSnapshots } from '../requestAuth/agentPurposeDeclarations';
import { materializeQualifiedConnectedAccountLaunchUses } from './materializeQualifiedConnectedAccountLaunchUses';
import { stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

export type ConnectedAccountProcessEnvironment = Readonly<Record<string, string>>;
export type ConnectedAccountProcessEnvironmentMaterialization = Readonly<{
  environment: ConnectedAccountProcessEnvironment;
  secretValues: readonly string[];
}>;
export type ConnectedAccountProcessEnvironmentProducer = (environment: ConnectedAccountProcessEnvironment,
  signal: AbortSignal) => Promise<ConnectedAccountProcessEnvironmentMaterialization>;
type ToolDeclarations = ReturnType<typeof resolveSystemToolLaunchPurposeDeclarations>;
export type SessionConnectedAccountProcessEnvironmentInput = Readonly<{
  sessionId: string;
  requesterAccountId: string;
  environment: ConnectedAccountProcessEnvironment;
  signal: AbortSignal;
}>;
export type SessionConnectedAccountProcessEnvironmentProducer = (input: SessionConnectedAccountProcessEnvironmentInput) => Promise<ConnectedAccountProcessEnvironmentMaterialization>;

/** Selection is captured once by the finite operation. Each actual child
 * process then acquires material through that same admitted purpose subject. */
export async function prepareFiniteConnectedAccountProcessEnvironment(input: Readonly<{
  runtime: Pick<DaemonConnectedAccountPurposeBindingRuntime, 'owner' | 'resolveCurrentSessionPurposeBindingSnapshot' | 'admitActionPurposeBindings'>;
  declarations: ToolDeclarations;
  subject: Omit<ActionPurposeBindingAdmissionInput['subject'], 'consumer' | 'consumers'>;
  signal: AbortSignal;
}>): Promise<Readonly<{ produce: ConnectedAccountProcessEnvironmentProducer; dispose(): void }>> {
  if (!input.declarations.length) return { produce: async environment => ({ environment, secretValues: [] }), dispose() {} };
  const declarations = mergeLaunchPurposeDeclarationSnapshots(input.declarations.map(declaration => declaration.snapshot));
  const selected = await input.runtime.resolveCurrentSessionPurposeBindingSnapshot({
    authorizedPurposes: declarations.authorizedPurposes, signal: input.signal });
  const deliveryByPurpose = new Map(selected.teamResourceSelections.map(entry => [qualifiedPurposeKey(entry.purpose), entry.selection.deliveryMode]));
  assertLaunchPurposeDeliverySupported({ declarations: input.declarations,
    readDeliveryMode: scope => deliveryByPurpose.get(qualifiedPurposeKey(scope.purpose)) ?? null });
  const admission = await input.runtime.admitActionPurposeBindings({
    subject: { ...input.subject, consumer: input.declarations[0]!.consumer,
      consumers: input.declarations.map(declaration => declaration.consumer) },
    purposes: selected.purposes, bindings: selected.bindings, directMaterialOrigins: selected.directMaterialOrigins,
    signal: input.signal,
  });
  if (admission.kind !== 'local') throw new PluginError({ code: 'credential_unavailable',
    message: 'Process credentials require direct material', retryable: false });
  const snapshot = { ...declarations, purposes: selected.purposes, bindings: selected.bindings };
  return {
    async produce(environment, signal) {
      const materialized = await materializeQualifiedConnectedAccountLaunchUses({ connectedAccountsOwner: input.runtime.owner,
        snapshot, exactPurposeBindingSubjectId: admission.lease.subjectId, processEnvironment: environment, signal });
      return { environment: stripUnsetEnvironmentVariables({ ...environment, ...materialized.env }, materialized.unsetEnvKeys),
        secretValues: (snapshot.environmentUses ?? []).map(use => materialized.env[use.environmentKey]).filter((value): value is string => typeof value === 'string' && value.length > 0) };
    },
    dispose: () => admission.lease.dispose(),
  };
}

/** Associated processes consume the Session's admitted selection, including an
 * explicitly unbound choice. They never resolve current Account defaults. */
export async function materializeSessionConnectedAccountProcessEnvironment(input: Readonly<{
  runtime: Pick<DaemonConnectedAccountPurposeBindingRuntime, 'owner' | 'readSessionPurposeBindingSnapshot'>;
  declarations: ToolDeclarations;
  sessionId: string;
  environment: ConnectedAccountProcessEnvironment;
  signal: AbortSignal;
}>): Promise<ConnectedAccountProcessEnvironmentMaterialization> {
  if (!input.declarations.length) return { environment: input.environment, secretValues: [] };
  const admitted = input.runtime.readSessionPurposeBindingSnapshot(input.sessionId);
  if (!admitted) throw new PluginError({ code: 'credential_unavailable',
    message: 'The admitted Session credential binding is unavailable', retryable: false });
  const covered = new Set(admitted.purposes.map(qualifiedPurposeKey));
  const declarations = mergeLaunchPurposeDeclarationSnapshots(input.declarations.map(declaration => declaration.snapshot));
  // A tool added after this Session began has no admitted credential selection.
  const snapshot = { ...declarations, purposes: admitted.purposes, bindings: admitted.bindings,
    environmentUses: declarations.environmentUses?.filter(use => covered.has(qualifiedPurposeKey(use.purpose))),
    environmentUnsetUses: declarations.environmentUnsetUses?.filter(use => covered.has(qualifiedPurposeKey(use.purpose))) };
  const result = await materializeQualifiedConnectedAccountLaunchUses({ connectedAccountsOwner: input.runtime.owner,
    snapshot, exactPurposeBindingSubjectId: admitted.subjectId, sessionId: input.sessionId,
    processEnvironment: input.environment, signal: input.signal });
  return { environment: stripUnsetEnvironmentVariables({ ...input.environment, ...result.env }, result.unsetEnvKeys),
    secretValues: (snapshot.environmentUses ?? []).map(use => result.env[use.environmentKey]).filter((value): value is string => typeof value === 'string' && value.length > 0) };
}
