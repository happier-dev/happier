import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
  CONNECTED_SERVICE_BROKER_LOADED_PATH,
  CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH,
  CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS,
  createBrokerLoadHandshakeRegistry,
} from './index.js';

describe('connected-service broker load-handshake registry (shared, provider-agnostic)', () => {
  it('records and observes a handshake keyed by selection identity', () => {
    const registry = createBrokerLoadHandshakeRegistry();
    expect(registry.wasObserved({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-a' })).toBe(false);
    registry.record({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-a' });
    expect(registry.wasObserved({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-a' })).toBe(true);
    // A DIFFERENT identity (e.g. the OpenCode broker's) is independent.
    expect(registry.wasObserved({ selectionIdentity: 'opencode|connected|broker:1|openai-codex:p:', loadNonce: 'spawn-a' })).toBe(false);
  });

  it('does not let a stale handshake from an older process satisfy a newer spawn nonce', () => {
    const registry = createBrokerLoadHandshakeRegistry();
    registry.record({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-a' });
    expect(registry.wasObserved({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-b' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: 'pi|connected|broker:1|anthropic:default:', loadNonce: 'spawn-a' })).toBe(true);
  });

  it('treats a handshake older than the freshness horizon as stale', () => {
    const registry = createBrokerLoadHandshakeRegistry();
    const at = 1_000_000;
    registry.record({ selectionIdentity: 'id', loadNonce: 'spawn-a' }, at);
    expect(registry.wasObserved({ selectionIdentity: 'id', loadNonce: 'spawn-a' }, { nowMs: at + CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS })).toBe(true);
    expect(registry.wasObserved({ selectionIdentity: 'id', loadNonce: 'spawn-a' }, { nowMs: at + CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS + 1 })).toBe(false);
  });

  it('fails closed on a blank identity (record + observe)', () => {
    const registry = createBrokerLoadHandshakeRegistry();
    registry.record({ selectionIdentity: '   ', loadNonce: 'spawn-a' });
    registry.record({ selectionIdentity: 'id', loadNonce: '   ' });
    expect(registry.wasObserved({ selectionIdentity: '', loadNonce: 'spawn-a' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: '   ', loadNonce: 'spawn-a' })).toBe(false);
    expect(registry.wasObserved({ selectionIdentity: 'id', loadNonce: '   ' })).toBe(false);
  });

  it('exposes stable, provider-agnostic endpoint paths (the broker, daemon, and preflight contract)', () => {
    expect(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH)
      .toBe('/connected-service-auth/broker/daemon-auth-bridge/refresh');
    expect(CONNECTED_SERVICE_BROKER_LOADED_PATH).toBe('/connected-service-auth/broker/loaded');
    expect(CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH).toBe('/connected-service-auth/broker/loaded-status');
  });
});
