import { describe, expectTypeOf, it } from 'vitest';

import type {
  ExternalSessionListCandidatesParamsV1,
  RuntimeTranscriptSourceFacet,
} from '../../index.js';

// @ts-expect-error Rich External Sessions availability is not an Agents public contract.
import type { ExternalSessionAvailabilityRequestV1 } from '../../index.js';
// @ts-expect-error Rich External Sessions runtime context is host-private migration residue.
import type { ExternalSessionRuntimeContextV1 } from '../../index.js';
// @ts-expect-error Child-host candidate services are not an Agents public contract.
import type { ExternalSessionCandidateHostRuntimeServiceV1 } from '../../index.js';
// @ts-expect-error File-follow services are not an Agents public contract.
import type { ExternalSessionFileFollowRuntimeServiceV1 } from '../../index.js';
// @ts-expect-error Transcript-store services are not an Agents public contract.
import type { ExternalSessionTranscriptStoreRuntimeServiceV1 } from '../../index.js';
// @ts-expect-error External Sessions follow paths are not an Agents public contract.
import type { ExternalSessionFollowTranscriptPathResolutionV1 } from '../../index.js';
// @ts-expect-error External Sessions follow leases are not an Agents public contract.
import type { ExternalSessionFollowLeaseV1 } from '../../index.js';

describe('External Sessions Agents public contract', () => {
  it('retains scoped host DTOs and the generic hosted transcript-source follow facet', () => {
    expectTypeOf<ExternalSessionListCandidatesParamsV1>().toBeObject();
    expectTypeOf<NonNullable<RuntimeTranscriptSourceFacet['acquireFollowLease']>>().toBeFunction();
  });
});
