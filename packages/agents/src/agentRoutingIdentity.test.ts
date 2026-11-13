import { describe, expect, it } from 'vitest';

import { resolveAgentRoutingId, type AgentRoutingIdentityEntry } from './agentRoutingIdentity.js';

describe('catalog Agent routing identity', () => {
  const bundled = { id: 'pi', identity: { pluginId: 'happier.agent.pi', localId: 'pi' } };
  const installed = { id: 'example.agent/pi', identity: { pluginId: 'example.agent', localId: 'pi' } };
  const catalog = [bundled, installed] satisfies AgentRoutingIdentityEntry[];

  it('resolves a qualified bundled address to the catalog routing id', () => {
    expect(resolveAgentRoutingId('happier.agent.pi/pi', catalog)).toBe('pi');
    expect(resolveAgentRoutingId('pi', catalog)).toBe('pi');
  });

  it('preserves installed routing and separates plugins declaring the same local id', () => {
    expect(resolveAgentRoutingId('example.agent/pi', catalog)).toBe('example.agent/pi');
    expect(resolveAgentRoutingId('example.agent/pi', [bundled])).toBeNull();
    expect(resolveAgentRoutingId('happier.agent.pi/pi', [installed])).toBeNull();
    expect(resolveAgentRoutingId('pi', [installed])).toBeNull();
  });

  it('retains a qualified catalog routing id even for a normally bundled identity', () => {
    expect(resolveAgentRoutingId('happier.agent.pi/pi', [{
      ...bundled, id: 'happier.agent.pi/pi',
    }])).toBe('happier.agent.pi/pi');
  });

  it('never turns an authority key or malformed qualified string into a local-id alias', () => {
    expect(resolveAgentRoutingId('happier.agent.pi/agents/pi', catalog)).toBeNull();
    expect(resolveAgentRoutingId('happier.agent.pi/pi ', catalog)).toBeNull();
    expect(resolveAgentRoutingId('unknown.agent/pi', catalog)).toBeNull();
  });
});
