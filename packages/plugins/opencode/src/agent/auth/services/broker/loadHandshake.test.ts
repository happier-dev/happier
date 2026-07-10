import { describe, expect, it } from 'vitest';

import {
  OPEN_CODE_BROKER_LOADED_PATH,
  OPEN_CODE_BROKER_LOADED_STATUS_PATH,
  OPEN_CODE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS,
  createOpenCodeBrokerLoadHandshakeRegistry,
} from './loadHandshake.js';

describe('openCode broker load-handshake registry (F4)', () => {
  it('records a handshake and observes it for the same stable selection identity', () => {
    const registry = createOpenCodeBrokerLoadHandshakeRegistry();
    const identity = 'opencode|connected|broker:1|openai-codex:p:';
    expect(registry.wasObserved({ selectionIdentity: identity, loadNonce: 'spawn-a' })).toBe(false);
    registry.record({ selectionIdentity: identity, loadNonce: 'spawn-a' });
    expect(registry.wasObserved({ selectionIdentity: identity, loadNonce: 'spawn-a' })).toBe(true);
  });

  it('is scoped to the selection identity and spawn nonce', () => {
    const registry = createOpenCodeBrokerLoadHandshakeRegistry();
    registry.record({ selectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:', loadNonce: 'spawn-a' });
    expect(registry.wasObserved({ selectionIdentity: 'opencode|connected|broker:1|openai-codex:account-b:', loadNonce: 'spawn-a' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: 'opencode|connected|broker:1|openai-codex:account-a:', loadNonce: 'spawn-b' })).toBe(false);
  });

  it('ignores a handshake older than the freshness horizon (stale daemon-restart safety)', () => {
    const registry = createOpenCodeBrokerLoadHandshakeRegistry();
    const identity = 'opencode|connected|broker:1|claude-subscription:p:';
    registry.record({ selectionIdentity: identity, loadNonce: 'spawn-a' }, 1_000);
    // Within the horizon ⇒ observed.
    expect(
      registry.wasObserved({ selectionIdentity: identity, loadNonce: 'spawn-a' }, { nowMs: 1_000 + OPEN_CODE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS }),
    ).toBe(true);
    // Just past the horizon ⇒ stale ⇒ not observed.
    expect(
      registry.wasObserved({ selectionIdentity: identity, loadNonce: 'spawn-a' }, { nowMs: 1_000 + OPEN_CODE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS + 1 }),
    ).toBe(false);
  });

  it('fails closed on a blank identity (never records or observes an empty key)', () => {
    const registry = createOpenCodeBrokerLoadHandshakeRegistry();
    registry.record({ selectionIdentity: '   ', loadNonce: 'spawn-a' });
    registry.record({ selectionIdentity: 'id', loadNonce: '   ' });
    expect(registry.wasObserved({ selectionIdentity: '', loadNonce: 'spawn-a' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: '   ', loadNonce: 'spawn-a' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: 'id', loadNonce: '   ' })).toBe(false);
  });

  it('exposes the shared, provider-agnostic endpoint paths (the broker, daemon, and preflight contract)', () => {
    // The handshake endpoints are now shared with the Pi broker (keyed by selection identity plus
    // per-spawn nonce), so the path is provider-agnostic — the OpenCode alias resolves to the shared value.
    expect(OPEN_CODE_BROKER_LOADED_PATH).toBe('/connected-service-auth/broker/loaded');
    expect(OPEN_CODE_BROKER_LOADED_STATUS_PATH).toBe('/connected-service-auth/broker/loaded-status');
  });
});
