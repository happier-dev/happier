import type { AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

import type { MachineProvisionerRefusalCodeV1 } from './machine-provisioners/index.js';

type Assert<Condition extends true> = Condition;
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (
  <T>() => T extends Right ? 1 : 2
) ? true : false;

// Provider acquire refusals follow AcquireResult, independently of Home admission codes.
type _SdkRefusalCodesMatchProtocol = Assert<
  IsEqual<MachineProvisionerRefusalCodeV1, Extract<AcquireResultV1, { kind: 'rejected' }>['code']>
>;

// A provider may report its own definite pre-effect refusal without extending a shared enum.
type _SdkAcceptsProviderOwnedRefusal = Assert<
  'provider_plan_required' extends MachineProvisionerRefusalCodeV1 ? true : false
>;
