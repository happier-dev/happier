import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentTerminalSessionStateUpdate } from './agentRuntime/surfaces.js';
import type {
    AcpLoadSessionResultV1,
    BackendSessionLaunchHintsV1,
    BackendSurfaceOperationReceiptV1,
} from './agentRuntime/projections.js';
import type {
    AcpLoadSessionResultV1 as HostAcpLoadSessionResultV1,
    BackendSessionLaunchHintsV1 as HostBackendSessionLaunchHintsV1,
    BackendSurfaceOperationReceiptV1 as HostBackendSurfaceOperationReceiptV1,
} from '@happier-dev/agents';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';

declare const runtimeDescriptor: RuntimeDescriptorV1;

if (false) {
    const runtimeDescriptorUpdate: AgentTerminalSessionStateUpdate = {
        fieldId: 'identity.runtimeDescriptor',
        value: runtimeDescriptor,
    };
    const providerSessionIdUpdate: AgentTerminalSessionStateUpdate = {
        fieldId: 'identity.providerSessionId',
        value: 'provider-session-id',
    };
    /* @sdk-negative-type-case:src-corePublicContract-test-ts-210:dGVybWluYWwgQWdlbnQgbGVhdmVzIGNhbm5vdCB3cml0ZSBvd25lci1wcml2YXRlIFNlc3Npb24gc3RhdGU:Y29uc3Qgb3duZXJQcml2YXRlVGVybWluYWxVcGRhdGU6IEFnZW50VGVybWluYWxTZXNzaW9uU3RhdGVVcGRhdGUgPSB7CgpmaWVsZElkOiAncnVudGltZS5leHRlcm5hbFNlc3Npb25PcGVyYXRpb24nLAogICAgICAgIHZhbHVlOiAncHJpdmF0ZS1vd25lci1zdGF0ZScsCiAgICB9Ow */
const ownerPrivateTerminalUpdate = undefined as never; /* @sdk-negative-type-case-end */
    const identityReceipt: BackendSurfaceOperationReceiptV1 = {
        sessionStateUpdates: [runtimeDescriptorUpdate, providerSessionIdUpdate],
    };
    const identityLaunchHints: BackendSessionLaunchHintsV1 = {
        sessionStateUpdates: [runtimeDescriptorUpdate, providerSessionIdUpdate],
    };
    const identityLoadResult: AcpLoadSessionResultV1 = {
        ok: true,
        value: {
            providerSessionId: 'provider-session-id',
            sessionStateUpdates: [runtimeDescriptorUpdate, providerSessionIdUpdate],
        },
    };
    const hostReceipt: HostBackendSurfaceOperationReceiptV1 = identityReceipt;
    const hostLaunchHints: HostBackendSessionLaunchHintsV1 = identityLaunchHints;
    const hostLoadResult: HostAcpLoadSessionResultV1 = identityLoadResult;
    /* @sdk-negative-type-case:src-corePublicContract-test-ts-211:QWdlbnQgcmVjZWlwdHMgY2Fubm90IHdyaXRlIG93bmVyLXByaXZhdGUgU2Vzc2lvbiBzdGF0ZQ:Y29uc3Qgb3duZXJQcml2YXRlUmVjZWlwdDogQmFja2VuZFN1cmZhY2VPcGVyYXRpb25SZWNlaXB0VjEgPSB7CiAgICAgICAgc2Vzc2lvblN0YXRlVXBkYXRlczogW3sKCmZpZWxkSWQ6ICdydW50aW1lLmV4dGVybmFsU2Vzc2lvbk9wZXJhdGlvbicsCiAgICAgICAgICAgIHZhbHVlOiAncHJpdmF0ZS1vd25lci1zdGF0ZScsCiAgICAgICAgfV0sCiAgICB9Ow */
const ownerPrivateReceipt = undefined as never; /* @sdk-negative-type-case-end */
    /* @sdk-negative-type-case:src-corePublicContract-test-ts-212:QWdlbnQgbGF1bmNoIGhpbnRzIGNhbm5vdCB3cml0ZSBvd25lci1wcml2YXRlIFNlc3Npb24gc3RhdGU:Y29uc3Qgb3duZXJQcml2YXRlTGF1bmNoSGludHM6IEJhY2tlbmRTZXNzaW9uTGF1bmNoSGludHNWMSA9IHsKICAgICAgICBzZXNzaW9uU3RhdGVVcGRhdGVzOiBbewoKZmllbGRJZDogJ3J1bnRpbWUuZXh0ZXJuYWxTZXNzaW9uT3BlcmF0aW9uJywKICAgICAgICAgICAgdmFsdWU6ICdwcml2YXRlLW93bmVyLXN0YXRlJywKICAgICAgICB9XSwKICAgIH07 */
const ownerPrivateLaunchHints = undefined as never; /* @sdk-negative-type-case-end */
    /* @sdk-negative-type-case:src-corePublicContract-test-ts-213:QUNQIGxvYWQgcmVzdWx0cyBjYW5ub3Qgd3JpdGUgb3duZXItcHJpdmF0ZSBTZXNzaW9uIHN0YXRl:Y29uc3Qgb3duZXJQcml2YXRlTG9hZFJlc3VsdDogQWNwTG9hZFNlc3Npb25SZXN1bHRWMSA9IHsKICAgICAgICBvazogdHJ1ZSwKICAgICAgICB2YWx1ZTogewogICAgICAgICAgICBwcm92aWRlclNlc3Npb25JZDogJ3Byb3ZpZGVyLXNlc3Npb24taWQnLAogICAgICAgICAgICBzZXNzaW9uU3RhdGVVcGRhdGVzOiBbewoKZmllbGRJZDogJ3J1bnRpbWUuZXh0ZXJuYWxTZXNzaW9uT3BlcmF0aW9uJywKICAgICAgICAgICAgICAgIHZhbHVlOiAncHJpdmF0ZS1vd25lci1zdGF0ZScsCiAgICAgICAgICAgIH1dLAogICAgICAgIH0sCiAgICB9Ow */
const ownerPrivateLoadResult = undefined as never; /* @sdk-negative-type-case-end */
    void runtimeDescriptorUpdate;
    void providerSessionIdUpdate;
    void ownerPrivateTerminalUpdate;
    void identityReceipt;
    void identityLaunchHints;
    void identityLoadResult;
    void hostReceipt;
    void hostLaunchHints;
    void hostLoadResult;
    void ownerPrivateReceipt;
    void ownerPrivateLaunchHints;
    void ownerPrivateLoadResult;
}

