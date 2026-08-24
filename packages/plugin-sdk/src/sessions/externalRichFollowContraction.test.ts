import { describe, expectTypeOf, it } from 'vitest';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    AgentExternalSessionsListCandidatesRequest,
} from './external/index.js';

/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-107:UmljaCBFeHRlcm5hbCBTZXNzaW9ucyBydW50aW1lIGNvbnRleHQgaXMgbm90IGFuIGF1dGhvcmluZyBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25SdW50aW1lQ29udGV4dFYxIH0gZnJvbSAnLi9leHRlcm5hbC9pbmRleC5qcyc7 */
type ExternalSessionRuntimeContextV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-108:Q2hpbGQtaG9zdCBjYW5kaWRhdGUgc2VydmljZXMgYXJlIG5vdCBhbiBhdXRob3JpbmcgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25DYW5kaWRhdGVIb3N0UnVudGltZVNlcnZpY2VWMSB9IGZyb20gJy4vZXh0ZXJuYWwvaW5kZXguanMnOw */
type ExternalSessionCandidateHostRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-109:RmlsZS1mb2xsb3cgc2VydmljZXMgYXJlIG5vdCBhbiBhdXRob3JpbmcgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25GaWxlRm9sbG93UnVudGltZVNlcnZpY2VWMSB9IGZyb20gJy4vZXh0ZXJuYWwvaW5kZXguanMnOw */
type ExternalSessionFileFollowRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-110:VHJhbnNjcmlwdC1zdG9yZSBzZXJ2aWNlcyBhcmUgbm90IGFuIGF1dGhvcmluZyBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25UcmFuc2NyaXB0U3RvcmVSdW50aW1lU2VydmljZVYxIH0gZnJvbSAnLi9leHRlcm5hbC9pbmRleC5qcyc7 */
type ExternalSessionTranscriptStoreRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-111:RXh0ZXJuYWwgU2Vzc2lvbnMgZm9sbG93IHBhdGhzIGFyZSBub3QgYW4gYXV0aG9yaW5nIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25Gb2xsb3dUcmFuc2NyaXB0UGF0aFJlc29sdXRpb25WMSB9IGZyb20gJy4vZXh0ZXJuYWwvaW5kZXguanMnOw */
type ExternalSessionFollowTranscriptPathResolutionV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-externalRichFollowContraction-test-ts-112:RXh0ZXJuYWwgU2Vzc2lvbnMgZm9sbG93IGxlYXNlcyBhcmUgbm90IGFuIGF1dGhvcmluZyBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBFeHRlcm5hbFNlc3Npb25Gb2xsb3dMZWFzZVYxIH0gZnJvbSAnLi9leHRlcm5hbC9pbmRleC5qcyc7 */
type ExternalSessionFollowLeaseV1 = never; /* @sdk-negative-type-case-end */

describe('External Sessions Plugin SDK public contract', () => {
    it('retains the canonical auxiliary contribution and scoped host DTOs', () => {
        expectTypeOf<AgentExternalSessionsContribution>().toBeObject();
        expectTypeOf<AgentExternalSessionObservationContribution>().toBeObject();
        expectTypeOf<AgentExternalSessionsListCandidatesRequest>().toBeObject();
    });
});
