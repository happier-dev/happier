import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, isActionSpecSurfacedOn } from './actionSpecs.js';

/**
 * INV-1 (RU2 surfaces finalization, DEC-2): surface resolution fails CLOSED.
 *
 * `isActionSpecSurfacedOn` is the enablement gate for the whole Action catalog — it backs
 * `createActionExecutor`'s `isActionEnabledBySurface` and both MCP tool bridges. An unknown or
 * missing surface must therefore deny, exactly as the consent layer already resolves
 * (`actionApprovalPolicy.ts#resolveApprovalSurface` treats an unresolvable surface as `ambiguous`
 * and applies the agent floor). Before this contract landed the predicate returned `true` for a
 * nullish surface, so an unattributed caller was admitted to every Action in the catalog.
 *
 * Surface attribution belongs to the host that constructs the executor — see
 * `apps/cli/src/session/actions/createCliActionExecutor.ts` (`?? 'cli'`) and
 * `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts` (`?? 'ui'`).
 */

function createDeps(): ActionExecutorDeps {
  return {
    machinesList: vi.fn(async () => ({ items: [{ id: 'machine-1' }] })),
  } as unknown as ActionExecutorDeps;
}

describe('Action surface resolution fails closed (INV-1 / DEC-2)', () => {
  it('denies a spec on an unknown or missing surface at the predicate', () => {
    const spec = getActionSpec('machines.list');

    // Positive control: the predicate still answers honestly for known surfaces.
    expect(isActionSpecSurfacedOn(spec, 'ui')).toBe(true);
    expect(isActionSpecSurfacedOn(spec, 'agent')).toBe(true);
    expect(isActionSpecSurfacedOn(spec, 'cli')).toBe(false);

    // Fail closed: an unattributed caller is not "surfaced everywhere".
    expect(isActionSpecSurfacedOn(spec, null)).toBe(false);
    expect(isActionSpecSurfacedOn(spec, undefined)).toBe(false);
  });

  it('denies execution when the caller stamps no surface, and admits an attributed one', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    // No context at all — the host forgot to attribute the caller.
    await expect(executor.execute('machines.list', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });
    // An explicitly nullish surface is the same unknown, not a wildcard.
    await expect(executor.execute('machines.list', {}, { surface: null })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });
    expect(deps.machinesList).not.toHaveBeenCalled();

    // A surface the spec does not declare is denied (this already held; it keeps the
    // assertion above from passing for the wrong reason).
    await expect(executor.execute('machines.list', {}, { surface: 'cli' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });

    // A real, declared surface still executes.
    await expect(executor.execute('machines.list', {}, { surface: 'ui' })).resolves.toMatchObject({
      ok: true,
    });
    expect(deps.machinesList).toHaveBeenCalledTimes(1);
  });
});