import type { PluginApi } from './activation.js';
import type {
    PluginOperationAvailability,
} from './availability.js';
import type {
    PluginDiagnosticData,
    PluginRemediationData,
} from './diagnostics.js';
/* @sdk-negative-type-case:src-corePublicContract-test-ts-214:LS0gZGlzdHJpYnV0aW9uIGlkZW50aXR5IGlzIG93bmVkIGJ5IHRoZSBpbnN0YWxsZXIvdHJ1c3QgYm91bmRhcnksIG5vdCBwbHVnaW4gYXV0aG9ycy4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaXN0cmlidXRpb25JZGVudGl0eVYxIH0gZnJvbSAnLi9pbmRleC5qcyc7 */
type PluginDistributionIdentityV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-215:LS0gaG9zdCBvcHRpb25hbC1zZWxlY3Rpb24gc3RhdGUgaXMgbm90IGEgcm9vdCBhdXRob3JpbmcgY29uY2VwdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5PcHRpb25hbEFjY2Vzc1NlbGVjdGlvblYxIH0gZnJvbSAnLi9pbmRleC5qcyc7 */
type PluginOptionalAccessSelectionV1 = never; /* @sdk-negative-type-case-end */
import { isPluginError, PluginError } from './errors.js';
import type { PluginErrorData } from './errors.js';
import type {
    AgentRuntimeFactoryContext,
    PluginInvocationContext,
} from './invocation.js';
import type {
    InteractionOptions,
    InteractionTerminalStatusV1,
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1,
    InteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientResultV1,
    InteractionSeverity,
    InteractionsService,
    PresentationService,
    UiWidget,
} from './interactions.js';
import type {
    InteractionTerminalStatusV1 as ProtocolInteractionTerminalStatusV1,
    InteractionTransientApprovalAuthorRequestV1 as ProtocolInteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1 as ProtocolInteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1 as ProtocolInteractionTransientAuthorQuestionV1,
    InteractionTransientAuthorRequestV1 as ProtocolInteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1 as ProtocolInteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1 as ProtocolInteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1 as ProtocolInteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1 as ProtocolInteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1 as ProtocolInteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1 as ProtocolInteractionTransientQuestionsResultV1,
    InteractionTransientResultV1 as ProtocolInteractionTransientResultV1,
} from '@happier-dev/protocol';
import type { Disposable } from './lifecycle.js';
import { isPluginError as rootIsPluginError, PluginError as RootPluginError } from './index.js';
import type {
    Disposable as RootDisposable,
    JsonValue as RootJsonValue,
    PluginApi as RootPluginApi,
    PluginDiagnosticData as RootPluginDiagnosticData,
    PluginErrorData as RootPluginErrorData,
    PluginInvocationContext as RootPluginInvocationContext,
} from './index.js';
import type { PluginServices, PluginServiceId } from './services/index.js';
import type {
    SessionHandle,
    SessionAuthService,
    SessionSendRequest,
    SessionSendResult,
    SessionMediaPublishGeneratedRequest,
    SessionMediaService,
    SessionMediaSourceRoot,
    SessionSummary,
} from './services/sessions.js';
import type {
/* @sdk-negative-type-case:src-corePublicContract-test-ts-216:LS0gcmF3IGludGVyYWN0aW9uIHJlcXVlc3RzIGFyZSBob3N0LXByaXZhdGU7IGF1dGhvcnMgdXNlIGNvbnRleHQudWku:UGx1Z2luU2Vzc2lvbkludGVyYWN0aW9uUmVxdWVzdCw */ SessionHandle as PluginSessionInteractionRequest, /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-217:LS0gcmF3IGludGVyYWN0aW9uIHJlc3VsdHMgYXJlIGhvc3QtcHJpdmF0ZTsgYXV0aG9ycyB1c2UgY29udGV4dC51aS4:UGx1Z2luU2Vzc2lvbkludGVyYWN0aW9uUmVzdWx0LA */ SessionHandle as PluginSessionInteractionResult, /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-218:LS0gcHJlc2VudGF0aW9uIHJlc3VsdCBtZWNoYW5pY3MgYXJlIGhvc3QtcHJpdmF0ZTsgYXV0aG9ycyB1c2UgY29udGV4dC51aS4:UGx1Z2luU2Vzc2lvblByZXNlbnRhdGlvbk9uZVNob3RSZXN1bHQs */ SessionHandle as PluginSessionPresentationOneShotResult, /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-219:LS0gcHJlc2VudGF0aW9uIHJldmlzaW9uIG1lY2hhbmljcyBhcmUgaG9zdC1wcml2YXRlOyBhdXRob3JzIHVzZSBjb250ZXh0LnVpLg:UGx1Z2luU2Vzc2lvblByZXNlbnRhdGlvblN0YXRlZnVsUmVzdWx0LA */ SessionHandle as PluginSessionPresentationStatefulResult, /* @sdk-negative-type-case-end */
} from './services/sessions.js';
import type {
    PluginTestkit,
    PluginTestkitRegistration,
    PluginTestkitRegistrationByFamily,
} from './testing/index.js';
/* @sdk-negative-type-case:src-corePublicContract-test-ts-220:LS0gaG9zdC1lbnJpY2hlZCBkaWFnbm9zdGljIHJlY29yZHMgYXJlIG5vdCBhIHN1cHBvcnRlZCBwcmV2aWV3IHJvb3QgY29uY2VwdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljUmVjb3JkIGFzIFJvb3RQbHVnaW5EaWFnbm9zdGljUmVjb3JkIH0gZnJvbSAnLi9pbmRleC5qcyc7 */
type RootPluginDiagnosticRecord = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-221:LS0gZGlhZ25vc3RpYyBwaXBlbGluZSBzdGFnZXMgYXJlIGhvc3QgbGlmZWN5Y2xlIHN0YXRlLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljU3RhZ2UgYXMgUm9vdFBsdWdpbkRpYWdub3N0aWNTdGFnZSB9IGZyb20gJy4vaW5kZXguanMnOw */
type RootPluginDiagnosticStage = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-222:LS0gZGlhZ25vc3RpYyBob3N0IHBsYWNlbWVudCBpcyBob3N0IGxpZmVjeWNsZSBzdGF0ZS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljSG9zdCBhcyBSb290UGx1Z2luRGlhZ25vc3RpY0hvc3QgfSBmcm9tICcuL2luZGV4LmpzJzs */
type RootPluginDiagnosticHost = never; /* @sdk-negative-type-case-end */
import { isPluginError as publicIsPluginError, PluginError as PublicPluginError } from './public/api.js';
import type {
    PluginDiagnosticData as PublicPluginDiagnosticData,
    PluginErrorData as PublicPluginErrorData,
} from './public/api.js';
/* @sdk-negative-type-case:src-corePublicContract-test-ts-223:LS0gaG9zdC1lbnJpY2hlZCBkaWFnbm9zdGljIHJlY29yZHMgYXJlIG5vdCBhIHN1cHBvcnRlZCBwcmV2aWV3IGF1dGhvciBjb25jZXB0Lg:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljUmVjb3JkIGFzIFB1YmxpY1BsdWdpbkRpYWdub3N0aWNSZWNvcmQgfSBmcm9tICcuL3B1YmxpYy9hcGkuanMnOw */
type PublicPluginDiagnosticRecord = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-224:LS0gZGlhZ25vc3RpYyBwaXBlbGluZSBzdGFnZXMgYXJlIGhvc3QgbGlmZWN5Y2xlIHN0YXRlLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljU3RhZ2UgYXMgUHVibGljUGx1Z2luRGlhZ25vc3RpY1N0YWdlIH0gZnJvbSAnLi9wdWJsaWMvYXBpLmpzJzs */
type PublicPluginDiagnosticStage = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-225:LS0gZGlhZ25vc3RpYyBob3N0IHBsYWNlbWVudCBpcyBob3N0IGxpZmVjeWNsZSBzdGF0ZS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljSG9zdCBhcyBQdWJsaWNQbHVnaW5EaWFnbm9zdGljSG9zdCB9IGZyb20gJy4vcHVibGljL2FwaS5qcyc7 */
type PublicPluginDiagnosticHost = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-226:LS0gdGhlIGNhbm9uaWNhbCBlcnJvciB2YWx1ZSBpcyBleHBvcnRlZCBvbmx5IGZyb20gdGhlIHBhY2thZ2Ugcm9vdC4:aW1wb3J0IHsgUGx1Z2luRXJyb3IgYXMgUnVudGltZVBsdWdpbkVycm9yIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
const RuntimePluginError = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-227:LS0gY2Fub25pY2FsIGRpYWdub3N0aWMgZGF0YSBpcyBleHBvcnRlZCBvbmx5IGZyb20gdGhlIHBhY2thZ2Ugcm9vdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljRGF0YSBhcyBSdW50aW1lUGx1Z2luRGlhZ25vc3RpY0RhdGEgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type RuntimePluginDiagnosticData = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-228:LS0gY2Fub25pY2FsIGVycm9yIGRhdGEgaXMgZXhwb3J0ZWQgb25seSBmcm9tIHRoZSBwYWNrYWdlIHJvb3Qu:aW1wb3J0IHR5cGUgeyBQbHVnaW5FcnJvckRhdGEgYXMgUnVudGltZVBsdWdpbkVycm9yRGF0YSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type RuntimePluginErrorData = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-229:LS0gaG9zdC1lbnJpY2hlZCBkaWFnbm9zdGljIHJlY29yZHMgYXJlIG5vdCBhIHN1cHBvcnRlZCBwcmV2aWV3IHJ1bnRpbWUgY29uY2VwdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljUmVjb3JkIGFzIFJ1bnRpbWVQbHVnaW5EaWFnbm9zdGljUmVjb3JkIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type RuntimePluginDiagnosticRecord = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-230:LS0gZGlhZ25vc3RpYyBwaXBlbGluZSBzdGFnZXMgYXJlIGhvc3QgbGlmZWN5Y2xlIHN0YXRlLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljU3RhZ2UgYXMgUnVudGltZVBsdWdpbkRpYWdub3N0aWNTdGFnZSB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type RuntimePluginDiagnosticStage = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-corePublicContract-test-ts-231:LS0gZGlhZ25vc3RpYyBob3N0IHBsYWNlbWVudCBpcyBob3N0IGxpZmVjeWNsZSBzdGF0ZS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5EaWFnbm9zdGljSG9zdCBhcyBSdW50aW1lUGx1Z2luRGlhZ25vc3RpY0hvc3QgfSBmcm9tICcuL3J1bnRpbWUvaW5kZXguanMnOw */
type RuntimePluginDiagnosticHost = never; /* @sdk-negative-type-case-end */
import * as runtimePublicApi from './runtime/index.js';

