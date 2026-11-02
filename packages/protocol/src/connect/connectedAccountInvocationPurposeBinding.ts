import type { QualifiedConnectedAccountPurposeBindingsV1 } from './connectedAccountPurposeBindings.js';
import type { QualifiedConnectedAccountPurposeV1 } from './connectedAccountPurposeIdentity.js';
import type { QualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';
import type { MachineProvisionerRoleV1 } from '../plugins/contributions/machineProvisioners.js';

/** Host-private accepted-operation boundary; never a wire or persisted authority. */
export type ConnectedAccountInvocationPurposeBinding = Readonly<{
  identity: Readonly<{ pluginId: string; localId: string }>;
  operationId: string;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  isCurrent(): boolean;
  managedOperation?: Readonly<{
    role: MachineProvisionerRoleV1;
    /** Omission is unknown; an explicit null is an admitted unconfigured basis. */
    credentialConfigurations?: readonly Readonly<{ account: QualifiedConnectedAccountRef; revision: string | null }>[];
    isCurrent(role: MachineProvisionerRoleV1): boolean;
  }>;
}>;
