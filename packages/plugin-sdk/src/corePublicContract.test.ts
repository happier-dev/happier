import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PluginApi } from './activation.js';
import type {
    PluginOperationAvailability,
    PluginServiceAvailability,
} from './availability.js';
import type {
    PluginDiagnosticData,
    PluginRemediationData,
} from './diagnostics.js';
// @ts-expect-error -- distribution identity is owned by the installer/trust boundary, not plugin authors.
import type { PluginDistributionIdentityV1 } from './index.js';
// @ts-expect-error -- host optional-selection state is not a root authoring concept.
import type { PluginOptionalAccessSelectionV1 } from './index.js';
import { PluginError } from './errors.js';
import type { PluginErrorData } from './errors.js';
import type {
    AgentRuntimeFactoryContext,
    PluginInvocationContext,
    PluginInvocationUi,
    PluginUiApprovalRequest,
    PluginUiApprovalResult,
    PluginUiChoiceAnswer,
    PluginUiQuestion,
    PluginUiQuestionAnswer,
    PluginUiQuestionChoice,
    PluginUiQuestionsResult,
    PluginUiSeverity,
    PluginUiWidget,
} from './invocation.js';
import type { Disposable } from './lifecycle.js';
import { PluginError as RootPluginError } from './index.js';
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
    PluginCurrentSessionService,
    PluginSessionSendRequest,
    PluginSessionSendResult,
    PluginSessionMediaPublishGeneratedRequest,
    PluginSessionMediaService,
    PluginSessionMediaSourceRoot,
} from './services/sessions.js';
import type {
    // @ts-expect-error -- raw interaction requests are host-private; authors use context.ui.
    PluginSessionInteractionRequest,
    // @ts-expect-error -- raw interaction results are host-private; authors use context.ui.
    PluginSessionInteractionResult,
    // @ts-expect-error -- presentation result mechanics are host-private; authors use context.ui.
    PluginSessionPresentationOneShotResult,
    // @ts-expect-error -- presentation revision mechanics are host-private; authors use context.ui.
    PluginSessionPresentationStatefulResult,
} from './services/sessions.js';
import type {
    PluginTestkit,
    PluginTestkitRegistration,
} from './testing/host.js';
// @ts-expect-error -- host-enriched diagnostic records are not a supported preview root concept.
import type { PluginDiagnosticRecord as RootPluginDiagnosticRecord } from './index.js';
// @ts-expect-error -- diagnostic pipeline stages are host lifecycle state.
import type { PluginDiagnosticStage as RootPluginDiagnosticStage } from './index.js';
// @ts-expect-error -- diagnostic host placement is host lifecycle state.
import type { PluginDiagnosticHost as RootPluginDiagnosticHost } from './index.js';
import { PluginError as PublicPluginError } from './public/api.js';
import type {
    PluginDiagnosticData as PublicPluginDiagnosticData,
    PluginErrorData as PublicPluginErrorData,
} from './public/api.js';
// @ts-expect-error -- host-enriched diagnostic records are not a supported preview author concept.
import type { PluginDiagnosticRecord as PublicPluginDiagnosticRecord } from './public/api.js';
// @ts-expect-error -- diagnostic pipeline stages are host lifecycle state.
import type { PluginDiagnosticStage as PublicPluginDiagnosticStage } from './public/api.js';
// @ts-expect-error -- diagnostic host placement is host lifecycle state.
import type { PluginDiagnosticHost as PublicPluginDiagnosticHost } from './public/api.js';
// @ts-expect-error -- the canonical error value is exported only from the package root.
import { PluginError as RuntimePluginError } from './runtime/index.js';
// @ts-expect-error -- canonical diagnostic data is exported only from the package root.
import type { PluginDiagnosticData as RuntimePluginDiagnosticData } from './runtime/index.js';
// @ts-expect-error -- canonical error data is exported only from the package root.
import type { PluginErrorData as RuntimePluginErrorData } from './runtime/index.js';
// @ts-expect-error -- host-enriched diagnostic records are not a supported preview runtime concept.
import type { PluginDiagnosticRecord as RuntimePluginDiagnosticRecord } from './runtime/index.js';
// @ts-expect-error -- diagnostic pipeline stages are host lifecycle state.
import type { PluginDiagnosticStage as RuntimePluginDiagnosticStage } from './runtime/index.js';
// @ts-expect-error -- diagnostic host placement is host lifecycle state.
import type { PluginDiagnosticHost as RuntimePluginDiagnosticHost } from './runtime/index.js';
import * as runtimePublicApi from './runtime/index.js';

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
        expectTypeOf<PluginInvocationUi['askQuestions']>().parameters.toEqualTypeOf<[
            questions: readonly [
                import('./invocation.js').PluginUiQuestion,
                ...import('./invocation.js').PluginUiQuestion[],
            ],
            options?: Readonly<{ title?: string }>,
        ]>();
        expectTypeOf<PluginInvocationUi['requestApproval']>().parameters.toEqualTypeOf<[
            request: PluginUiApprovalRequest,
        ]>();
        expectTypeOf<PluginInvocationUi['confirm']>().parameters.toEqualTypeOf<[
            message: string,
            options?: Readonly<{ title?: string }>,
        ]>();
        expectTypeOf<PluginInvocationUi['notify']>().parameters.toEqualTypeOf<[
            message: string,
            options?: Readonly<{ severity?: 'info' | 'warning' | 'error' }>,
        ]>();
        expectTypeOf<PluginUiSeverity>().toEqualTypeOf<'info' | 'warning' | 'error'>();
        expectTypeOf<PluginUiApprovalRequest>().toEqualTypeOf<Readonly<{
            title: string;
            description?: string;
            subject: Readonly<{
                kind: 'tool';
                name: string;
                input: RootJsonValue;
            }>;
            allowSessionPersistence?: boolean;
        }>>();
        expectTypeOf<PluginUiApprovalResult>().toEqualTypeOf<
            | Readonly<{ status: 'approved'; persistence: 'once' | 'session' }>
            | Readonly<{ status: 'denied'; rationale?: string }>
            | Readonly<{ status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
            | Readonly<{ status: 'unavailable'; diagnostic: PluginDiagnosticData }>
        >();
        expectTypeOf<PluginUiQuestionChoice>().toEqualTypeOf<Readonly<{
            id: string;
            label?: string;
            description?: string;
        }>>();
        expectTypeOf<PluginUiQuestion>().toEqualTypeOf<
            | Readonly<{
                id: string;
                prompt: string;
                type: 'text';
                required?: boolean;
            }>
            | Readonly<{
                id: string;
                prompt: string;
                type: 'single' | 'multiple';
                required?: boolean;
                choices: readonly [
                    PluginUiQuestionChoice,
                    ...PluginUiQuestionChoice[],
                ];
                allowCustom?: boolean;
            }>
        >();
        expectTypeOf<PluginUiChoiceAnswer>().toEqualTypeOf<
            | Readonly<{ type: 'choice'; choiceId: string }>
            | Readonly<{ type: 'custom'; value: string }>
        >();
        expectTypeOf<PluginUiQuestionAnswer>().toEqualTypeOf<
            | Readonly<{ type: 'text'; value: string }>
            | Readonly<{ type: 'single'; answer: PluginUiChoiceAnswer }>
            | Readonly<{
                type: 'multiple';
                answers: readonly [
                    PluginUiChoiceAnswer,
                    ...PluginUiChoiceAnswer[],
                ];
            }>
        >();
        expectTypeOf<PluginUiQuestionsResult>().toEqualTypeOf<
            | Readonly<{
                status: 'answered';
                answers: Readonly<Record<string, PluginUiQuestionAnswer>>;
            }>
            | Readonly<{ status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
            | Readonly<{ status: 'unavailable'; diagnostic: PluginDiagnosticData }>
        >();
        expectTypeOf<PluginInvocationUi>().toEqualTypeOf<{
            requestApproval(request: PluginUiApprovalRequest): Promise<PluginUiApprovalResult>;
            askQuestions(
                questions: readonly [PluginUiQuestion, ...PluginUiQuestion[]],
                options?: Readonly<{ title?: string }>,
            ): Promise<PluginUiQuestionsResult>;
            confirm(
                message: string,
                options?: Readonly<{ title?: string }>,
            ): Promise<boolean>;
            notify(
                message: string,
                options?: Readonly<{ severity?: PluginUiSeverity }>,
            ): Promise<void>;
            readonly status: Readonly<{
                set(key: string, text: string | null): Promise<void>;
            }>;
            readonly widget: Readonly<{
                set(key: string, widget: PluginUiWidget | null): Promise<void>;
            }>;
            readonly title: Readonly<{
                set(title: string | null): Promise<void>;
            }>;
            readonly composer: Readonly<{
                replace(text: string): Promise<void>;
            }>;
        }>();
        expectTypeOf<PluginInvocationUi>().not.toHaveProperty('operationId');
        expectTypeOf<PluginInvocationUi>().not.toHaveProperty('receiptId');
        expectTypeOf<PluginInvocationUi>().not.toHaveProperty('replay');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('requestId');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('providerId');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('sessionId');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('turnId');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('operation');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('persistenceScope');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('allowWorkspacePersistence');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('allowAccountPersistence');
        expectTypeOf<PluginUiApprovalRequest>().not.toHaveProperty('hostAccess');
        expectTypeOf<PluginUiApprovalResult>().not.toHaveProperty('effects');
        expectTypeOf<PluginUiApprovalResult>().not.toHaveProperty('workspace');
        expectTypeOf<PluginUiApprovalResult>().not.toHaveProperty('account');
        expectTypeOf<PluginUiApprovalResult>().not.toHaveProperty('always');
        expectTypeOf<PluginUiQuestion>().not.toHaveProperty('requestId');
        expectTypeOf<PluginUiQuestion>().not.toHaveProperty('operationId');
        expectTypeOf<PluginUiQuestionsResult>().not.toHaveProperty('generation');
        expectTypeOf<PluginUiQuestionAnswer>().not.toHaveProperty('provider');
        expectTypeOf<PluginSessionSendRequest>().not.toHaveProperty('clientRequestId');
        expectTypeOf<PluginSessionSendResult>().not.toHaveProperty('receiptId');
        expectTypeOf<PluginSessionSendResult>().not.toHaveProperty('replayed');
        expectTypeOf<AgentRuntimeFactoryContext>().toHaveProperty('agent');
        expectTypeOf<AgentRuntimeFactoryContext>().not.toHaveProperty('services');
        expectTypeOf<Disposable['dispose']>().toBeFunction();
    });

    it('freezes the exact service roster behind one availability query', () => {
        expectTypeOf<PluginServiceId>().toEqualTypeOf<
            | 'logger'
            | 'storage'
            | 'settings'
            | 'secrets'
            | 'events'
            | 'fetch'
            | 'fs'
            | 'exec'
            | 'managed'
            | 'sessions'
            | 'resources'
            | 'mcp'
            | 'notifications'
            | 'connectedAccounts'
        >();
        expectTypeOf<PluginServices['availability']>().toBeFunction();
        expectTypeOf<PluginServices>().toHaveProperty('connectedAccounts');
        expectTypeOf<PluginServices>().not.toHaveProperty('projects');
        expectTypeOf<PluginServices>().not.toHaveProperty('permissions');
        expectTypeOf<PluginServices['sessions']>().not.toHaveProperty('external');
        expectTypeOf<PluginCurrentSessionService>().toHaveProperty('media');
        expectTypeOf<PluginCurrentSessionService['media']>().toEqualTypeOf<PluginSessionMediaService>();
        expectTypeOf<PluginSessionMediaService['registerSourceRoot']>().returns.resolves.toEqualTypeOf<PluginSessionMediaSourceRoot>();
        expectTypeOf<PluginSessionMediaSourceRoot['publishGenerated']>().parameter(0).toEqualTypeOf<PluginSessionMediaPublishGeneratedRequest>();
        expectTypeOf<PluginSessionMediaSourceRoot['dispose']>().returns.toBeVoid();
        expectTypeOf<PluginCurrentSessionService>().not.toHaveProperty('interactions');
        expectTypeOf<PluginCurrentSessionService>().not.toHaveProperty('presentation');
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
        expectTypeOf<PluginOperationAvailability>().toMatchTypeOf<
            | { status: 'available' }
            | { status: 'unavailable'; code: string; remediation?: PluginRemediationData }
            | { status: 'denied'; code: string; remediation?: PluginRemediationData }
        >();
        expectTypeOf<PluginServiceAvailability>().toMatchTypeOf<PluginOperationAvailability>();
        expectTypeOf<PluginDiagnosticData>().not.toHaveProperty('pluginId');
        expectTypeOf<PublicPluginDiagnosticData>().toEqualTypeOf<PluginDiagnosticData>();
        expectTypeOf<PublicPluginErrorData>().toEqualTypeOf<PluginErrorData>();
        expect(PublicPluginError).toBe(PluginError);
        expect(runtimePublicApi).not.toHaveProperty('PluginError');

        const error = new PluginError({
            code: 'service_unavailable',
            retryable: true,
            details: { service: 'fetch' },
        });
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('PluginError');
        expect(error.data).toEqual({
            name: 'PluginError',
            code: 'service_unavailable',
            retryable: true,
            details: { service: 'fetch' },
        } satisfies PluginErrorData);
    });

    it('keeps installer state private and the daemon-independent testkit state-free', () => {
        void (undefined as unknown as PluginDistributionIdentityV1);
        expectTypeOf<PluginTestkit>().toHaveProperty('registrations');
        expectTypeOf<PluginTestkit>().toHaveProperty('invokeAction');
        expectTypeOf<PluginTestkit>().not.toHaveProperty('installAndTrust');
        expectTypeOf<PluginTestkit>().not.toHaveProperty('inspect');
        expectTypeOf<PluginTestkitRegistration>().toEqualTypeOf<Readonly<{
            family: string;
            localId: string;
        }>>();
    });
});
