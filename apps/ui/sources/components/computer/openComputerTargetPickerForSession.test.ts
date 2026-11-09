import { afterEach, describe, expect, it } from 'vitest';

import { getAgentCore } from '@/agents/catalog/catalog';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

import { resolveComputerTargetPickerForSession } from './openComputerTargetPickerForSession';

describe('resolveComputerTargetPickerForSession', () => {
  const previous = getStorage().getState();
  afterEach(() => {
    getStorage().setState({
      profileScope: previous.profileScope,
      sessions: previous.sessions,
      sessionListRowsByServerId: previous.sessionListRowsByServerId,
    });
  });

  it('names the Session agent from its Home-qualified display row without requiring a hydrated record', () => {
    const serverId = 'srv-picker-agent';
    const sessionId = 'picker-agent-session';
    getStorage()
      .getState()
      .activateProfileScope({ serverId, accountId: 'picker-agent-account' });
    getStorage()
      .getState()
      .applySessions([
        createSessionFixture({
          id: sessionId,
          serverId,
          metadataLayoutVersion: 1,
          metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
          ownerMetadataView: {
            name: 'Check the sign-in flow',
            path: '/work/happier',
            host: 'devbox',
            machineId: 'machine-1',
          },
        }),
      ]);
    getStorage().setState({ sessions: {} });

    const request = resolveComputerTargetPickerForSession({
      sessionId,
      serverId,
      machineId: 'machine-1',
      machineName: 'devbox',
      onSelected: () => {},
    });

    const claude = getAgentCore('claude');
    if (!claude) throw new Error('The Claude agent is missing from the catalog');
    expect(request?.agentName).toBe(t(claude.displayNameKey));
    expect(request?.agentName).not.toBe(t('browserPresence.agentFallbackName'));
    expect(request?.agentless).toBe(false);
  });

  it('asks for the agentless sentences when no agent resolves, instead of a fallback name mid-sentence', () => {
    const request = resolveComputerTargetPickerForSession({
      sessionId: 'picker-agentless-session',
      machineId: 'machine-1',
      machineName: 'devbox',
      onSelected: () => {},
    });
    expect(request?.agentless).toBe(true);
  });

  it('never puts the raw machine id in picker copy while the Machine has no readable name', () => {
    const named = resolveComputerTargetPickerForSession({
      sessionId: 'picker-name-session',
      machineId: '610145ef-b9fc-46e7-bf7c-f7c97c2e1c1e',
      machineName: 'devbox',
      onSelected: () => {},
    });
    const unnamed = resolveComputerTargetPickerForSession({
      sessionId: 'picker-name-session',
      machineId: '610145ef-b9fc-46e7-bf7c-f7c97c2e1c1e',
      machineName: null,
      onSelected: () => {},
    });

    expect(named?.machineName).toBe('devbox');
    expect(unnamed?.machineName).toBe(t('computerUse.presentation.tabFallback'));
  });
});
