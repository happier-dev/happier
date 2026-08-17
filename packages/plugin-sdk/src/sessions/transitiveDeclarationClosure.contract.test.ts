import { describe, expect, expectTypeOf, it } from 'vitest';
import * as agents from '@happier-dev/agents';
import * as protocol from '@happier-dev/protocol';
import type {
    HappierStructuredInputV1 as ProtocolHappierStructuredInputV1,
} from '@happier-dev/protocol/runtime';
import type {
    GenericSubAgentToolNameAlias,
} from '@happier-dev/protocol/tools/v2/subAgentFamilies';
import type {
    BuildSessionWorkflowActivityHeadlineInput as ProtocolBuildSessionWorkflowActivityHeadlineInput,
    ResolveSessionWorkStatePrimaryOptions as ProtocolResolveSessionWorkStatePrimaryOptions,
    SessionWorkStateTruncationV1 as ProtocolSessionWorkStateTruncationV1,
} from '@happier-dev/protocol/sessions/work-state';
import type {
    PluginUiJsonValueV1 as ProtocolPluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    readHappierStructuredInputV1FromMeta,
    resolveTranscriptBodySessionMessageRole,
    type HappierStructuredInputV1,
} from '../services/sessions.js';
import { deriveExternalSessionActivity } from './external.js';
import { isGenericSubagentToolName } from './subagents.js';
import {
    buildSessionWorkflowActivityHeadline,
    resolveSessionWorkStatePrimaryItemId,
    type BuildSessionWorkflowActivityHeadlineInput,
    type ResolveSessionWorkStatePrimaryOptions,
    type SessionWorkStateTruncationV1,
} from './workState.js';
import {
    defineHostedWebBridgeMessage,
    type PluginUiJsonValueV1,
} from '../ui/hostedWeb.js';

if (false) {
/* @sdk-negative-type-case:src-sessions-transitiveDeclarationClosure-contract-test-ts-102:LS0gdGhlIGhlbHBlciBhY2NlcHRzIGFuIGlubGluZSBhdXRob3Igc2hhcGUsIG5vdCBhIHByaXZhdGUgUHJvdG9jb2wgaW5wdXQgY2Fycmllci4:dHlwZSBQcml2YXRlVHJhbnNjcmlwdFJvbGVJbnB1dCA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5SZXNvbHZlVHJhbnNjcmlwdEJvZHlTZXNzaW9uTWVzc2FnZVJvbGVJbnB1dDs */
type PrivateTranscriptRoleInput = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-transitiveDeclarationClosure-contract-test-ts-103:LS0gdGhlIGhlbHBlcidzIGJvdW5kZWQgcHJvdG9jb2wgbGl0ZXJhbHMgZG8gbm90IG5lZWQgYSBzZWNvbmQgbmFtZWQgYXV0aG9yIHR5cGUu:dHlwZSBQcml2YXRlVHJhbnNjcmlwdFByb3RvY29sID0gaW1wb3J0KCcuLi9zZXJ2aWNlcy9zZXNzaW9ucy5qcycpLlRyYW5zY3JpcHRCb2R5U2Vzc2lvbk1lc3NhZ2VQcm90b2NvbDs */
type PrivateTranscriptProtocol = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-transitiveDeclarationClosure-contract-test-ts-104:LS0gSlNPTi1zY2hlbWEgY29udmVyc2lvbiByZXR1cm5zIHRoZSBwdWJsaWMgcmVhZG9ubHktcmVjb3JkIHNoYXBlIGRpcmVjdGx5Lg:dHlwZSBQcml2YXRlSnNvblNjaGVtYU9iamVjdCA9IGltcG9ydCgnLi4vc2VydmljZXMvc2Vzc2lvbnMuanMnKS5Kc29uU2NoZW1hT2JqZWN0Ow */
type PrivateJsonSchemaObject = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-transitiveDeclarationClosure-contract-test-ts-105:LS0gdGhlIHB1YmxpYyBwcmVkaWNhdGUgc3BlbGxzIG91dCBpdHMgYm91bmRlZCBuYXJyb3dpbmcgd2l0aG91dCBwdWJsaXNoaW5nIHRoZSBjYXNpbmcgcHJlZGVjZXNzb3Iu:dHlwZSBQcml2YXRlR2VuZXJpY1N1YkFnZW50QWxpYXMgPSBpbXBvcnQoJy4vc3ViYWdlbnRzLmpzJykuR2VuZXJpY1N1YkFnZW50VG9vbE5hbWVBbGlhczs */
type PrivateGenericSubAgentAlias = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-sessions-transitiveDeclarationClosure-contract-test-ts-106:LS0gdGhlIHJhdyBkYWVtb24gVjEgYWN0aXZpdHkgY2FycmllciBzdGF5cyBwcml2YXRlOyBvbmx5IHRoZSBjYW5vbmljYWwgY2xhc3NpZmllciBpcyBjdXJhdGVkLg:dHlwZSBQcml2YXRlRXh0ZXJuYWxTZXNzaW9uQWN0aXZpdHkgPSBpbXBvcnQoJy4vZXh0ZXJuYWwuanMnKS5FeHRlcm5hbFNlc3Npb25BY3Rpdml0eVYxOw */
type PrivateExternalSessionActivity = never; /* @sdk-negative-type-case-end */
    void (null as unknown as PrivateTranscriptRoleInput);
    void (null as unknown as PrivateTranscriptProtocol);
    void (null as unknown as PrivateJsonSchemaObject);
    void (null as unknown as PrivateGenericSubAgentAlias);
    void (null as unknown as PrivateExternalSessionActivity);
}

