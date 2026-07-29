import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('OhMyPi session capabilities', () => {
  it('does not advertise undeclared media policy in the strict Agent contract', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities).not.toHaveProperty('media');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.sessions.open).toEqual(['create', 'resume', 'fork']);
  });
});
