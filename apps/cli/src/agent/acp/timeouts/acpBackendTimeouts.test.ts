import { afterEach, describe, expect, it } from 'vitest';

import type { TransportHandler } from '../../transport';
import { DefaultTransport } from '../../transport';
import {
  resolvePostPromptNoUpdatesTimeoutMs,
  resolvePromptLivenessTimeoutMs,
  resolveTurnHardCapTimeoutMs,
  resolveTurnInactivityTimeoutMs,
} from './acpBackendTimeouts';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS',
  'HAPPY_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS',
  'HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS',
  'HAPPY_ACP_PROMPT_LIVENESS_TIMEOUT_MS',
  'HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS',
  'HAPPY_ACP_TURN_HARD_CAP_TIMEOUT_MS',
  'HAPPIER_ACP_TURN_INACTIVITY_TIMEOUT_MS',
  'HAPPY_ACP_TURN_INACTIVITY_TIMEOUT_MS',
]);

describe('ACP backend timeout resolution', () => {
  afterEach(() => {
    envScope.restore();
  });

  it('uses each hosted Session timeout settings across asynchronous work', async () => {
    envScope.patch({ HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS: '999', HAPPIER_ACP_TURN_INACTIVITY_TIMEOUT_MS: '998' });
    await Promise.all([1500, 2500].map(async timeout => {
      await runAddedHostedSession({ environment: { NODE_ENV: 'test', HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS: String(timeout), HAPPIER_ACP_TURN_INACTIVITY_TIMEOUT_MS: String(timeout + 1) }, workingDirectory: '/session', end() {} }, async () => {
        await Promise.resolve();
        expect(resolveTurnHardCapTimeoutMs()).toBe(timeout);
        expect(resolveTurnInactivityTimeoutMs()).toBe(timeout + 1);
      });
    }));
    expect(resolveTurnHardCapTimeoutMs()).toBe(999);
  });

  it('defaults provider liveness watchdogs to disabled', () => {
    const transport = new DefaultTransport('test');

    expect(resolvePostPromptNoUpdatesTimeoutMs(transport)).toBeNull();
    expect(resolvePromptLivenessTimeoutMs(transport)).toBeNull();
    expect(resolveTurnHardCapTimeoutMs()).toBeNull();
    expect(resolveTurnInactivityTimeoutMs()).toBeNull();
  });

  it('preserves explicit transport null as a disable decision over env defaults', () => {
    envScope.patch({
      HAPPIER_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS: '500',
      HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS: '600',
    });
    class NullTimeoutTransport extends DefaultTransport implements TransportHandler {
      getPostPromptNoUpdatesTimeoutMs(): null {
        return null;
      }

      getPromptLivenessTimeoutMs(): null {
        return null;
      }
    }
    const transport = new NullTimeoutTransport('test');

    expect(resolvePostPromptNoUpdatesTimeoutMs(transport)).toBeNull();
    expect(resolvePromptLivenessTimeoutMs(transport)).toBeNull();
  });

  it('allows env values to opt into disabled-by-default turn watchdogs', () => {
    envScope.patch({
      HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS: '1500',
      HAPPIER_ACP_TURN_INACTIVITY_TIMEOUT_MS: '2500',
    });

    expect(resolveTurnHardCapTimeoutMs()).toBe(1500);
    expect(resolveTurnInactivityTimeoutMs()).toBe(2500);
  });
});
