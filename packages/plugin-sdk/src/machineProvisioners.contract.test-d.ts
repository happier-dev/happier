import type { ManagedRefusalCodeV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type * as z from 'zod/mini';

import type { MachineProvisionerRefusalCodeV1 } from './machine-provisioners/index.js';

type Assert<Condition extends true> = Condition;
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (
  <T>() => T extends Right ? 1 : 2
) ? true : false;

// Keep the portable public union identical to the canonical refusal schema.
type _SdkRefusalCodesMatchProtocol = Assert<
  IsEqual<MachineProvisionerRefusalCodeV1, z.infer<typeof ManagedRefusalCodeV1Schema>>
>;
