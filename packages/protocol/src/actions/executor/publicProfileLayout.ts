import { invalidActionOutputFailure } from './resultProjection.js';
import { throwIfAborted } from '../../abortSignal.js';
import { ArtifactActionOutputSchemasV1 } from '../../artifacts/artifactActionsV1.js';
import { RpcError } from '../../rpc/errors.js';
import { readWidgetActionAccountScopeAdmissionV1 } from '../../widgets/widgetActionScopeV1.js';
import { readWidgetDefinitionArtifactV1, WidgetDefinitionErrorV1 } from '../../widgets/widgetDefinitionArtifactV1.js';
import { compileWidgetAreaPublicProfileLayoutV1, WidgetPublicSnapshotPreparationErrorV1 } from '../../widgets/widgetPublicSnapshotPreparationV1.js';
import type { PublicProfileLayoutV1 } from '../../widgets/widgetPublicSnapshotV1.js';
import type { WidgetAreaLayoutV1 } from '../../widgets/widgetSurfaceArtifactV1.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';

/** Copy selected private placements before review; acknowledged inline editions still support Undo. */
export async function preparePublicProfileLayout(layout: PublicProfileLayoutV1 | WidgetAreaLayoutV1,
  deps: Pick<ActionExecutorDeps, 'widgetAccountScope' | 'artifactAction' | 'widgetCatalog'>,
  context: ActionExecutorContext): Promise<PublicProfileLayoutV1 | ActionExecuteFailure> {
  if (!('surface' in layout)) return layout;
  const admission = readWidgetActionAccountScopeAdmissionV1(deps, layout.surface, context);
  if (!admission.ok) return admission;
  // A readable shared Project/Board does not authorize publishing another Account's selection.
  if (layout.surface.accountId !== admission.scope.accountId) {
    return { ok: false, errorCode: 'account_target_mismatch', error: 'account_target_mismatch' };
  }
  try {
    return await compileWidgetAreaPublicProfileLayoutV1(layout, {
      resolveDefinition: async reference => {
        if (!deps.artifactAction) throw new RpcError('unsupported_action', 'unsupported_action');
        const raw = await deps.artifactAction({ actionId: 'artifact.get', input: { artifactId: reference.artifactId },
          readOnly: true, context, ...(context.signal ? { signal: context.signal } : {}) });
        throwIfAborted(context.signal);
        const refused = readActionFailureEnvelope(raw);
        if (refused) throw new RpcError(refused.error, refused.errorCode);
        const parsed = ArtifactActionOutputSchemasV1['artifact.get'].safeParse(raw);
        if (!parsed.success) throw Object.assign(new Error('invalid_action_output', { cause: invalidActionOutputFailure(parsed.error) }), { code: 'invalid_action_output' });
        const artifact = parsed.data.artifact;
        if (!artifact) return null;
        if (artifact.artifactId !== reference.artifactId || artifact.ownerAccountId !== admission.scope.accountId) {
          throw new RpcError('widget_definition_account_mismatch', 'widget_definition_account_mismatch');
        }
        return readWidgetDefinitionArtifactV1(artifact);
      },
      resolveInstalledView: async identity => {
        if (!deps.widgetCatalog?.readInstalledDescriptor) return null;
        const descriptor = await deps.widgetCatalog.readInstalledDescriptor({ surface: layout.surface,
          definition: { kind: 'installed', surface: identity }, context, ...(context.signal ? { signal: context.signal } : {}) });
        throwIfAborted(context.signal);
        if (descriptor && 'ok' in descriptor) throw new RpcError(descriptor.error, descriptor.errorCode);
        return descriptor;
      },
    });
  } catch (error) {
    if (error instanceof WidgetPublicSnapshotPreparationErrorV1 || error instanceof WidgetDefinitionErrorV1) {
      return { ok: false, errorCode: error.code, error: error.code };
    }
    throw error;
  }
}
