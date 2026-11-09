import { expect, it } from 'vitest';
import { resolveShellBridgeActionSurfaceV1 } from './shellBridgeActionSurface';

it('keeps the observed predecessor Agent marker out of the human credential path', () => {
  expect(resolveShellBridgeActionSurfaceV1(['call', '--session-agent-bridge'])).toBe('agent');
  expect(resolveShellBridgeActionSurfaceV1(['call', '--agent-bridge'])).toBe('agent');
  expect(resolveShellBridgeActionSurfaceV1(['call'])).toBe('cli');
});
