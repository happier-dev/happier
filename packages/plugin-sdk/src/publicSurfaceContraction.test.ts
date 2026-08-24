import { describe, expect, it } from 'vitest';

// The supported preview surface intentionally omits unused convenience aliases,
// host-policy vocabulary, and authoring helpers whose source of truth is the
// cold JSON manifest.

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-113:LS0gZGVwcmVjYXRpb24gcmVjb3JkcyBhcmUgZ2VuZXJhdGVkIGNvbnRyYWN0IG1ldGFkYXRhLCBub3QgYSBzdGFuZGFsb25lIHJ1bnRpbWUgYXV0aG9yIHByaW1pdGl2ZS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EZXByZWNhdGlvbkRhdGEgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginDeprecationData = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-114:LS0gbG9jYWxpemVkIG1hbmlmZXN0IGZpZWxkcyBhcmUgb3duZWQgYnkgUGx1Z2luTWFuaWZlc3QgcmF0aGVyIHRoYW4gYSBkdXBsaWNhdGUgcnVudGltZSBhbGlhcy4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Mb2NhbGl6ZWRTdHJpbmcgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginLocalizedString = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-115:LS0gTUNQIGVsaWNpdGF0aW9uIHRyYW5zcG9ydCBEVE9zIGFyZSBub3QgY29uc3VtZWQgYnkgdGhlIHB1YmxpYyBNQ1Agc2VydmljZSBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5NY3BFbGljaXRhdGlvblJlcXVlc3QgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginMcpElicitationRequest = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-116:LS0gTUNQIGVsaWNpdGF0aW9uIHRyYW5zcG9ydCBEVE9zIGFyZSBub3QgY29uc3VtZWQgYnkgdGhlIHB1YmxpYyBNQ1Agc2VydmljZSBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5NY3BFbGljaXRhdGlvblJlc3VsdCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type PluginMcpElicitationResult = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-117:LS0gZmluYWwgcG9saWN5IGV2YWx1YXRpb24gaXMgaG9zdC1vd25lZCBhbmQgaXMgbm90IGEgcnVudGltZSBhdXRob3JpbmcgcmVzdWx0Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Qb2xpY3lSZXN1bHQgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginPolicyResult = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-118:LS0gY2FsbGVycyB1c2UgdGhlIGtpbmQtaW5kZXhlZCBjbGllbnQgaGFuZGxlIHJhdGhlciB0aGFuIGFuIHVuY29ycmVsYXRlZCBjbGllbnQgdW5pb24u:aW1wb3J0IHR5cGUgeyBQbHVnaW5Qcm90b2NvbENsaWVudCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type PluginProtocolClient = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-119:LS0gU0NNIGF1dGhvcnMgaW1wbGVtZW50IHRoZSBjYW5vbmljYWwgU0NNIHJ1bnRpbWUsIG5vdCB0aGUgYWJhbmRvbmVkIGdlbmVyaWMgb3BlcmF0aW9uIG1hcC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TY21PcGVyYXRpb24gfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginScmOperation = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-120:LS0gU0NNIGF1dGhvcnMgaW1wbGVtZW50IHRoZSBjYW5vbmljYWwgU0NNIHJ1bnRpbWUsIG5vdCB0aGUgYWJhbmRvbmVkIGdlbmVyaWMgb3BlcmF0aW9uIG1hcC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TY21PcGVyYXRpb25IYW5kbGVyIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginScmOperationHandler = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-121:LS0gU0NNIGF1dGhvcnMgaW1wbGVtZW50IHRoZSBjYW5vbmljYWwgU0NNIHJ1bnRpbWUsIG5vdCB0aGUgYWJhbmRvbmVkIGdlbmVyaWMgb3BlcmF0aW9uIG1hcC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TY21PcGVyYXRpb25SZXF1ZXN0TWFwIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginScmOperationRequestMap = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-122:LS0gU0NNIGF1dGhvcnMgaW1wbGVtZW50IHRoZSBjYW5vbmljYWwgU0NNIHJ1bnRpbWUsIG5vdCB0aGUgYWJhbmRvbmVkIGdlbmVyaWMgb3BlcmF0aW9uIG1hcC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TY21PcGVyYXRpb25SZXN1bHRNYXAgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginScmOperationResultMap = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-123:LS0gYXV0aG9ycyBuYXJyb3cgdGhlIGNhbm9uaWNhbCBTZXNzaW9uRXZlbnQgdW5pb24gZGlyZWN0bHku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uQWN0aXZpdHlFdmVudCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type PluginSessionActivityEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-124:LS0gYXV0aG9ycyBuYXJyb3cgdGhlIGNhbm9uaWNhbCBTZXNzaW9uRXZlbnQgdW5pb24gZGlyZWN0bHku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uQ2hhbmdlZEV2ZW50IH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionChangedEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-125:LS0gYXV0aG9ycyBuYXJyb3cgdGhlIGNhbm9uaWNhbCBTZXNzaW9uRXZlbnQgdW5pb24gZGlyZWN0bHku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uTWVzc2FnZUVudmVsb3BlIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionMessageEnvelope = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-126:LS0gYXV0aG9ycyBuYXJyb3cgdGhlIGNhbm9uaWNhbCBTZXNzaW9uRXZlbnQgdW5pb24gZGlyZWN0bHku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uTWVzc2FnZUV2ZW50IH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionMessageEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-127:LS0gYXV0aG9ycyBuYXJyb3cgdGhlIGNhbm9uaWNhbCBTZXNzaW9uRXZlbnQgdW5pb24gZGlyZWN0bHku:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uUmVtb3ZlZEV2ZW50IH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionRemovedEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-128:LS0gd29yay1zdGF0ZSBmaWVsZCB2YWx1ZXMgYXJlIGFscmVhZHkgY2FycmllZCBieSBQbHVnaW5TZXNzaW9uV29ya1N0YXRlSXRlbS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uV29ya1N0YXRlT3JpZ2luIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionWorkStateOrigin = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-129:LS0gd29yay1zdGF0ZSBmaWVsZCB2YWx1ZXMgYXJlIGFscmVhZHkgY2FycmllZCBieSBQbHVnaW5TZXNzaW9uV29ya1N0YXRlSXRlbS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uV29ya1N0YXRlU3RhdHVzUmVhc29uIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type PluginSessionWorkStateStatusReason = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-130:LS0gc3RvcmFnZSBzY29wZXMgYXJlIGV4cG9zZWQgYXMgZml4ZWQgc2VydmljZSBwcm9wZXJ0aWVzLCBub3QgYW4gaW5kZXBlbmRlbnQgc2VsZWN0b3Iu:aW1wb3J0IHR5cGUgeyBQbHVnaW5TdG9yYWdlU2NvcGUgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginStorageScope = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-131:LS0gcmVxdWVzdC1hdXRoIGlzIGFuIGlubGluZSBzcGF3bi1vbmx5IGRlc3RpbmF0aW9uLCBub3QgYSBzdGFuZGFsb25lIGF1dGhvciBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmljZVJlcXVlc3RBdXRoIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type ManagedServiceRequestAuth = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-132:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBIQVBQSUVSX0xPQ0FMX1NFUlZJQ0VfRU5WIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type HAPPIER_LOCAL_SERVICE_ENV = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-133:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VDb25maWRlbmNlVjEgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type LocalServiceConfidenceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-134:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VEZWNsYXJhdGlvblYxIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type LocalServiceDeclarationV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-135:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VIYW5kbGVWMSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type LocalServiceHandleV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-136:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VMYXVuY2hWMSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type LocalServiceLaunchV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-137:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VPd25lclNjb3BlZERlY2xhcmF0aW9uVjEgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type LocalServiceOwnerScopedDeclarationV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-138:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VSdW50aW1lU25hcHNob3RWMSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type LocalServiceRuntimeSnapshotV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-139:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBMb2NhbFNlcnZpY2VzUnVudGltZVNlcnZpY2VWMSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type LocalServicesRuntimeServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-140:LS0gdGhlIHJldGlyZWQgTG9jYWwgU2VydmljZXMgbW9kZWwgaXMgcmVwbGFjZWQgYnkgdGhlIHNpbmdsZSBNYW5hZ2VkU2VydmljZXMgY29udHJhY3Qu:aW1wb3J0IHR5cGUgeyBkZWZpbmVMb2NhbFNlcnZpY2UgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type defineLocalService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-141:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVyQ3JlZGVudGlhbCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type ManagedServerCredential = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-142:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVySGFuZGxlIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type ManagedServerHandle = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-143:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVySGVhbHRoQ2hlY2sgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type ManagedServerHealthCheck = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-144:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVyTW9kZSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type ManagedServerMode = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-145:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVyU25hcHNob3QgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type ManagedServerSnapshot = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-146:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVyU3BlYyB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type ManagedServerSpec = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-147:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2VydmVyU3RvcFJlc3VsdCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type ManagedServerStopResult = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-148:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5NYW5hZ2VkU2VydmVyc1NlcnZpY2UgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type PluginManagedServersService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-149:LS0gdGhlIHJldGlyZWQgbWFuYWdlZC1zZXJ2ZXIgZmFjYWRlIGlzIHJlcGxhY2VkIGJ5IHRoZSBzaW5nbGUgTWFuYWdlZFNlcnZpY2VzIGNvbnRyYWN0Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5NYW5hZ2VkU2VydmljZSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type PluginManagedService = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-150:LS0gVm9pY2UgcnVudGltZSBjb250cmFjdHMgbGl2ZSBvbmx5IG9uIC92b2ljZSwgL3ZvaWNlL2NsaWVudCwgYW5kIC92b2ljZS9zcGVlY2gu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyUnVudGltZVJlZ2lzdHJhdGlvbiBhcyBSZXRpcmVkUnVudGltZVZvaWNlUmVnaXN0cmF0aW9uIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type RetiredRuntimeVoiceRegistration = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-151:LS0gdGhlIHByZWRlY2Vzc29yIGNvbnZlcnNhdGlvbiBydW50aW1lIHJlZ2lzdHJhdGlvbiBpcyBub3QgYW4gYWN0aXZhdGlvbiBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyUnVudGltZVJlZ2lzdHJhdGlvbiBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlUnVudGltZSB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceRuntime = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-152:LS0gdGhlIHByZWRlY2Vzc29yIHNwZWVjaCBydW50aW1lIHJlZ2lzdHJhdGlvbiBpcyBub3QgYW4gYWN0aXZhdGlvbiBjb250cmFjdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVNwZWVjaFJ1bnRpbWVSZWdpc3RyYXRpb24gYXMgUmV0aXJlZEFjdGl2YXRpb25TcGVlY2hSdW50aW1lIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationSpeechRuntime = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-153:LS0gVm9pY2Ugc2V0dGluZ3MgY2F0YWxvZyBhY2Nlc3MgaXMgZXhwb3NlZCBieSAvdm9pY2UvY2xpZW50IGFuZCBzZXR0aW5ncyBhY3Rpb25zIHVzZSB0aGUgZ2VuZXJpYyBzZXR0aW5ncyBydW50aW1lLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyU2V0dGluZ3NPcGVyYXRpb25zIGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VTZXR0aW5nc09wZXJhdGlvbnMgfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoiceSettingsOperations = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-154:LS0gcmVhbHRpbWUgY29ubmVjdGlvbiBjb250cmFjdHMgYXJlIG93bmVkIGRpcmVjdGx5IGJ5IC92b2ljZS9jbGllbnQu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJlYWx0aW1lQ29ubmVjdGlvbiBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlQ29ubmVjdGlvbiB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceConnection = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-155:LS0gcmVhbHRpbWUgY2xvc2UgcmVhc29ucyBhcmUgcHJpdmF0ZSBjbG9zdXJlIHR5cGVzIHVuZGVyIC92b2ljZS9jbGllbnQu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUNvbm5lY3Rpb25DbG9zZVJlYXNvbiBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlQ2xvc2VSZWFzb24gfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoiceCloseReason = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-156:LS0gcmVhbHRpbWUgcGxheWJhY2sgbW9kZXMgYXJlIHByaXZhdGUgY2xvc3VyZSB0eXBlcyB1bmRlciAvdm9pY2UvY2xpZW50Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVBsYXliYWNrSW50ZXJydXB0aW9uTW9kZSBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlUGxheWJhY2tNb2RlIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoicePlaybackMode = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-157:LS0gcmVhbHRpbWUgcGxheWJhY2sgcmVzb2x1dGlvbnMgYXJlIHByaXZhdGUgY2xvc3VyZSB0eXBlcyB1bmRlciAvdm9pY2UvY2xpZW50Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVBsYXliYWNrSW50ZXJydXB0aW9uUmVzb2x1dGlvbiBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlUGxheWJhY2tSZXNvbHV0aW9uIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoicePlaybackResolution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-158:LS0gcmVhbHRpbWUgdHJhbnNwb3J0IGV2ZW50cyBhcmUgcHJpdmF0ZSBjbG9zdXJlIHR5cGVzIHVuZGVyIC92b2ljZS9jbGllbnQu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJlYWx0aW1lVHJhbnNwb3J0RXZlbnQgYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZVRyYW5zcG9ydEV2ZW50IH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoiceTransportEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-159:LS0gY29ubmVjdGlvbiBkcml2ZXJzIGFyZSBwcml2YXRlIGNsb3N1cmUgdHlwZXMgdW5kZXIgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUNvbm5lY3Rpb25Ecml2ZXIgYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZUNvbm5lY3Rpb25Ecml2ZXIgfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoiceConnectionDriver = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-160:LS0gUENNIGNhcHR1cmUgZXJyb3JzIGFyZSBwcml2YXRlIGNsb3N1cmUgdHlwZXMgdW5kZXIgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVBjbUNhcHR1cmVFcnJvciBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlUGNtQ2FwdHVyZUVycm9yIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoicePcmCaptureError = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-161:LS0gUENNIGNvbm5lY3Rpb25zIGFyZSBwcml2YXRlIGNsb3N1cmUgdHlwZXMgdW5kZXIgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVBjbUNvbm5lY3Rpb24gYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZVBjbUNvbm5lY3Rpb24gfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoicePcmConnection = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-162:LS0gbWVkaWEtaG9zdCBjb250cmFjdHMgYXJlIG93bmVkIGRpcmVjdGx5IGJ5IC92b2ljZS9jbGllbnQu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUNvbm5lY3Rpb25NZWRpYUhvc3QgYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZU1lZGlhSG9zdCB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceMediaHost = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-163:LS0gbWljcm9waG9uZS1zZXNzaW9uIGNvbnRyYWN0cyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZU1pY1Nlc3Npb24gYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZU1pY1Nlc3Npb24gfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoiceMicSession = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-164:LS0gcmVhbHRpbWUgcHJlZmxpZ2h0IGNvbnRyYWN0cyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJlYWx0aW1lUHJlZmxpZ2h0IGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VQcmVmbGlnaHQgfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoicePreflight = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-165:LS0gcmVhbHRpbWUgcHJlcGFyYXRpb24gY29udHJhY3RzIGFyZSBvd25lZCBkaXJlY3RseSBieSAvdm9pY2UvY2xpZW50Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJlYWx0aW1lUHJlcGFyYXRpb24gYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZVByZXBhcmF0aW9uIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoicePreparation = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-166:LS0gdHVybiBjb250cm9scyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVR1cm5Db250cm9sQWN0aW9uIGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VUdXJuQ29udHJvbCB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceTurnControl = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-167:LS0gY2Fub25pY2FsIHJlYWx0aW1lIGV2ZW50cyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJlYWx0aW1lQ2Fub25pY2FsRXZlbnQgYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZUNhbm9uaWNhbEV2ZW50IH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoiceCanonicalEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-168:LS0gcnVudGltZSBwbGF0Zm9ybSBsaXRlcmFscyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVJ1bnRpbWVQbGF0Zm9ybSBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlUnVudGltZVBsYXRmb3JtIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoiceRuntimePlatform = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-169:LS0gVm9pY2UgdG9vbCBkZWZpbml0aW9ucyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUNsaWVudFRvb2xEZWZpbml0aW9uIGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VUb29sRGVmaW5pdGlvbiB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceToolDefinition = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-170:LS0gbWVkaWF0ZWQgYWNjb3VudCBvcGVyYXRpb25zIGFyZSBvd25lZCBkaXJlY3RseSBieSAvdm9pY2Uu:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUFjY291bnRPcGVyYXRpb25TZXJ2aWNlIGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VBY2NvdW50T3BlcmF0aW9ucyB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceAccountOperations = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-171:LS0gcHJvdmlkZXIgY29udmVyc2F0aW9uIHNlcnZpY2VzIGFyZSBvd25lZCBkaXJlY3RseSBieSAvdm9pY2UvY2xpZW50Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyQ29udmVyc2F0aW9uU2VydmljZSBhcyBSZXRpcmVkQWN0aXZhdGlvblZvaWNlQ29udmVyc2F0aW9uU2VydmljZSB9IGZyb20gJy4vYWN0aXZhdGlvbi5qcyc7 */
type RetiredActivationVoiceConversationService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-172:LS0gaG9zdGVkIGNvbnZlcnNhdGlvbiBzZXJ2aWNlcyBhcmUgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZUhvc3RlZENvbnZlcnNhdGlvblNlcnZpY2UgYXMgUmV0aXJlZEFjdGl2YXRpb25Ib3N0ZWRWb2ljZUNvbnZlcnNhdGlvblNlcnZpY2UgfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationHostedVoiceConversationService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-173:LS0gcHJvdmlkZXIgZXhlY3V0aW9uIGF1dGhvcml0eSBpcyBvd25lZCBkaXJlY3RseSBieSAvdm9pY2UvY2xpZW50Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyRXhlY3V0aW9uQXV0aG9yaXR5IGFzIFJldGlyZWRBY3RpdmF0aW9uVm9pY2VFeGVjdXRpb25BdXRob3JpdHkgfSBmcm9tICcuL2FjdGl2YXRpb24uanMnOw */
type RetiredActivationVoiceExecutionAuthority = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-174:LS0gcmVhbHRpbWUgcHJvdmlkZXIgcHJvdG9jb2wgaXMgb3duZWQgZGlyZWN0bHkgYnkgL3ZvaWNlL2NsaWVudC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyUHJvdG9jb2wgYXMgUmV0aXJlZEFjdGl2YXRpb25Wb2ljZVByb3RvY29sIH0gZnJvbSAnLi9hY3RpdmF0aW9uLmpzJzs */
type RetiredActivationVoiceProtocol = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-175:LS0gL3VpL2NsaWVudCBpcyBib290c3RyYXAtb25seTsgVm9pY2UgY29udHJhY3RzIGxpdmUgdW5kZXIgL3ZvaWNlLyou:aW1wb3J0IHR5cGUgeyBQbHVnaW5Wb2ljZVByb3ZpZGVyUnVudGltZVJlZ2lzdHJhdGlvbiBhcyBSZXRpcmVkVWlDbGllbnRWb2ljZVJ1bnRpbWUgfSBmcm9tICcuL3VpL2NsaWVudC5qcyc7 */
type RetiredUiClientVoiceRuntime = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-176:LS0gZmlsZS1mb2xsb3cgcGF0aCBkaXNjbG9zdXJlIGlzIGhvc3QtcHJpdmF0ZSBvYnNlcnZhdGlvbiBjb21wb3NpdGlvbiwgbm90IEFnZW50IFNESy4:aW1wb3J0IHR5cGUgeyBBZ2VudEV4dGVybmFsU2Vzc2lvbnNSZXNvbHZlRm9sbG93VHJhbnNjcmlwdFBhdGhSZXF1ZXN0IH0gZnJvbSAnLi9zZXNzaW9ucy9pbmRleC5qcyc7 */
type AgentExternalSessionsResolveFollowTranscriptPathRequest = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-177:LS0gZmlsZS1mb2xsb3cgcGF0aCBkaXNjbG9zdXJlIGlzIGhvc3QtcHJpdmF0ZSBvYnNlcnZhdGlvbiBjb21wb3NpdGlvbiwgbm90IEFnZW50IFNESy4:aW1wb3J0IHR5cGUgeyBBZ2VudEV4dGVybmFsU2Vzc2lvbnNSZXNvbHZlRm9sbG93VHJhbnNjcmlwdFBhdGhSZXN1bHQgfSBmcm9tICcuL3Nlc3Npb25zL2luZGV4LmpzJzs */
type AgentExternalSessionsResolveFollowTranscriptPathResult = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-178:LS0gQWdlbnRSdW50aW1lQ29udGV4dCBpcyB0aGUgc29sZSB1bnN1ZmZpeGVkIGludm9jYXRpb24gY29udGV4dC4:aW1wb3J0IHR5cGUgeyBBZ2VudFJ1bnRpbWVJbnZvY2F0aW9uQ29udGV4dCB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentRuntimeInvocationContext = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-179:LS0gY29tcGFjdCByZXF1ZXN0cyBhcmUgdHlwZWQgYnkgQWdlbnRTZXNzaW9uQ29tcGFjdFJlcXVlc3Q7IG5vIHVuY29uc3VtZWQgc2NoZW1hIGFsaWFzIGlzIHB1Ymxpc2hlZC4:aW1wb3J0IHsgQWdlbnRTZXNzaW9uQ29tcGFjdFJlcXVlc3RTY2hlbWEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
const AgentSessionCompactRequestSchema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-180:LS0gcm9sbGJhY2sgcmVjb25jaWxpYXRpb24gcmVzdWx0cyBhcmUgdHlwZWQ7IG5vIHVuY29uc3VtZWQgc2NoZW1hIGFsaWFzIGlzIHB1Ymxpc2hlZC4:aW1wb3J0IHsgQWdlbnRTZXNzaW9uQ29udmVyc2F0aW9uUm9sbGJhY2tSZWNvbmNpbGlhdGlvblJlc3VsdFNjaGVtYSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
const AgentSessionConversationRollbackReconciliationResultSchema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-181:LS0gcm9sbGJhY2sgcmVxdWVzdHMgYXJlIHR5cGVkOyBubyB1bmNvbnN1bWVkIHNjaGVtYSBhbGlhcyBpcyBwdWJsaXNoZWQu:aW1wb3J0IHsgQWdlbnRTZXNzaW9uQ29udmVyc2F0aW9uUm9sbGJhY2tSZXF1ZXN0U2NoZW1hIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
const AgentSessionConversationRollbackRequestSchema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-182:LS0gcm9sbGJhY2sgcmVzdWx0cyBhcmUgdHlwZWQ7IG5vIHVuY29uc3VtZWQgc2NoZW1hIGFsaWFzIGlzIHB1Ymxpc2hlZC4:aW1wb3J0IHsgQWdlbnRTZXNzaW9uQ29udmVyc2F0aW9uUm9sbGJhY2tSZXN1bHRTY2hlbWEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
const AgentSessionConversationRollbackResultSchema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-183:LS0gc2VuZCByZXF1ZXN0cyBhcmUgdHlwZWQ7IG5vIHVuY29uc3VtZWQgc2NoZW1hIGFsaWFzIGlzIHB1Ymxpc2hlZC4:aW1wb3J0IHsgQWdlbnRTZXNzaW9uU2VuZFJlcXVlc3RTY2hlbWEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
const AgentSessionSendRequestSchema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-184:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25Db250ZXh0Q29tcGFjdGlvbkV2ZW50IH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type AgentSessionContextCompactionEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-185:LS0gZGVsaXZlcnkgaXMgYWxyZWFkeSBwYXJ0IG9mIEFnZW50U2Vzc2lvblNlbmRSZXF1ZXN0Lg:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25EZWxpdmVyeSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentSessionDelivery = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-186:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25GaWxlRWRpdEV2ZW50IH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type AgentSessionFileEditEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-187:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25JbnB1dEN1c3RvZHlFdmVudCB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentSessionInputCustodyEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-188:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25JbnB1dERlbGl2ZXJ5RXZlbnQgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type AgentSessionInputDeliveryEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-189:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25MaWZlY3ljbGVFdmVudCB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentSessionLifecycleEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-190:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25PdXRwdXRFdmVudCB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentSessionOutputEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-191:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25UcmFuc2NyaXB0RXZlbnQgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type AgentSessionTranscriptEvent = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-192:LS0gYXV0aG9ycyBuYXJyb3cgQWdlbnRTZXNzaW9uUnVudGltZUV2ZW50IHJhdGhlciB0aGFuIGltcG9ydGluZyBleHRyYWN0ZWQgYWxpYXNlcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25Vc2FnZUV2ZW50IH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type AgentSessionUsageEvent = never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-193:LS0gQWdlbnQgYXV0aG9ycyBzdWJtaXQgc2VtYW50aWMgb2JzZXJ2YXRpb25zOyB0aGUgcGVyc2lzdGVkIFByb3RvY29sIERUTyBpcyBob3N0LXByaXZhdGUu:aW1wb3J0IHR5cGUgeyBQcm92aWRlckFjY291bnRVc2FnZVNuYXBzaG90VjEgfSBmcm9tICcuL2Nsb3VkL3VzYWdlLmpzJzs */
type ProviderAccountUsageSnapshotV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-194:LS0gcGVyc2lzdGVkIGFjY291bnQtdXNhZ2UgdmFsaWRhdGlvbiBiZWxvbmdzIHRvIHRoZSBob3N0IGludGFrZSBib3VuZGFyeS4:aW1wb3J0IHsgUHJvdmlkZXJBY2NvdW50VXNhZ2VTbmFwc2hvdFYxU2NoZW1hIH0gZnJvbSAnLi9jbG91ZC91c2FnZS5qcyc7 */
const ProviderAccountUsageSnapshotV1Schema = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-195:LS0gdGhlIHJhdyBwZXJzaXN0ZWQtaWQgYnVpbGRlciBpcyBub3QgdGhlIEFnZW50IG9ic2VydmF0aW9uIGNvbnRyYWN0Lg:aW1wb3J0IHsgYnVpbGRQcm92aWRlckFjY291bnRVc2FnZVJlY29yZElkIH0gZnJvbSAnLi9jbG91ZC91c2FnZS5qcyc7 */
const buildProviderAccountUsageRecordId = undefined as never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-196:LS0gc2Vzc2lvbi1oZWFkZXIgYWN0aW9ucyBhcmUgY29sZCBQbHVnaW5NYW5pZmVzdCBkYXRhLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5TZXNzaW9uSGVhZGVyQWN0aW9uRGVzY3JpcHRvciB9IGZyb20gJy4vdWkuanMnOw */
type PluginSessionHeaderActionDescriptor = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-197:LS0gc3RydWN0dXJlZC1tZXNzYWdlIGRlc2NyaXB0b3JzIGFyZSBjb2xkIFBsdWdpbk1hbmlmZXN0IGRhdGEu:aW1wb3J0IHR5cGUgeyBTdHJ1Y3R1cmVkTWVzc2FnZUNvbnRyaWJ1dGlvbiBhcyBQbHVnaW5TdHJ1Y3R1cmVkTWVzc2FnZURlc2NyaXB0b3IgfSBmcm9tICcuL3VpLmpzJzs */
type PluginStructuredMessageDescriptor = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-198:LS0gc2Vzc2lvbi1oZWFkZXIgYWN0aW9ucyBhcmUgYXV0aG9yZWQgaW4gdGhlIGNvbGQgbWFuaWZlc3Qu:aW1wb3J0IHsgZGVmaW5lU2Vzc2lvbkhlYWRlckFjdGlvbiB9IGZyb20gJy4vdWkuanMnOw */
const defineSessionHeaderAction = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-199:LS0gc3RydWN0dXJlZCBtZXNzYWdlcyBhcmUgYXV0aG9yZWQgaW4gdGhlIGNvbGQgbWFuaWZlc3Qu:aW1wb3J0IHsgZGVmaW5lU3RydWN0dXJlZE1lc3NhZ2UgfSBmcm9tICcuL3VpLmpzJzs */
const defineStructuredMessage = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-200:LS0gVUkgcGxhY2VtZW50IGRlc2NyaXB0b3JzIGFyZSBhdXRob3JlZCBpbiBQbHVnaW5NYW5pZmVzdCBKU09OLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5TdXJmYWNlUGxhY2VtZW50RGVzY3JpcHRvciB9IGZyb20gJy4vdWkuanMnOw */
type PluginSurfacePlacementDescriptor = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-201:LS0gVUkgdHJhbnNsYXRpb25zIGFyZSBhdXRob3JlZCBpbiBQbHVnaW5NYW5pZmVzdCBKU09OLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5VaVRyYW5zbGF0aW9uc0NvbnRyaWJ1dGlvbiB9IGZyb20gJy4vdWkuanMnOw */
type PluginUiTranslationsContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-202:LS0gaG9zdGVkLXdlYiBjb250cmlidXRpb25zIGFyZSBhdXRob3JlZCBpbiBQbHVnaW5NYW5pZmVzdCBKU09OLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5Ib3N0ZWRXZWJDb250cmlidXRpb24gfSBmcm9tICcuL3VpLmpzJzs */
type PluginHostedWebContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-203:LS0gUmVhY3QgTmF0aXZlIGJ1bmRsZSBjb250cmlidXRpb25zIGFyZSBhdXRob3JlZCBpbiBQbHVnaW5NYW5pZmVzdCBKU09OLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5SZWFjdE5hdGl2ZUJ1bmRsZUNvbnRyaWJ1dGlvbiB9IGZyb20gJy4vdWkuanMnOw */
type PluginReactNativeBundleContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-204:LS0gdGhlIG1hbmlmZXN0IGlzIHRoZSBzb2xlIGlucHV0IGNvbnRyYWN0IGZvciBVSSBzdXJmYWNlIGNvbnRyaWJ1dGlvbnMu:aW1wb3J0IHR5cGUgeyBEZWZpbmVTdXJmYWNlQ29udHJpYnV0aW9uSW5wdXQgfSBmcm9tICcuL3VpLmpzJzs */
type DefineSurfaceContributionInput = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-205:LS0gdGhlIG1hbmlmZXN0IGlzIHRoZSBzb2xlIGF1dGhvcmluZyBwYXRoIGZvciBVSSBzdXJmYWNlIGNvbnRyaWJ1dGlvbnMu:aW1wb3J0IHsgZGVmaW5lU3VyZmFjZUNvbnRyaWJ1dGlvbiB9IGZyb20gJy4vdWkuanMnOw */
const defineSurfaceContribution = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-206:LS0gdGhlIG1hbmlmZXN0IGlzIHRoZSBzb2xlIGF1dGhvcmluZyBwYXRoIGZvciBVSSB0cmFuc2xhdGlvbnMu:aW1wb3J0IHsgZGVmaW5lVWlUcmFuc2xhdGlvbnMgfSBmcm9tICcuL3VpLmpzJzs */
const defineUiTranslations = undefined as never; /* @sdk-negative-type-case-end */

