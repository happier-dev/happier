import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } from '@/backends/pi/brokerExtension';

import { resolvePiSharedTerminalLaunch } from './resolvePiSharedTerminalLaunch';

const terminalTty = { nativeTerminalEnabled: true, startedBy: 'terminal', hasTTY: true, terminalRuntime: null, env: {} } as const;

describe('resolvePiSharedTerminalLaunch', () => {
  it('launches the native Pi terminal for a terminal-started run that owns a TTY', () => {
    expect(resolvePiSharedTerminalLaunch(terminalTty)).toEqual({ kind: 'shared' });
  });

  it.each([
    ['daemon-started', { ...terminalTty, startedBy: 'daemon' }],
    ['an unknown starter', { ...terminalTty, startedBy: undefined }],
    ['no TTY', { ...terminalTty, hasTTY: false }],
    ['a tmux-hosted pane', { ...terminalTty, terminalRuntime: { mode: 'plain', requested: 'tmux' } }],
    ['a herdr-hosted pane', { ...terminalTty, terminalRuntime: { mode: 'plain', requested: 'herdr' } }],
    ['a zellij-hosted pane', { ...terminalTty, terminalRuntime: { mode: 'plain', requested: 'zellij' } }],
  ] as const)('keeps the RPC path for %s', (_label, input) => {
    expect(resolvePiSharedTerminalLaunch(input)).toEqual({ kind: 'rpc', fallback: null });
  });

  it('falls back to RPC for brokered connected-service credentials', () => {
    const env = {
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
      }),
    };
    expect(resolvePiSharedTerminalLaunch({ ...terminalTty, env })).toEqual({ kind: 'rpc', fallback: 'connected_service' });
  });

  it('falls back to RPC when a connected service selects the Pi launch provider', () => {
    const env = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-work' },
      ]),
    };
    expect(resolvePiSharedTerminalLaunch({ ...terminalTty, env })).toEqual({ kind: 'rpc', fallback: 'connected_service' });
  });
});
