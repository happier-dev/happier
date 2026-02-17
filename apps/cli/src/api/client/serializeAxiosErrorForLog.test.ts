import { describe, expect, it } from 'vitest';

import { AxiosError } from 'axios';

import { serializeAxiosErrorForLog } from './serializeAxiosErrorForLog';

describe('serializeAxiosErrorForLog', () => {
  it('redacts query params and does not include headers/body', () => {
    const err = new AxiosError('boom', 'ECONNABORTED', {
      method: 'get',
      url: 'https://api.example.test/v1/account/settings?token=secret&x=1#hash',
      headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'application/json' },
      data: { secret: 'nope' },
    } as any);

    const serialized = serializeAxiosErrorForLog(err);
    expect(serialized).toEqual(expect.objectContaining({
      name: 'AxiosError',
      message: expect.any(String),
      code: expect.any(String),
      method: 'GET',
      url: 'https://api.example.test/v1/account/settings',
    }));
    expect(serialized).not.toHaveProperty('headers');
    expect(serialized).not.toHaveProperty('data');
  });
});

