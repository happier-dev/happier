import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MachineOperationProtocolCapabilitiesV1Schema,
} from '../machines/operationProtocolCapabilitiesV1.js';
import { SESSION_AGENT_TRANSITION_VECTORS as V } from './agentTransitionVectors.js';
import { SessionSpawnNewInputV2Schema } from './creation/sessionSpawnNewInputV2.js';
import { SessionForkRpcParamsSchema } from './fork.js';

/**
 * Section 6.7 compatibility directions, expressed as deciding tests.
 *
 * Each additive field below is optional, so the reachable risk is not a parse
 * failure — it is a NEW client silently getting old behavior from an OLD peer.
 * These tests pin which direction fails closed and which stays additive.
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

function unrecognizedKeys(error: z.ZodError | undefined): readonly string[] {
  if (!error) return [];
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [],
  );
}

describe('compat — new client + old daemon, generic native fork intent', () => {
  it('is rejected outright rather than downgraded to a Replay fork', () => {
    const request = V.fork.valid.nativeIntent;

    // Current daemon understands the intent.
    expect(SessionForkRpcParamsSchema.safeParse(request).success).toBe(true);

    // A daemon that predates `native` refuses the request. The enum sits inside
    // a `.strict()` params object, so there is no path where the user asks for
    // Native and silently receives a Replay fork.
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

  it('accepts the predecessor requestId that this tree previously rejected', () => {
    const withRequestId = V.fork.valid.withRequestId;
    expect(SessionForkRpcParamsSchema.safeParse(withRequestId).success).toBe(true);

    // Before this change the strict params object had no `requestId`, so a
    // predecessor client's coalescing key was rejected outright.
    const releasedWithoutRequestId = SessionForkRpcParamsSchema.omit({ requestId: true });
    expect(
      unrecognizedKeys(releasedWithoutRequestId.safeParse(withRequestId).error),
    ).toContain('requestId');
  });
});

describe('compat — new client + old daemon, sourceContext spawn', () => {
  const payloadWithSourceContext = {
    directory: '/tmp/workspace',
    sourceContext: V.sourceContext.valid.latest,
  };

  it('is refused as an unknown field, never silently dropped', () => {
    // The released strict spawn input has no `sourceContext`, so an older dev
    // daemon rejects the whole operation. That is operation-scoped safe
    // degradation, not wire compatibility by silent ignore.
    const released = SessionSpawnNewInputV2Schema.omit({ sourceContext: true });
    expect(unrecognizedKeys(released.safeParse(payloadWithSourceContext).error))
      .toContain('sourceContext');
  });

  it('is a recognized field on the current spawn input', () => {
    // The payload is still incomplete, but `sourceContext` must not be among
    // the reasons it fails.
    expect(unrecognizedKeys(SessionSpawnNewInputV2Schema.safeParse(payloadWithSourceContext).error))
      .not.toContain('sourceContext');
  });
});

describe('compat — old client + new daemon, spawn', () => {
  it('leaves sourceContext optional so ordinary authoring is unchanged', () => {
    const withoutSourceContext = { directory: '/tmp/workspace' };
    expect(unrecognizedKeys(SessionSpawnNewInputV2Schema.safeParse(withoutSourceContext).error))
      .toHaveLength(0);
  });
});

describe('compat — new daemon + old server, machine capabilities', () => {
  it('still recognizes exactly the three released capability leaves', () => {
    for (const leaf of ['sessionInputAdmission', 'sessionSpawn', 'pluginWebhookClaim']) {
      expect(
        MachineOperationProtocolCapabilitiesV1Schema.safeParse({
          [leaf]: { protocolVersions: [1] },
        }).success,
        leaf,
      ).toBe(true);
    }
  });

  it('adds no transition or continuation leaf to strict Machine capability V1', () => {
    for (const leaf of [
      'sessionAgentTransition',
      'sessionContinuationInspect',
      'sessionSourceContextSpawn',
      'sessionNativeForkIntent',
    ]) {
      expect(
        MachineOperationProtocolCapabilitiesV1Schema.safeParse({
          [leaf]: { protocolVersions: [1] },
        }).success,
        leaf,
      ).toBe(false);
    }
  });

  it('rejects a transition capability leaf, so support cannot be smuggled in', () => {
    const parsed = MachineOperationProtocolCapabilitiesV1Schema.safeParse({
      sessionSpawn: { protocolVersions: [1] },
      sessionAgentTransition: { protocolVersions: [1] },
    });
    expect(parsed.success).toBe(false);
    expect(unrecognizedKeys(parsed.error)).toContain('sessionAgentTransition');
  });

  it('keeps the released capability projection byte-equivalent', () => {
    const released = {
      sessionInputAdmission: { protocolVersions: [1] },
      sessionSpawn: { protocolVersions: [1] },
      pluginWebhookClaim: { protocolVersions: [1] },
    };
    expect(JSON.stringify(MachineOperationProtocolCapabilitiesV1Schema.parse(released)))
      .toBe(JSON.stringify(released));
  });
});
