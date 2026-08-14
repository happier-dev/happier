import { describe, expect, it } from 'vitest';

import { compilePluginJsonSchema } from '../../plugins/actions/jsonSchemaValidation.js';
import {
  arePluginMachineExecutionOriginsEqual,
  PluginMachineExecutionOriginV1JsonSchema,
  PluginMachineExecutionOriginV1Schema,
} from './pluginMachineExecutionOriginV1.js';

describe('PluginMachineExecutionOriginV1', () => {
  it('projects its exact portable identity as a reusable plugin JSON Schema fragment', () => {
    const validates = compilePluginJsonSchema(PluginMachineExecutionOriginV1JsonSchema);
    const canonical = {
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    } as const;

    expect(validates(canonical)).toBe(true);
    expect(validates({ ...canonical, serverIdentityId: 'local-profile' })).toBe(false);
    expect(validates({
      ...canonical,
      materializationRef: { ...canonical.materializationRef, pluginId: 'ACME.PLUGIN' },
    })).toBe(false);
    expect(validates({
      ...canonical,
      materializationRef: { ...canonical.materializationRef, pluginId: 'acme.constructor' },
    })).toBe(false);
    expect(validates({ ...canonical, unexpected: true })).toBe(false);
  });

  it('composes canonical server identity with the exact Artifact materialization reference', () => {
    expect(PluginMachineExecutionOriginV1Schema.parse({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    })).toEqual({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    });
  });

  it('compares every server and materialization identity fact exactly', () => {
    const origin = Object.freeze({
      serverIdentityId: 'srv_account_one',
      materializationRef: Object.freeze({
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      }),
    });

    expect(arePluginMachineExecutionOriginsEqual(origin, origin)).toBe(true);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      serverIdentityId: 'srv_account_two',
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, pluginId: 'acme.other' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, machineId: 'machine-b' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, materializationId: 'mat-b' },
    })).toBe(false);
  });

  it('rejects device-local server ids and widened materialization facts', () => {
    expect(PluginMachineExecutionOriginV1Schema.safeParse({
      serverIdentityId: 'local-profile',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    }).success).toBe(false);

    expect(PluginMachineExecutionOriginV1Schema.safeParse({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
        generation: 7,
      },
    }).success).toBe(false);
  });
});
