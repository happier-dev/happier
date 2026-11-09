import { CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID, CodeIntelligenceActionInputSchema, CodeIntelligenceFileActionInputSchema, CodeIntelligenceRenamePreviewInputSchema } from '../codeIntelligenceActionFamily.js';
import { DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema, DaemonLspApplyResponseSchema, type DaemonLspApplyRequest, type DaemonLspQueryRequest } from '../../machines/languageIntelligence.js';
import { completeActionResult } from './resultProjection.js';
import { getActionSpec, type AdmittedActionInputById } from '../actionSpecs.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import { queryCodeIntelligenceFallback } from '../../machines/codeIntelligenceFallback.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from './coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';



export async function dispatchCode(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'deps' | 'ctx' | 'data'>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, deps, ctx, data } = inv;

        if (actionId === 'code.format.apply' || actionId === 'code.imports.organize') {
          const input = parsed.data as AdmittedActionInputById[typeof actionId];
          const { machineId, operation, ...target } = input;
          if (operation.kind === 'preview') {
            if (!deps.languageIntelligenceQuery) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const request: DaemonLspQueryRequest = { ...target, text: 'disk',
              kind: actionId === 'code.imports.organize' ? 'organizeImports' : 'range' in operation && operation.range ? 'rangeFormatting' : 'formatting',
              ...('range' in operation && operation.range ? { range: operation.range } : {}),
              ...('formattingOptions' in operation && operation.formattingOptions ? { formattingOptions: operation.formattingOptions } : {}) };
            const response = await deps.languageIntelligenceQuery({ machineId, request }, ctx);
            if ('ok' in response && response.ok === false) return completeActionResult(response);
            const output = getActionSpec(actionId).outputSchema?.safeParse(response);
            return output?.success ? completeActionResult(output.data) : { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
          }
          if (!deps.languageIntelligenceApply) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const response = await deps.languageIntelligenceApply({ machineId, actionId,
            request: { ...target, operation: { kind: actionId === 'code.format.apply' ? 'format' : 'organizeImports', files: operation.files } } }, ctx);
          const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
          if (approval.success) return completeActionResult(approval.data);
          if ('ok' in response && response.ok === false && 'errorCode' in response) return completeActionResult(response);
          return completeActionResult(DaemonLspApplyResponseSchema.parse(response));
        }
        if (actionId === 'code.rename.apply' || actionId === 'code.file.rename.apply' || actionId === 'code.codeAction.apply') {
          if (!deps.languageIntelligenceApply) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          let machineId: string, request: DaemonLspApplyRequest;
          if (actionId === 'code.codeAction.apply') {
            const input = parsed.data as AdmittedActionInputById[typeof actionId];
            ({ machineId, ...request } = input);
          } else {
            const { machineId: machine, files, ...target } = parsed.data as AdmittedActionInputById[typeof actionId];
            machineId = machine;
            request = { ...target, operation: { kind: actionId === 'code.rename.apply' ? 'rename' : 'fileRename', files } };
          }
          const response = await deps.languageIntelligenceApply({ machineId, request, actionId }, ctx);
          const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
          if (approval.success) return completeActionResult(approval.data);
          if ('ok' in response && response.ok === false && 'errorCode' in response) return completeActionResult(response);
          return completeActionResult(DaemonLspApplyResponseSchema.parse(response));
        }
        if (actionId === 'code.rename.preview' || actionId === 'code.file.rename.preview' || actionId === 'code.codeActions.list') {
          if (!deps.languageIntelligenceQuery) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          let machineId: string, request: DaemonLspQueryRequest;
          if (actionId === 'code.file.rename.preview') {
            const { machineId: machine, ...target } = parsed.data as AdmittedActionInputById[typeof actionId];
            machineId = machine;
            request = { ...target, kind: 'willRenameFiles', text: 'disk' };
          } else {
            const input = actionId === 'code.rename.preview'
              ? parsed.data as AdmittedActionInputById[typeof actionId]
              : CodeIntelligenceRenamePreviewInputSchema.parse(parsed.data);
            if ((input.symbol === undefined) === (input.character === undefined) || input.occurrence !== undefined && input.symbol === undefined)
              return completeActionResult({ status: 'error', errorCode: 'invalid_position' });
            const { rootPath, path, languageId, newName } = input;
            machineId = input.machineId;
            const position = input.symbol !== undefined ? { line: input.line - 1, symbol: input.symbol, ...(input.occurrence ? { occurrence: input.occurrence } : {}) }
              : { line: input.line - 1, character: input.character! };
            request = { rootPath, path, ...(languageId ? { languageId } : {}), text: 'disk', position,
              kind: actionId === 'code.codeActions.list' ? 'codeActions' : newName === undefined ? 'prepareRename' : 'rename', ...(newName ? { newName } : {}) };
          }
          const response = await deps.languageIntelligenceQuery({ machineId, request }, ctx);
          if ('ok' in response && response.ok === false) return completeActionResult(response);
          const output = getActionSpec(actionId).outputSchema?.safeParse(response);
          return output?.success ? completeActionResult(output.data) : { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
        }
        if (actionId === 'code.restart') {
          if (!deps.languageIntelligenceRestart) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const { machineId, ...request } = parsed.data as AdmittedActionInputById[typeof actionId];
          const response = await deps.languageIntelligenceRestart({ machineId, request }, ctx);
          if ('ok' in response && response.ok === false) return completeActionResult(response);
          return completeActionResult(DaemonLspRestartResponseSchema.parse(response));
        }
        if (actionId in CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID) {
          if (!deps.languageIntelligenceQuery) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          const kind = CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID[actionId as keyof typeof CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID];
          const hierarchy = actionId === 'code.callHierarchy.get' ? parsed.data as AdmittedActionInputById[typeof actionId] : undefined;
          if (hierarchy?.hierarchy.itemId && !hierarchy.serverId)
            return completeActionResult({ status: 'error', errorCode: 'invalid_request' });
          const positional = kind !== 'documentSymbols' && kind !== 'diagnostics' && kind !== 'workspaceSymbol'
            && (kind !== 'callHierarchy' || hierarchy?.hierarchy.direction === 'prepare' || !hierarchy?.hierarchy.itemId);
          const input = CodeIntelligenceFileActionInputSchema.parse({ machineId: data.machineId, rootPath: data.rootPath, path: data.path,
            ...(typeof data.languageId === 'string' ? { languageId: data.languageId } : {}) });
          const { machineId, rootPath, path, languageId } = input;
          let position: DaemonLspQueryRequest['position'];
          if (positional) {
            const address = CodeIntelligenceActionInputSchema.safeParse({ ...input, line: data.line,
              ...(data.symbol !== undefined ? { symbol: data.symbol } : {}), ...(data.character !== undefined ? { character: data.character } : {}),
              ...(data.occurrence !== undefined ? { occurrence: data.occurrence } : {}) });
            if (!address.success) return completeActionResult({ status: 'error', errorCode: 'invalid_position' });
            const operand = address.data;
            if ((operand.symbol === undefined) === (operand.character === undefined)
              || (operand.occurrence !== undefined && operand.symbol === undefined)) {
              return completeActionResult({ status: 'error', errorCode: 'invalid_position' });
            }
            position = operand.symbol !== undefined
              ? { line: operand.line - 1, symbol: operand.symbol, ...(operand.occurrence !== undefined ? { occurrence: operand.occurrence } : {}) }
              : { line: operand.line - 1, character: operand.character! };
          }
          const rawResponse = await deps.languageIntelligenceQuery({ machineId, request: { rootPath, path, kind,
            text: 'disk', ...(position ? { position } : {}), ...(languageId ? { languageId } : {}),
            ...(actionId === 'code.diagnostics.list' ? { scope: (parsed.data as AdmittedActionInputById[typeof actionId]).scope } : {}),
            ...(actionId === 'code.symbols.workspace' ? { query: (parsed.data as AdmittedActionInputById[typeof actionId]).query } : {}),
            ...(hierarchy ? { hierarchy: hierarchy.hierarchy, ...(hierarchy.serverId ? { serverId: hierarchy.serverId } : {}) } : {}),
          } }, ctx);
          if ('ok' in rawResponse && rawResponse.ok === false) return completeActionResult(rawResponse);
          const response = DaemonLspQueryResponseSchema.parse(rawResponse);
          if (response.status === 'unavailable' && response.reason === 'no_capable_server'
            && (kind === 'definition' || kind === 'references') && position && 'symbol' in position && deps.workspaceFilesSearch) {
            const search = deps.workspaceFilesSearch;
            return completeActionResult(await queryCodeIntelligenceFallback({ rootPath, path, kind, line: position.line + 1,
              symbol: position.symbol, ...(languageId ? { languageId } : {}) }, request => search({ machineId, ...request }, ctx)));
          }
          const output = getActionSpec(actionId).outputSchema?.safeParse(response);
          return output?.success ? completeActionResult(output.data)
            : { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
        }
  return null;
}
