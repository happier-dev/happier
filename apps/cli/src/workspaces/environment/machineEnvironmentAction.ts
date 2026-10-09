import axios from 'axios';
import { homedir } from 'node:os';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol';
import { MachineEnvironmentResolveResultV1Schema, MachineEnvironmentReportInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1, refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createProjectNativeInvocationCustody, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { applyMachineEnvironment } from './applyMachineEnvironment';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';

/** Receiving target only. Home owns the exact accessible preset/snapshot;
 * this installed runtime owns process and Account secret custody. */
export function createMachineEnvironmentAction(params: Readonly<{
  apiMachine: ApiMachineClient;
  machineId: string;
  homeId: string;
  installation: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }>;
}>): NonNullable<ActionExecutorDeps['machineEnvironmentApply']> {
  return async ({ input, context, signal }) => {
    const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
    const lifetime = signal ?? context.signal ?? new AbortController().signal;
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    const admission = context.machineAdmission;
    if (!context.externalActionExecutionAuthorization) return fail('admission_unavailable');
    if (admission && (admission.machineId !== params.machineId || admission.installationId !== params.installation.installationId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) return fail('machine_admission_changed');
    const runtime = await params.apiMachine.resolveMachineEnvironmentRuntime({ signal: lifetime,
      ...(admission ? { machineAdmission: admission } : {}),
      ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}) });
    if (!runtime || runtime.machineId !== params.machineId || !runtime.isCurrent || !await runtime.isCurrent()) return fail('target_unavailable');
    const terminalSessions = params.apiMachine.getFiniteTerminalSessions();
    if (!terminalSessions) return fail('target_unavailable');
    const custodianAccountId = readAccountIdFromToken(runtime.credentials.token);
    if (!custodianAccountId || admission && admission.custodianAccountId !== custodianAccountId) return fail('credential_unavailable');
    const requesterAccountId = admission?.actorAccountId ?? custodianAccountId;
    const isCurrent = async () => !lifetime.aborted && await runtime.isCurrent!()
      && (!admission || Boolean(context.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()));
    const request = async (path: string, body: unknown, requestSignal?: AbortSignal): Promise<unknown> => {
      if (!await runtime.isCustodyCurrent()) throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: 'machines.environment.apply', method: 'POST', path, body,
        daemonToken: runtime.credentials.token, serverIdentityId: params.homeId,
        privateKey: params.installation.privateKey, installationId: params.installation.installationId });
      if (!headers.ok) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
      const response = await axios.post<unknown>(`${runtime.serverHttpBaseUrl}${path}`, body, { headers: headers.headers,
        ...(requestSignal ? { signal: requestSignal } : {}), validateStatus: () => true });
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('machine_environment_request_failed'), { code: 'machine_environment_request_failed' });
      return response.data;
    };
    const run = async (operation: ProjectSetupOperationContext): Promise<ActionExecuteResult> => {
      const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
      if (!operationId || !await isCurrent()) return fail(lifetime.aborted ? 'cancelled' : 'admission_unavailable');
      const cancellationSignal = AbortSignal.any([operation.signal, lifetime]);
      const custody = createProjectNativeInvocationCustody(operation);
      let secretContext: ReturnType<typeof createInvocationSavedSecretOperationContextV1> | undefined;
      let managedId: string | undefined;
      const report = async (state: 'running' | 'succeeded' | 'failed', errorCode?: string) => {
        if (!managedId) return;
        await request('/v1/machines/environment/report', MachineEnvironmentReportInputV1Schema.parse({ ...input, managedId, state,
          operation: { operationId }, ...(errorCode ? { errorCode } : {}) }));
      };
      try {
        const resolved = MachineEnvironmentResolveResultV1Schema.parse(await request('/v1/machines/environment/resolve', input, cancellationSignal));
        managedId = resolved.managedId;
        await report('running');
        let secretEnvironment: Parameters<typeof applyMachineEnvironment>[0]['secretEnvironment'];
        if (resolved.environment.setupScript && resolved.environment.secretRefs) {
          const snapshot = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
            credentials: runtime.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
            shouldCommit: () => !cancellationSignal.aborted }));
          if (snapshot.source !== 'network' || !await isCurrent()) throw Object.assign(new Error('saved_secret_unavailable'), { code: 'saved_secret_unavailable' });
          secretContext = createInvocationSavedSecretOperationContextV1({ credentials: runtime.credentials, snapshot,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, isCurrent });
          const references = listSecretReferenceOverlayV1BindingNames(resolved.environment.secretRefs)
            .map(name => readSecretReferenceOverlayV1Reference(resolved.environment.secretRefs!, name)!);
          const secrets = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: resolveAccountSettingsScopeKeyForToken(runtime.credentials.token),
            references, operationContext: secretContext, signal: cancellationSignal });
          if (!await isCurrent()) throw Object.assign(new Error('saved_secret_unavailable'), { code: 'saved_secret_unavailable' });
          secretEnvironment = { accountSettings: secrets.settings, settingsSecretsReadKeys: secrets.settingsSecretsReadKeys,
            savedSecretResources: secrets.savedSecretResources };
        }
        if (!await isCurrent()) throw Object.assign(new Error('machine_admission_changed'), { code: 'machine_admission_changed' });
        const io = createProjectNativeIo().environmentIo.createInvocation({ signal: cancellationSignal, retainCapture: custody.retain });
        const result = await applyMachineEnvironment({ homeId: input.homeId, machineId: input.machineId,
          preset: { id: input.presetId, revision: input.presetRevision }, requesterAccountId, userHomeDirectory: homedir(),
          environment: resolved.environment, operation, signal: cancellationSignal, terminalSessions,
          isCurrent,
          environmentIo: io, ...(secretEnvironment ? { secretEnvironment } : {}), ...(managedId ? { managedId } : {}),
          terminalCustody: { kind: 'machine', serverId: params.homeId, machineId: params.machineId,
            installationId: params.installation.installationId, requesterAccountId, rootPath: homedir() } });
        await custody.release();
        // An unconfirmed physical outcome is retained by the same finite
        // owner; it is not a failed creation stage or permission to retry.
        if (!result.ok && (result.errorCode === 'outcome_uncertain' || result.errorCode === 'stop_unconfirmed')) return result;
        await report(result.ok ? 'succeeded' : 'failed', result.ok ? undefined : result.errorCode);
        return result;
      } catch (error) {
        // Capture release waits on physical native process settlement, even
        // when cancellation or an uncertain native observation preceded it.
        await custody.release();
        const code = cancellationSignal.aborted ? 'cancelled' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'machine_environment_apply_failed';
        try { await report('failed', code); } catch { return fail('machine_environment_report_failed'); }
        return fail(code);
      } finally { custody.dispose(); secretContext?.withdrawCatalog(); }
    };
    const result = context.operationOwnerUpdate ? await run({ ...context, signal: context.signal ?? lifetime, operationOwnerUpdate: context.operationOwnerUpdate,
      operationProgress: context.operationProgress ?? { update() {} } })
      : await params.apiMachine.observeActionExecution({ actionId: 'machines.environment.apply', input, actionRequestId: context.actionRequestId,
        rpcContext: context, execute: run });
    return result.ok ? result.result : result;
  };
}
