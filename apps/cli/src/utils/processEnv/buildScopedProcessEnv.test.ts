import { describe, expect, it } from 'vitest';

import {
  buildScopedProcessEnv,
  stripUnsetEnvironmentVariables,
} from './buildScopedProcessEnv';

describe('buildScopedProcessEnv', () => {
  it('removes inherited keys case-insensitively before applying explicit values', () => {
    const baseEnv = {
      PATH: '/bin',
      OPENAI_API_KEY: 'ambient-key',
      Gemini_Model: 'ambient-model',
    };

    const result = buildScopedProcessEnv({
      baseEnv,
      unsetEnvKeys: ['openai_api_key', 'GEMINI_MODEL'],
      explicitEnv: {
        Gemini_Model: 'explicit-model',
        EMPTY: '',
      },
    });

    expect(result).toEqual({
      PATH: '/bin',
      Gemini_Model: 'explicit-model',
      EMPTY: '',
    });
    expect(baseEnv).toEqual({
      PATH: '/bin',
      OPENAI_API_KEY: 'ambient-key',
      Gemini_Model: 'ambient-model',
    });
  });

  it('does not retain scoped state across provider and native invocations', () => {
    const ambient = { PATH: '/bin', NATIVE_TOKEN: 'native' };
    const providerX = buildScopedProcessEnv({
      baseEnv: ambient,
      explicitEnv: { PROVIDER_TOKEN: 'x' },
    });
    const providerY = buildScopedProcessEnv({
      baseEnv: ambient,
      explicitEnv: { PROVIDER_TOKEN: 'y' },
    });
    const native = buildScopedProcessEnv({ baseEnv: ambient });

    expect(providerX).toEqual({ PATH: '/bin', NATIVE_TOKEN: 'native', PROVIDER_TOKEN: 'x' });
    expect(providerY).toEqual({ PATH: '/bin', NATIVE_TOKEN: 'native', PROVIDER_TOKEN: 'y' });
    expect(native).toEqual(ambient);
  });

  it('compacts undefined process values while removing explicitly unset keys', () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: '/bin',
      UNDEFINED_VALUE: undefined,
      Provider_Token: 'secret',
      EMPTY: '',
    };

    expect(stripUnsetEnvironmentVariables(environment, ['provider_token'])).toStrictEqual({
      PATH: '/bin',
      EMPTY: '',
    });
    expect(environment).toEqual({
      PATH: '/bin',
      UNDEFINED_VALUE: undefined,
      Provider_Token: 'secret',
      EMPTY: '',
    });
  });

  it('replaces case-equivalent inherited keys on Windows while preserving POSIX key identity', () => {
    expect(buildScopedProcessEnv({
      baseEnv: { Path: '/ambient', OpenAI_Api_Key: 'ambient-key' },
      explicitEnv: { PATH: '/explicit', OPENAI_API_KEY: 'provider-key' },
      platform: 'win32',
    })).toEqual({ PATH: '/explicit', OPENAI_API_KEY: 'provider-key' });

    expect(buildScopedProcessEnv({
      baseEnv: { Path: '/ambient', OpenAI_Api_Key: 'ambient-key' },
      explicitEnv: { PATH: '/explicit', OPENAI_API_KEY: 'provider-key' },
      platform: 'linux',
    })).toEqual({
      Path: '/ambient',
      PATH: '/explicit',
      OpenAI_Api_Key: 'ambient-key',
      OPENAI_API_KEY: 'provider-key',
    });
  });

  it.each(['', 'BAD=NAME', 'BAD\nNAME', '1INVALID'])(
    'rejects invalid unset key %j instead of silently widening the operation',
    (name) => {
      expect(() => buildScopedProcessEnv({ baseEnv: {}, unsetEnvKeys: [name] })).toThrow();
    },
  );
});