/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-207:LS0gdGhlIGNvbXBpbGVkIGFjdGl2YXRpb24gbW9kdWxlIHNoYXBlIGlzIGhvc3QtaW50ZXJuYWw7IGF1dGhvcnMgdXNlIGRlZmluZVBsdWdpbiguLi4pLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5BY3RpdmF0aW9uTW9kdWxlIH0gZnJvbSAnLi9pbmRleC5qcyc7 */
type PluginActivationModule = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-publicSurfaceContraction-test-ts-208:LS0gdGhlIGNvbXBpbGVkIGFjdGl2YXRpb24gbW9kdWxlIHNoYXBlIGlzIGhvc3QtaW50ZXJuYWwgb24gdGhlIGJyb3dzZXIgcm9vdCB0b28u:aW1wb3J0IHR5cGUgeyBQbHVnaW5BY3RpdmF0aW9uTW9kdWxlIGFzIFBsdWdpbkFjdGl2YXRpb25Nb2R1bGVCcm93c2VyUm9vdCB9IGZyb20gJy4vaW5kZXguYnJvd3Nlci5qcyc7 */
type PluginActivationModuleBrowserRoot = never; /* @sdk-negative-type-case-end */

describe('supported preview surface contraction', () => {
    it('keeps the negative compile contract in the TypeScript program', () => {
        expect(true).toBe(true);
    });
});
