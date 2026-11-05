import type { PluginUiHostApiSurfaceTargetV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiPolicyEvaluationContext, type PluginUiPolicyEvaluationContextInput } from './context';
import type { PluginUiPolicyEvaluationContext } from './evaluate';

type ProjectTarget = Extract<PluginUiHostApiSurfaceTargetV1, { kind: 'project' }>;

/** Facts are projected only from the canonical admitted Project target. */
export function createPluginUiProjectPolicyEvaluationContext(context: PluginUiPolicyEvaluationContextInput,
    target: ProjectTarget | null, previous?: PluginUiPolicyEvaluationContext): PluginUiPolicyEvaluationContext {
    const prior = previous?.data as Readonly<{ project?: Readonly<{ exists: boolean; id?: string; repository?: Readonly<{ kind: string }> }> }> | undefined;
    const sameProject = prior?.project?.exists === (target !== null) && prior.project.id === target?.projectKey
        && prior.project.repository?.kind === target?.repository?.kind;
    const project = sameProject ? prior!.project! : Object.freeze({ exists: target !== null,
        ...(target ? { id: target.projectKey } : {}), ...(target?.repository ? { repository: Object.freeze({ kind: target.repository.kind }) } : {}) });
    const inheritedData = context?.data && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data : undefined;
    const data = sameProject && (inheritedData === undefined || inheritedData === previous?.data)
        ? previous!.data : Object.freeze({ ...inheritedData, project });
    if (previous && previous.data === data && !context) return previous;
    return createPluginUiPolicyEvaluationContext(context, { data });
}
