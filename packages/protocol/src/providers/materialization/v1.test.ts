import { describe, expect, it } from 'vitest';

import {
  AgentProviderBindingLaunchMaterializationV1Schema,
  AgentProviderBindingMaterializationV1Schema,
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1,
} from './v1.js';

const envRow = (name = 'TOKEN', value: string | null = 'secret') => ({
  name,
  value,
  source: 'provider' as const,
});

describe('provider binding materialization V1', () => {
  it('accepts each strict materialization shape and rejects unknown fields', () => {
    expect(AgentProviderBindingMaterializationV1Schema.parse({
      v: 1, kind: 'spawnEnv', env: [envRow()], additionalRedactionValues: ['redact-me'],
    }).kind).toBe('spawnEnv');
    expect(AgentProviderBindingMaterializationV1Schema.parse({
      v: 1, kind: 'engineConfig', env: [envRow()], engineConfig: { model_provider: { key: 'env:TOKEN' } },
    }).kind).toBe('engineConfig');
    expect(AgentProviderBindingMaterializationV1Schema.parse({
      v: 1, kind: 'configFile', env: [envRow()], files: [{ relativePath: 'provider/config.json', utf8: '{}' }],
    }).kind).toBe('configFile');
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: [envRow()], cleanup: () => undefined,
    }).success).toBe(false);

    const inheritedEnvRow = Object.assign(Object.create({ inherited: true }), envRow());
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: [inheritedEnvRow],
    }).success).toBe(false);

    const inheritedFile = Object.assign(Object.create({ inherited: true }), {
      relativePath: 'provider/config.json', utf8: '{}',
    });
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'configFile', env: [], files: [inheritedFile],
    }).success).toBe(false);

    let getterCalls = 0;
    const accessorMaterialization = Object.defineProperty({ v: 1, env: [] }, 'kind', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'spawnEnv';
      },
    });
    expect(AgentProviderBindingMaterializationV1Schema.safeParse(accessorMaterialization).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('enforces exact env and redaction byte/count limits', () => {
    const limits = PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1;
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1,
      kind: 'spawnEnv',
      env: Array.from({ length: limits.env.maxRows + 1 }, (_, index) => envRow(`K${index}`)),
    }).success).toBe(false);
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: [envRow('K', 'x'.repeat(limits.env.maxValueBytes + 1))],
    }).success).toBe(false);
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1,
      kind: 'spawnEnv',
      env: [envRow()],
      additionalRedactionValues: Array.from({ length: limits.redaction.maxValues + 1 }, () => 'x'),
    }).success).toBe(false);

    const overLimitEnv = Array.from({ length: limits.env.maxRows + 1 }, (_, index) => envRow(`K${index}`));
    Object.defineProperty(overLimitEnv, 0, {
      get() {
        throw new Error('over-limit environment elements must not be parsed');
      },
    });
    expect(() => AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: overLimitEnv,
    })).not.toThrow();
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: overLimitEnv,
    }).success).toBe(false);

    let getterCalls = 0;
    const accessorEnv = [envRow()];
    Object.defineProperty(accessorEnv, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return envRow();
      },
    });
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1, kind: 'spawnEnv', env: accessorEnv,
    }).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('rejects non-canonical JSON including poison keys, sparse arrays, cycles, accessors, and non-finite values', () => {
    const invalidValues: unknown[] = [
      { constructor: 'poison' },
      [1, , 3],
      { value: Number.NaN },
      Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'x' }),
    ];
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    invalidValues.push(cycle);
    for (const engineConfig of invalidValues) {
      expect(AgentProviderBindingMaterializationV1Schema.safeParse({
        v: 1, kind: 'engineConfig', env: [], engineConfig,
      }).success).toBe(false);
    }
  });

  it('rejects unsafe file paths, case collisions, and bounded content overflow', () => {
    for (const relativePath of ['/abs', '../escape', 'a/../b', 'a\\..\\b', '.', 'a\u0000b']) {
      expect(AgentProviderBindingMaterializationV1Schema.safeParse({
        v: 1, kind: 'configFile', env: [], files: [{ relativePath, utf8: '{}' }],
      }).success).toBe(false);
    }
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1,
      kind: 'configFile',
      env: [],
      files: [{ relativePath: 'A.json', utf8: '{}' }, { relativePath: 'a.json', utf8: '{}' }],
    }).success).toBe(false);
    expect(AgentProviderBindingMaterializationV1Schema.safeParse({
      v: 1,
      kind: 'configFile',
      env: [],
      files: [{
        relativePath: 'a.json',
        utf8: 'x'.repeat(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxContentBytes + 1),
      }],
    }).success).toBe(false);
  });

  it('keeps the transient launch handoff non-secret and bounded', () => {
    expect(AgentProviderBindingLaunchMaterializationV1Schema.parse({ v: 1, kind: 'spawnEnv' })).toEqual({
      v: 1, kind: 'spawnEnv',
    });
    expect(AgentProviderBindingLaunchMaterializationV1Schema.parse({
      v: 1, kind: 'engineConfig', engineConfig: { provider: 'gateway' },
    }).kind).toBe('engineConfig');
    expect(AgentProviderBindingLaunchMaterializationV1Schema.parse({
      v: 1, kind: 'configFile', rootPath: '/private/session/provider', relativePaths: ['config.json'],
    }).kind).toBe('configFile');
    expect(AgentProviderBindingLaunchMaterializationV1Schema.safeParse({
      v: 1, kind: 'configFile', rootPath: '/private/session/provider', relativePaths: ['config.json'], files: ['secret'],
    }).success).toBe(false);
    for (const rootPath of ['relative/provider', '../provider', 'C:relative\\provider', '/private/../escape']) {
      expect(AgentProviderBindingLaunchMaterializationV1Schema.safeParse({
        v: 1, kind: 'configFile', rootPath, relativePaths: ['config.json'],
      }).success).toBe(false);
    }
    expect(AgentProviderBindingLaunchMaterializationV1Schema.safeParse({
      v: 1,
      kind: 'configFile',
      rootPath: '/private/session/provider',
      relativePaths: ['Config.json', 'config.json'],
    }).success).toBe(false);

    let getterCalls = 0;
    const accessorHandoff = Object.defineProperty({ v: 1 }, 'kind', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'spawnEnv';
      },
    });
    expect(AgentProviderBindingLaunchMaterializationV1Schema.safeParse(accessorHandoff).success).toBe(false);
    expect(getterCalls).toBe(0);
  });
});
