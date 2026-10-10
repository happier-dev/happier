import { afterEach, describe, expect, it, vi } from 'vitest';

import { log, logger } from './log';

describe('log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits at the level named by the entry so error-level entries survive a warn threshold', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    log(
      { module: 'fastify-error', level: 'error', statusCode: 500 },
      'Unhandled error',
    );
    log({ module: 'socket', level: 'warn' }, 'Slow handler');

    expect(error).toHaveBeenCalledWith(
      { module: 'fastify-error', level: 'error', statusCode: 500 },
      'Unhandled error',
    );
    expect(warn).toHaveBeenCalledWith(
      { module: 'socket', level: 'warn' },
      'Slow handler',
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('keeps info for entries without a recognised level', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    log({ module: 'api' }, 'Request served');
    log({ module: 'api', level: 'loud' }, 'Unknown level');
    log('plain message');

    expect(info).toHaveBeenCalledTimes(3);
  });
});