describe('Session and hosted-web transitive declaration closure', () => {
    it('keeps reusable callable contracts nameable through their canonical identities', () => {
        expectTypeOf<ProtocolHappierStructuredInputV1>()
            .toMatchTypeOf<HappierStructuredInputV1>();
        expectTypeOf<SessionWorkStateTruncationV1>()
            .toEqualTypeOf<ProtocolSessionWorkStateTruncationV1>();
        expectTypeOf<BuildSessionWorkflowActivityHeadlineInput>()
            .toEqualTypeOf<ProtocolBuildSessionWorkflowActivityHeadlineInput>();
        expectTypeOf<ResolveSessionWorkStatePrimaryOptions>()
            .toEqualTypeOf<ProtocolResolveSessionWorkStatePrimaryOptions>();
        expectTypeOf<PluginUiJsonValueV1>()
            .toEqualTypeOf<ProtocolPluginUiJsonValueV1>();
    });

    it('keeps private helper shapes inline while preserving canonical runtime behavior', () => {
        expect(readHappierStructuredInputV1FromMeta)
            .toBe(protocol.readHappierStructuredInputV1FromMeta);
        expect(resolveTranscriptBodySessionMessageRole)
            .toBe(protocol.resolveTranscriptBodySessionMessageRole);
        expect(deriveExternalSessionActivity).toBe(agents.deriveExternalSessionActivity);

        expectTypeOf(deriveExternalSessionActivity)
            .returns
            .toEqualTypeOf<protocol.ExternalSessionActivityV1>();

        expectTypeOf(resolveTranscriptBodySessionMessageRole)
            .toEqualTypeOf<(input: Readonly<{
                protocol: 'acp' | 'codex';
                body: unknown;
            }>) => protocol.SessionMessageRole>();
        expectTypeOf(isGenericSubagentToolName)
            .toEqualTypeOf<(toolName: string) => toolName is GenericSubAgentToolNameAlias>();
        expectTypeOf(resolveSessionWorkStatePrimaryItemId)
            .parameter(2)
            .toEqualTypeOf<ProtocolResolveSessionWorkStatePrimaryOptions | undefined>();
        expectTypeOf(buildSessionWorkflowActivityHeadline)
            .parameter(0)
            .toEqualTypeOf<ProtocolBuildSessionWorkflowActivityHeadlineInput>();
        expectTypeOf(defineHostedWebBridgeMessage).toBeFunction();
    });
});
