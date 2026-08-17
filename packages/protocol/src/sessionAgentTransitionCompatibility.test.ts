import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getActionSpec } from './actions/actionSpecs.js';
import { SESSION_AGENT_TRANSITION_VECTORS as V } from './sessionAgentTransitionVectors.js';
import { SessionForkRpcParamsSchema } from './sessionFork.js';

/**
 * Section 6.7 compatibility directions for the predecessor tree.
 *
 * One direction in the successor's matrix has no protocol-level counterpart
 * here: there is no `MachineOperationProtocolCapabilitiesV1` in this tree, so
 * there is nothing to keep byte-equivalent and no leaf to accidentally add.
 *
 * There is also no `SessionSpawnNewInputV2`. `sourceContext` is carried on the
 * `session.spawn_new` Action input (`SessionSpawnNewInputSchema`, declared
 * inline in `actions/actionSpecs.ts`), which IS `.strict()` — so a daemon that
 * predates the field rejects the operation exactly as the successor does. The
 * daemon-local `SpawnDaemonSessionRequestCompatSchema` beneath it is a plain
 * `z.object`, but it is not the ingress a client sends `sourceContext` on. The
 * pre-send `session.continuation.inspect` call remains the primary defence — a
 * daemon predating `sourceContext` also predates that operation — with that
 * strict rejection as the backstop; the direction is covered below.
 */

/** The strategy vocabulary as released, before `native` existed. */
const ReleasedForkStrategySchema = z.enum([
  'auto',
  'provider_native',
  'acp_fork_latest',
  'replay',
]);

const ReleasedForkRpcParamsSchema = SessionForkRpcParamsSchema.safeExtend({
  strategy: ReleasedForkStrategySchema.optional(),
});

describe('compat — new client + old daemon, generic native fork intent', () => {
  it('is rejected outright rather than downgraded to a Replay fork', () => {
    const request = V.fork.valid.nativeIntent;

    expect(SessionForkRpcParamsSchema.safeParse(request).success).toBe(true);

    // The enum sits inside a `.strict()` params object, so a daemon that
    // predates `native` refuses the request. There is no path where the user
    // asks for Native and silently receives a Replay fork.
    expect(ReleasedForkRpcParamsSchema.safeParse(request).success).toBe(false);
  });
});

describe('compat — old client + new daemon, fork', () => {
  it('still accepts a fork request with neither strategy nor requestId', () => {
    expect(
      SessionForkRpcParamsSchema.safeParse({
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
      }).success,
    ).toBe(true);
  });

  it('keeps the native coalescing key this tree already ships', () => {
    expect(SessionForkRpcParamsSchema.safeParse(V.fork.valid.withRequestId).success).toBe(true);
    expect(SessionForkRpcParamsSchema.safeParse(V.fork.invalid.blankRequestId).success).toBe(false);
  });
});

describe('compat — sourceContext on the session.spawn_new Action input', () => {
  const spawnNewInputSchema = getActionSpec('session.spawn_new').inputSchema;

  it('accepts the closed source recipe on the current input', () => {
    const parsed = spawnNewInputSchema.safeParse({
      directory: '/repo',
      agentId: 'claude',
      sourceContext: V.sourceContext.valid.exactSeq,
    });
    expect(parsed.success).toBe(true);
  });

  it('is refused outright by a daemon that predates the field', () => {
    // The input is `.strict()`, so a daemon whose build does not declare a
    // field rejects the whole operation rather than stripping it and creating a
    // child with no source lineage. `sourceContext` inherits that behaviour on
    // any predecessor build, which is the operation-scoped degradation the
    // authoring flow's pre-send inspection gate is designed around.
    expect(
      spawnNewInputSchema.safeParse({
        directory: '/repo',
        agentId: 'claude',
        fieldThisBuildDoesNotDeclare: { v: 1 },
      }).success,
    ).toBe(false);
  });
});
