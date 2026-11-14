import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { SignedProviderBrokerActionRouteGrantV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/composition/executableTypes';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';

export type TeamCredentialBrokerActionRuntime = Pick<ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'targetActionInvocations'
  | 'activateContributionsOnDemand'>;

/** Runs only after the carrier has verified the signed Home admission. */
export function createTeamCredentialBrokerActionExecutor(dependencies: Readonly<{
  withRuntime<T>(read: (runtime: TeamCredentialBrokerActionRuntime) => Promise<T>,
    request: Readonly<{ action: NonNullable<ReturnType<typeof parseQualifiedPluginActionId>>; signal: AbortSignal }>): Promise<T>;
  purposeBindings: Pick<ConnectedAccountPurposeBindingOwner, 'resolveBindingIntentSelection' | 'activatePurposeBindings'>;
}>) {
  return async (request: Readonly<{
    authority: SignedProviderBrokerActionRouteGrantV3;
    input: JsonValue;
    signal: AbortSignal;
  }>): Promise<ActionExecuteResult> => {
    request.signal.throwIfAborted();
    const grant = request.authority.payload;
    const action = parseQualifiedPluginActionId(grant.consumer.actionId);
    if (!action || grant.source.kind === 'provider_connection') {
      throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'resource_unavailable' });
    }
    const source = grant.source;
    return await dependencies.withRuntime(async runtime => {
      const declaration = runtime.contributes.pluginDeclarations?.find(entry => entry.pluginId === action.pluginId);
      const contribution = readResolvedActionContribution(runtime.contributes, action);
      const digest = declaration
        ? computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(declaration.manifest))) : null;
      if (!declaration || !contribution || declaration.manifest.version !== grant.consumer.pluginVersion
        || declaration.manifest.version !== grant.declaration.version || digest !== grant.declaration.manifestDigestSha256) {
        throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'resource_changed' });
      }
      await runtime.activateContributionsOnDemand([{ pluginId: action.pluginId, family: 'actions', localId: action.localId }]);
      const service = source.target.kind === 'account' ? source.target.account.service : source.target.service;
      const selection = await dependencies.purposeBindings.resolveBindingIntentSelection({
        purpose: grant.consumer.purpose, target: source.target, serviceRefs: [service], signal: request.signal,
      });
      request.signal.throwIfAborted();
      const lease = dependencies.purposeBindings.activatePurposeBindings({
        subject: { kind: 'operation', operationId: grant.consumer.operationId, consumer: action,
          isCurrent: () => !request.signal.aborted },
        purposes: [grant.consumer.purpose], bindings: [selection.binding], bindingSelections: [selection],
      });
      try {
        // Home has admitted this exact finite Action. The existing opaque
        // child proof spends that admission without minting another root.
        const context = { surface: 'plugin' as const, authority: 'account_automation' as const,
          signal: request.signal, runtimeAccountId: grant.initiator.accountId,
          actionRequestId: grant.consumer.operationId };
        const approvalContext = { ...context, hostReviewedChild: createHostReviewedChildPortV1({
          actionId: ACTION_INVOKE_ACTION_ID_V1, input: { action, input: request.input }, context, reviewAdmitted: true,
        }) };
        const result = await runtime.targetActionInvocations.invoke({ ...action, input: request.input,
          surface: 'plugin', invocationSurface: 'plugin', invocationAuthority: 'account_automation',
          approvalContext, requestId: grant.consumer.operationId,
          exactPurposeBindingSubjectId: lease.subjectId, signal: request.signal,
        });
        if (result.status === 'executed') return { ok: true, result: result.value ?? null };
        if (result.status === 'deferred') return { ok: true, result: {
          kind: 'approval_request_created', artifactId: result.artifactId, actionId: grant.consumer.actionId,
        } };
        return projectContributedActionFailure({ errorCode: result.code, error: result.message,
          ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
          ...(result.data === undefined ? {} : { data: result.data }),
          ...(result.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: result.actionHandlerInvocation }),
        });
      } finally { lease.dispose(); }
    }, { action, signal: request.signal });
  };
}
