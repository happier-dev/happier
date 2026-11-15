import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from './actionCatalog.js';
import { getActionSpec } from './actionSpecs.js';

describe('portable Zod string-check projection', () => {
  it('admits the native reachability Workflow contract while retaining IPv4 and IPv6 CIDR constraints', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('machines.reachability.inspect'));
    const contract = freezeWorkflowActionContractV1(definition);
    expect(contract).not.toBeNull();
    const validate = compilePluginJsonSchema(contract!.inputSchema);
    const inputWithCidrs = (sourceCidrs: string[]) => ({
      machineId: 'machine',
      change: {
        kind: 'posture',
        posture: {
          revision: 0,
          management: { providers: [], publicSsh: { kind: 'open', port: 22, sourceCidrs } },
          defaultServiceIngress: { kind: 'none' },
        },
      },
    });
    expect(validate(inputWithCidrs(['192.0.2.0/24', '2001:db8::/64']))).toBe(true);
    for (const invalid of ['192.0.2.0/33', '2001:db8::/129', 'invalid/24']) {
      expect(validate(inputWithCidrs([invalid])), invalid).toBe(false);
    }
  });

  it('retains string-check constraints through the strict plugin consumer, including combined patterns and definitions', () => {
    const checks = z.strictObject({
      prefix: z.string().check(z.startsWith('/')),
      suffix: z.string().check(z.endsWith('.txt')),
      contains: z.string().check(z.includes('needle', { position: 2 })),
      lower: z.string().check(z.lowercase()),
      upper: z.string().check(z.uppercase()),
      combined: z.string().check(z.startsWith('/'), z.endsWith('.txt')),
    });
    const schema = z.strictObject({ first: checks, second: checks });
    const json = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7', reused: 'ref' });
    const validate = compilePluginJsonSchema(json);
    const valid = { prefix: '/home', suffix: 'file.txt', contains: 'xxneedle', lower: 'abc', upper: 'ABC', combined: '/file.txt' };
    expect(validate({ first: valid, second: valid })).toBe(true);
    for (const [key, value] of Object.entries({ prefix: 'home', suffix: 'file.log', contains: 'needle', lower: 'Abc', upper: 'AbC', combined: '/file.log' })) {
      expect(validate({ first: { ...valid, [key]: value }, second: valid }), key).toBe(false);
    }
    // Actual portable formats and literal user data must not be normalized away.
    expect(zodSchemaToJsonSchemaObject(z.email(), { target: 'draft-7' })).toHaveProperty('format', 'email');
    const literal = { format: 'starts_with', pattern: '^literal' };
    expect(zodSchemaToJsonSchemaObject(z._default(z.unknown(), literal), { target: 'draft-7' })).toHaveProperty('default', literal);
    expect(() => compilePluginJsonSchema(zodSchemaToJsonSchemaObject(z.stringFormat('private-format', /^value$/), { target: 'draft-7' }))).toThrow();
  });
});
