import { describe, expect, it } from 'vitest';
import * as destinations from './index.js';

describe('S3 destination preparation', () => {
  it('keeps a native encoded repository prefix and optional session-token identity', () => {
    const prepare = Reflect.get(destinations, 'prepareS3Destination');
    expect(prepare).toBeTypeOf('function');
    expect(prepare({ endpoint: 'http://[::1]:9000', bucket: 'recovery', prefix: 'é folder/100%/a?b#' },
      ['sessionToken', 'accessKeyId', 'repositoryPassword', 'secretAccessKey'])).toEqual({
      kind: 's3', repository: 's3:http://[::1]:9000/recovery/%C3%A9%20folder/100%25/a%3Fb%23',
      config: { endpoint: 'http://[::1]:9000', bucket: 'recovery', prefix: 'é folder/100%/a?b#' },
      credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sessionToken'].map(role => ({
        purpose: 'backupDestination', configKey: 'destination', role,
      })),
    });
  });

  it('refuses credential-bearing configuration and repository identity changes', () => {
    const prepare = Reflect.get(destinations, 'prepareS3Destination');
    expect(prepare).toBeTypeOf('function');
    const config = { endpoint: 'https://objects.example.test', bucket: 'recovery', prefix: 'environments/one' };
    for (const endpoint of ['https://user:secret@objects.example.test', 'https://objects.example.test/api',
      'https://objects.example.test?token=secret', 'https://objects.example.test#fragment', 'file:///backup']) {
      expect(() => prepare({ ...config, endpoint })).toThrow();
    }
    for (const prefix of ['../production', '/production', 'a/../production', 'a//b', 'a/', 'a\u0000b']) {
      expect(() => prepare({ ...config, prefix })).toThrow();
    }
    expect(() => prepare({ ...config, secretAccessKey: 'not-config' })).toThrow();
    expect(() => prepare(config, ['repositoryPassword', 'accessKeyId', 'sessionToken'])).toThrow();
  });

  it('opens exact nonsecret storage with canonical role identities', () => {
    const prepare = Reflect.get(destinations, 'prepareS3Destination') as
      ((input: unknown) => unknown) | undefined;
    const config = {
      endpoint: 'https://objects.example.test:9443/', bucket: 'recovery',
      prefix: 'environments/production', region: 'eu-central-1', addressing: 'path',
    };
    expect(prepare?.(config)).toEqual({
      kind: 's3', repository: 's3:https://objects.example.test:9443/recovery/environments/production',
      config: { ...config, endpoint: 'https://objects.example.test:9443' },
      credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey'].map(role => ({
        purpose: 'backupDestination', configKey: 'destination', role,
      })),
    });
  });
});
