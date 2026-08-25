import { resolve } from 'node:path';

import type { ScmBackendPreference } from '@happier-dev/protocol';

import type { ScmBackendSelection } from './registry';
import type { ScmBackendContext } from './types';
import type { ScmBackendRegistry } from './registry';

export type ResolvedScmSelection = Readonly<{
    selection: ScmBackendSelection;
    context: ScmBackendContext;
}>;

/**
 * Three states, because a detector that could not run is not an answer (`F-SCM-1`):
 *
 * - `selected` — a backend owns this path;
 * - `not_a_repository` — at least one backend looked and it is not a repository of any known kind;
 * - `undetermined` — no backend could look, so nothing is known about this path.
 *
 * Only callers that can render the difference need the third state. `resolveScmSelection` folds it
 * back to `null` for the callers whose contract is "SCM-aware or not", so a machine with no usable
 * SCM tool keeps degrading the way it always has instead of failing their operation outright.
 */
export type ResolvedScmSelectionOutcome =
    | Readonly<{ kind: 'selected'; selection: ScmBackendSelection; context: ScmBackendContext }>
    | Readonly<{ kind: 'not_a_repository' }>
    | Readonly<{ kind: 'undetermined'; error: unknown }>;

export type ResolveScmSelectionInput = Readonly<{
    workingDirectory: string;
    cwd: string;
    backendPreference?: ScmBackendPreference;
    registry: ScmBackendRegistry;
}>;

export async function resolveScmSelectionOutcome(
    input: ResolveScmSelectionInput,
): Promise<ResolvedScmSelectionOutcome> {
    let selection: ScmBackendSelection | null;
    try {
        selection = await input.registry.selectBackend({
            cwd: input.cwd,
            workingDirectory: input.workingDirectory,
            backendPreference: input.backendPreference,
        });
    } catch (error) {
        return { kind: 'undetermined', error };
    }
    if (!selection) {
        return { kind: 'not_a_repository' };
    }

    return {
        kind: 'selected',
        selection,
        context: {
            cwd: input.cwd,
            projectKey: `${resolve(input.workingDirectory)}:${input.cwd}`,
            detection: selection.detection,
        } satisfies ScmBackendContext,
    };
}

export async function resolveScmSelection(
    input: ResolveScmSelectionInput,
): Promise<ResolvedScmSelection | null> {
    const outcome = await resolveScmSelectionOutcome(input);
    return outcome.kind === 'selected'
        ? { selection: outcome.selection, context: outcome.context }
        : null;
}
