import { describe, expectTypeOf, it } from 'vitest';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    ExternalSessionListCandidatesParamsV1,
} from './index.js';

// @ts-expect-error Rich External Sessions runtime context is not an authoring contract.
import type { ExternalSessionRuntimeContextV1 } from './index.js';
// @ts-expect-error Child-host candidate services are not an authoring contract.
import type { ExternalSessionCandidateHostRuntimeServiceV1 } from './index.js';
// @ts-expect-error File-follow services are not an authoring contract.
import type { ExternalSessionFileFollowRuntimeServiceV1 } from './index.js';
// @ts-expect-error Transcript-store services are not an authoring contract.
import type { ExternalSessionTranscriptStoreRuntimeServiceV1 } from './index.js';
// @ts-expect-error External Sessions follow paths are not an authoring contract.
import type { ExternalSessionFollowTranscriptPathResolutionV1 } from './index.js';
// @ts-expect-error External Sessions follow leases are not an authoring contract.
import type { ExternalSessionFollowLeaseV1 } from './index.js';

describe('External Sessions Plugin SDK public contract', () => {
    it('retains the canonical auxiliary contribution and scoped host DTOs', () => {
        expectTypeOf<AgentExternalSessionsContribution>().toBeObject();
        expectTypeOf<AgentExternalSessionObservationContribution>().toBeObject();
        expectTypeOf<ExternalSessionListCandidatesParamsV1>().toBeObject();
    });
});