if (false) {
    const userTextRequest: SessionSendRequest = {
      kind: 'userText',
      text: 'hello',
      idempotencyKey: 'message-1',
    };
/* @sdk-negative-type-case:src-corePublicContract-test-ts-232:LS0gZ2VuZXJpYyBTZXNzaW9uIHNlbmQgc3VwcG9ydHMgb25seSB1c2VyIHRleHQu:Y29uc3QgZXZlbnRSZXF1ZXN0OiBTZXNzaW9uU2VuZFJlcXVlc3QgPSB7IGtpbmQ6ICdldmVudCcsIGV2ZW50SWQ6ICdzZXNzaW9uLmNoYW5nZWQnIH07 */
const eventRequest = undefined as never; /* @sdk-negative-type-case-end */
    /* @sdk-negative-type-case:src-corePublicContract-test-ts-233:LS0gc3RydWN0dXJlZCBtZXNzYWdlcyB1c2UgdGhlaXIgZGVkaWNhdGVkIFVJIG93bmVyLCBub3QgZ2VuZXJpYyBTZXNzaW9uIHNlbmQu:Y29uc3Qgc3RydWN0dXJlZE1lc3NhZ2VSZXF1ZXN0OiBTZXNzaW9uU2VuZFJlcXVlc3QgPSB7CgpraW5kOiAnc3RydWN0dXJlZE1lc3NhZ2UnLAogICAgICAgIG1lc3NhZ2U6IG51bGwsCiAgICAgICAgZGVsaXZlcnk6ICdjb21taXR0ZWQnLAogICAgfTs */
const structuredMessageRequest = undefined as never; /* @sdk-negative-type-case-end */
    const recipientSafeSummary: SessionSummary = {
        id: 'shared-session',
        state: 'idle',
        runtimeAvailability: { status: 'available' },
        storagePolicy: 'optional',
        encryptionMode: 'plain',
        updatedAtMs: 1,
    };
    void userTextRequest;
    void eventRequest;
    void structuredMessageRequest;
    void recipientSafeSummary;
}

