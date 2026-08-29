/**
 * Account Directory wire contracts are owned by @happier-dev/protocol. This
 * module only keeps short server-local aliases used by route composition; no
 * second parser or codec is maintained here.
 */
export {
    HomeConnectionDescriptorV1Schema,
    AccountDirectoryHomePutRequestV1Schema as AccountDirectoryHomePutRequestSchema,
    AccountDirectoryPreferredHomePatchRequestV1Schema as AccountDirectoryPreferredRequestSchema,
    AccountDirectoryLinkPutRequestV1Schema as AccountDirectoryLinkPutRequestSchema,
    HomeLoginAssertionRequestV1Schema as HomeLoginAssertionRequestSchema,
    HomeLoginAssertionV1Schema,
    HomeLoginRedemptionRequestV1Schema,
    HomeLoginRedemptionResponseV1Schema,
    AccountDirectoryMeResponseV1Schema as AccountDirectoryMeResponseSchema,
    AccountDirectoryHomesResponseV1Schema,
    AccountDirectoryHomePutResponseV1Schema,
    AccountDirectoryHomeDeleteResponseV1Schema,
    AccountDirectoryLinkPutResponseV1Schema,
    AccountDirectoryLinkDeleteResponseV1Schema,
    AccountDirectoryRouteErrorResponseV1Schema,
} from "@happier-dev/protocol";

export type {
    HomeConnectionDescriptorV1,
    AccountDirectoryHomePutRequestV1 as AccountDirectoryHomePutRequest,
    AccountDirectoryPreferredHomePatchRequestV1 as AccountDirectoryPreferredRequest,
    AccountDirectoryLinkPutRequestV1 as AccountDirectoryLinkPutRequest,
    HomeLoginAssertionRequestV1 as HomeLoginAssertionRequest,
    HomeLoginAssertionV1,
    HomeLoginRedemptionResponseV1,
    AccountDirectoryMeResponseV1,
} from "@happier-dev/protocol";
