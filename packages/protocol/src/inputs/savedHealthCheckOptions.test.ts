import { describe, expect, it } from 'vitest';

import '../actions/actionExecutor.js';
import type { ActionExecutorDeps } from '../actions/actionExecutor.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { resolveInputOptions } from './inputOptions.js';
import { SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1 } from './savedHealthCheckOptions.js';

const context = {
  surface: 'ui',
  authority: 'present_user',
  actionCaller: { kind: 'host' },
  serverId: 'home-1',
} as const;
const resolve = (
  deps: ActionExecutorDeps,
  ctx: typeof context | Omit<typeof context, 'serverId'> = context,
) =>
  resolveInputOptions({
    deps,
    ctx,
    actionId: null,
    optionsSourceId: SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1,
    input: {},
    readFailure: () => null,
    resolveSessionId: () => null,
    reviewScope: () => undefined,
  });

describe('health.checks.saved options', () => {
  it('offers the Home’s saved Checks by the name their host gives them, valued by their address only', async () => {
    const reads: unknown[] = [];
    // The host that opens private Check definitions is the boundary; the option projection stays real.
    const deps = {
      savedHealthChecksList: async (args: { serverId: string }) => {
        reads.push(args);
        return {
          items: [
            {
              automationId: 'automation-checkout',
              triggerId: 'trigger-1',
              label: 'Checkout',
              description: 'Key flow',
            },
            {
              automationId: 'automation-site',
              triggerId: 'trigger-1',
              label: 'billing.example.com',
            },
          ],
        };
      },
    } as unknown as ActionExecutorDeps;
    expect(await resolve(deps)).toEqual({
      ok: true,
      result: [
        {
          value: {
            serverId: 'home-1',
            automationId: 'automation-checkout',
            triggerId: 'trigger-1',
          },
          label: 'Checkout',
          description: 'Key flow',
        },
        {
          value: {
            serverId: 'home-1',
            automationId: 'automation-site',
            triggerId: 'trigger-1',
          },
          label: 'billing.example.com',
        },
      ],
    });
    expect(reads).toEqual([{ serverId: 'home-1' }]);
  });

  it('needs a selected Home and a host that can name Checks', async () => {
    let reads = 0;
    const deps = {
      savedHealthChecksList: async () => {
        reads++;
        return { items: [] };
      },
    } as unknown as ActionExecutorDeps;
    expect(
      await resolve(deps, {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      }),
    ).toMatchObject({ ok: false, errorCode: 'server_not_selected' });
    expect(reads).toBe(0);
    expect(await resolve({} as ActionExecutorDeps)).toMatchObject({
      ok: false,
      errorCode: 'unsupported_action',
    });
  });

  it('is the source of the Check widget’s one input, an address the widget schema admits', () => {
    const descriptor = readBuiltinWidgetDescriptorV1({
      kind: 'builtin',
      id: 'service_check',
    });
    expect(descriptor).toMatchObject({
      target: 'app',
      inputs: {
        fields: [
          {
            path: 'check',
            required: true,
            optionsSourceId: SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1,
          },
        ],
      },
    });
    expect(descriptor?.inputSchema).toMatchObject({
      required: ['check'],
      properties: {
        check: {
          required: ['serverId', 'automationId', 'triggerId'],
          additionalProperties: false,
        },
      },
    });
  });
});
