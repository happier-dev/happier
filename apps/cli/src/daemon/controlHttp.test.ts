import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { buildDaemonControlHttpHeaders } from './controlHttp';

let envScope = createEnvKeyScope(['HAPPIER_TOKEN']);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_TOKEN']);
});

describe('daemon control HTTP authentication', () => {
  it('keeps an ambient API Token out of daemon-control headers', () => {
    envScope.patch({ HAPPIER_TOKEN: 'hap_v1_automation_token_secret' });

    expect(buildDaemonControlHttpHeaders('daemon-control-token')).toEqual({
      'Content-Type': 'application/json',
      Connection: 'close',
      'x-happier-daemon-token': 'daemon-control-token',
    });
  });
});