void (undefined as unknown as RootPluginDiagnosticRecord);
void (undefined as unknown as RootPluginDiagnosticStage);
void (undefined as unknown as RootPluginDiagnosticHost);
void (undefined as unknown as PublicPluginDiagnosticRecord);
void (undefined as unknown as PublicPluginDiagnosticStage);
void (undefined as unknown as PublicPluginDiagnosticHost);
void (undefined as unknown as RuntimePluginDiagnosticRecord);
void (undefined as unknown as RuntimePluginDiagnosticStage);
void (undefined as unknown as RuntimePluginDiagnosticHost);

describe('CORE.T1/T5 public contract', () => {
    it('keeps activation registration-only and invocation service-bearing', () => {
        expectTypeOf<PluginApi>().not.toHaveProperty('services');
        expectTypeOf<PluginApi>().not.toHaveProperty('config');
        expectTypeOf<PluginInvocationContext>().toHaveProperty('services');
        expectTypeOf<PluginInvocationContext>().toHaveProperty('ui');
        expectTypeOf<InteractionsService['askQuestions']>().parameters.toEqualTypeOf<[
            request: InteractionTransientQuestionsAuthorRequestV1,
            options?: InteractionOptions,
        ]>();
        expectTypeOf<InteractionsService['askQuestions']>().returns
            .toEqualTypeOf<Promise<InteractionTransientQuestionsResultV1>>();
        expectTypeOf<InteractionsService['requestApproval']>().parameters.toEqualTypeOf<[
            request: InteractionTransientApprovalAuthorRequestV1,
            options?: InteractionOptions,
        ]>();
        expectTypeOf<InteractionsService['requestApproval']>().returns
            .toEqualTypeOf<Promise<InteractionTransientApprovalResultV1>>();
        expectTypeOf<InteractionsService['confirm']>().parameters.toEqualTypeOf<[
            request: InteractionTransientConfirmationAuthorRequestV1,
            options?: InteractionOptions,
        ]>();
        expectTypeOf<InteractionsService['confirm']>().returns
            .toEqualTypeOf<Promise<InteractionTransientConfirmationResultV1>>();
        expectTypeOf<PresentationService['notify']>().parameters.toEqualTypeOf<[
            message: string,
            options?: Readonly<{ severity?: 'info' | 'warning' | 'error'; signal?: AbortSignal }>,
        ]>();
        expectTypeOf<InteractionSeverity>().toEqualTypeOf<'info' | 'warning' | 'error'>();
        expectTypeOf<InteractionTerminalStatusV1>()
            .toEqualTypeOf<ProtocolInteractionTerminalStatusV1>();
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>()
            .toEqualTypeOf<ProtocolInteractionTransientApprovalAuthorRequestV1>();
        expectTypeOf<InteractionTransientApprovalResultV1>()
            .toEqualTypeOf<ProtocolInteractionTransientApprovalResultV1>();
        expectTypeOf<InteractionTransientAuthorQuestionV1>()
            .toEqualTypeOf<ProtocolInteractionTransientAuthorQuestionV1>();
        expectTypeOf<InteractionTransientAuthorRequestV1>()
            .toEqualTypeOf<ProtocolInteractionTransientAuthorRequestV1>();
        expectTypeOf<InteractionTransientChoiceSelectionV1>()
            .toEqualTypeOf<ProtocolInteractionTransientChoiceSelectionV1>();
        expectTypeOf<InteractionTransientConfirmationAuthorRequestV1>()
            .toEqualTypeOf<ProtocolInteractionTransientConfirmationAuthorRequestV1>();
        expectTypeOf<InteractionTransientConfirmationResultV1>()
            .toEqualTypeOf<ProtocolInteractionTransientConfirmationResultV1>();
        expectTypeOf<InteractionTransientQuestionAnswerV1>()
            .toEqualTypeOf<ProtocolInteractionTransientQuestionAnswerV1>();
        expectTypeOf<InteractionTransientQuestionsAuthorRequestV1>()
            .toEqualTypeOf<ProtocolInteractionTransientQuestionsAuthorRequestV1>();
        expectTypeOf<InteractionTransientQuestionsResultV1>()
            .toEqualTypeOf<ProtocolInteractionTransientQuestionsResultV1>();
        expectTypeOf<InteractionTransientResultV1>()
            .toEqualTypeOf<ProtocolInteractionTransientResultV1>();
        expectTypeOf<InteractionsService>().toMatchTypeOf<{
            requestApproval(
                request: InteractionTransientApprovalAuthorRequestV1,
                options?: InteractionOptions,
            ): Promise<InteractionTransientApprovalResultV1>;
            askQuestions(
                request: InteractionTransientQuestionsAuthorRequestV1,
                options?: InteractionOptions,
            ): Promise<InteractionTransientQuestionsResultV1>;
            confirm(
                request: InteractionTransientConfirmationAuthorRequestV1,
                options?: InteractionOptions,
            ): Promise<InteractionTransientConfirmationResultV1>;
        }>();
        expectTypeOf<PresentationService>().toEqualTypeOf<{
            notify(
                message: string,
                options?: Readonly<{ severity?: InteractionSeverity; signal?: AbortSignal }>,
            ): Promise<void>;
            readonly status: Readonly<{
                set(key: string, text: string | null, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
            }>;
            readonly widget: Readonly<{
                set(key: string, widget: UiWidget | null, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
            }>;
            readonly composer: Readonly<{
                replace(text: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
            }>;
        }>();
        expectTypeOf<InteractionsService>().not.toHaveProperty('notify');
        expectTypeOf<PresentationService>().not.toHaveProperty('requestApproval');
        expectTypeOf<PresentationService>().not.toHaveProperty('actionable');
        expectTypeOf<PresentationService>().not.toHaveProperty('title');
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>().not.toHaveProperty('requestId');
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>().not.toHaveProperty('sessionId');
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>().not.toHaveProperty('requester');
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>().not.toHaveProperty('createdAtMs');
        expectTypeOf<InteractionTransientApprovalAuthorRequestV1>().not.toHaveProperty('expiresAtMs');
        expectTypeOf<InteractionTransientQuestionsAuthorRequestV1>().not.toHaveProperty('requestId');
        expectTypeOf<InteractionTransientConfirmationAuthorRequestV1>().not.toHaveProperty('requestId');
        expectTypeOf<InteractionTransientApprovalResultV1>().not.toHaveProperty('diagnostic');
        expectTypeOf<InteractionTransientQuestionsResultV1>().not.toHaveProperty('generation');
        expectTypeOf<InteractionTransientQuestionAnswerV1>().not.toHaveProperty('provider');
        expectTypeOf<SessionSendRequest>().not.toHaveProperty('clientRequestId');
        expectTypeOf<SessionSendResult>().not.toHaveProperty('receiptId');
        expectTypeOf<SessionSendResult>().not.toHaveProperty('replayed');
        expectTypeOf<AgentRuntimeFactoryContext>().toHaveProperty('agent');
        expectTypeOf<AgentRuntimeFactoryContext>().not.toHaveProperty('services');
        expectTypeOf<Disposable['dispose']>().toBeFunction();
    });

    it('keeps static registration generation-owned without unregister handles', () => {
        expectTypeOf<PluginApi['actions']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['agents']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['hooks']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['events']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['notifications']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['connectedAccounts']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['providers']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['scm']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['mcp']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['voiceProviders']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['composerReferences']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['composerAttachments']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['resources']>().not.toHaveProperty('unregister');
        expectTypeOf<PluginApi['backgroundServices']>().not.toHaveProperty('unregister');

        expectTypeOf<PluginApi['actions']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['agents']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['hooks']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['events']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['notifications']['registerChannel']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['connectedAccounts']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['providers']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['scm']['registerHostingProvider']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['scm']['registerBackend']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['mcp']['registerServer']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['mcp']['registerDiscoverySource']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['voiceProviders']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['composerReferences']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['composerAttachments']['register']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['resources']['registerPromptAssetAdapter']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['resources']['registerDynamicResource']>().returns.toEqualTypeOf<void>();
        expectTypeOf<PluginApi['backgroundServices']['register']>().returns.toEqualTypeOf<void>();
    });

    it('freezes the exact service roster behind one availability query', () => {
        expectTypeOf<PluginServiceId>().toEqualTypeOf<
            | 'logger'
            | 'storage'
            | 'settings'
            | 'secrets'
            | 'events'
            | 'http'
            | 'fs'
            | 'exec'
            | 'providers'
            | 'managedServices'
            | 'sessions'
            | 'resources'
            | 'mcp'
            | 'notifications'
            | 'connectedAccounts'
            | 'actions'
            | 'targetedContributions'
            | 'interactions'
            | 'composerContent'
        >();
        expectTypeOf<PluginServices['availability']>().toBeFunction();
        expectTypeOf<PluginServices>().toHaveProperty('connectedAccounts');
        expectTypeOf<PluginServices>().toHaveProperty('actions');
        expectTypeOf<PluginServices>().toHaveProperty('targetedContributions');
        expectTypeOf<PluginServices>().toHaveProperty('composerContent');
        expectTypeOf<PluginServices>().toHaveProperty('interactions');
        expectTypeOf<PluginServices>().toHaveProperty('managedServices');
        expectTypeOf<PluginServices>().toHaveProperty('providers');
        expectTypeOf<PluginServices>().toHaveProperty('http');
        expectTypeOf<PluginServices>().not.toHaveProperty('fetch');
        expectTypeOf<PluginServices>().not.toHaveProperty('projects');
        expectTypeOf<PluginServices>().not.toHaveProperty('permissions');
        expectTypeOf<PluginServices['sessions']>().toHaveProperty('external');
        expectTypeOf<SessionHandle>().toHaveProperty('media');
        expectTypeOf<SessionHandle['auth']>().toEqualTypeOf<SessionAuthService>();
        expectTypeOf<SessionAuthService['services']['refreshRuntimeAuth']>().parameter(0).not.toHaveProperty('agentId');
        expectTypeOf<SessionHandle['media']>().toEqualTypeOf<SessionMediaService>();
        expectTypeOf<SessionMediaService['registerSourceRoot']>().parameters.toEqualTypeOf<[
            request: Readonly<{ rootPath: string }>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ]>();
        expectTypeOf<SessionMediaService['registerSourceRoot']>().returns.resolves.toEqualTypeOf<SessionMediaSourceRoot>();
        expectTypeOf<SessionMediaSourceRoot['publishGenerated']>().parameter(0).toEqualTypeOf<SessionMediaPublishGeneratedRequest>();
        expectTypeOf<SessionMediaSourceRoot['publishGenerated']>().parameter(1).toEqualTypeOf<
            Readonly<{ signal?: AbortSignal }> | undefined
        >();
        expectTypeOf<SessionMediaSourceRoot['dispose']>().returns.toBeVoid();
        expectTypeOf<SessionHandle>().not.toHaveProperty('interactions');
        expectTypeOf<SessionHandle>().not.toHaveProperty('presentation');
        expect(Object.hasOwn(
            runtimePublicApi,
            'MAX_PLUGIN_NOTIFICATION_IDEMPOTENCY_RECORDS',
        )).toBe(false);
        expect(Object.hasOwn(
            runtimePublicApi,
            'MAX_PLUGIN_SESSION_INTERACTION_IDEMPOTENCY_RECORDS',
        )).toBe(false);
        expect(Object.hasOwn(
            runtimePublicApi,
            'PLUGIN_SESSION_INTERACTION_IDEMPOTENCY_RETENTION_MS',
        )).toBe(false);
    });

    it('uses one availability, policy, diagnostic, and error vocabulary', () => {
        expectTypeOf<RootJsonValue>().toEqualTypeOf<import('./identity.js').JsonValue>();
        expectTypeOf<RootDisposable>().toEqualTypeOf<Disposable>();
        expectTypeOf<RootPluginApi>().toEqualTypeOf<PluginApi>();
        expectTypeOf<RootPluginInvocationContext>().toEqualTypeOf<PluginInvocationContext>();
        expectTypeOf<RootPluginDiagnosticData>().toEqualTypeOf<PluginDiagnosticData>();
        expectTypeOf<RootPluginErrorData>().toEqualTypeOf<PluginErrorData>();
        expect(RootPluginError).toBe(PluginError);
        expect(rootIsPluginError).toBe(isPluginError);
        expectTypeOf<PluginOperationAvailability>().toMatchTypeOf<
            | { status: 'available' }
            | { status: 'unavailable'; code: string; remediation?: PluginRemediationData }
            | { status: 'denied'; code: string; remediation?: PluginRemediationData }
        >();
        expectTypeOf<PluginDiagnosticData>().not.toHaveProperty('pluginId');
        expectTypeOf<PublicPluginDiagnosticData>().toEqualTypeOf<PluginDiagnosticData>();
        expectTypeOf<PublicPluginErrorData>().toEqualTypeOf<PluginErrorData>();
        expect(PublicPluginError).toBe(PluginError);
        expect(publicIsPluginError).toBe(isPluginError);
        expect(runtimePublicApi).not.toHaveProperty('PluginError');

        const error = new PluginError({
            code: 'service_unavailable',
            retryable: true,
            details: { service: 'http' },
        });
        expect(error).toBeInstanceOf(Error);
        expect(isPluginError(error)).toBe(true);
        expect(error.name).toBe('PluginError');
        expect(error.data).toEqual({
            name: 'PluginError',
            code: 'service_unavailable',
            retryable: true,
            details: { service: 'http' },
        } satisfies PluginErrorData);
    });

    it('keeps installer state private and the daemon-independent testkit state-free', () => {
        void (undefined as unknown as PluginDistributionIdentityV1);
        expectTypeOf<PluginTestkit>().toHaveProperty('registrations');
        expectTypeOf<PluginTestkit>().toHaveProperty('invokeAction');
        expectTypeOf<PluginTestkit>().not.toHaveProperty('installAndTrust');
        expectTypeOf<PluginTestkit>().not.toHaveProperty('inspect');
        expectTypeOf<PluginTestkitRegistration>().toEqualTypeOf<Readonly<{
            family: keyof PluginTestkitRegistrationByFamily;
            localId: string;
        }>>();
    });
});
