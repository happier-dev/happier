import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { resolveExecutionRunSelectionLabel } from './resolveExecutionRunSelectionLabel';

describe('resolveExecutionRunSelectionLabel', () => {
  const label = (connectionId: string) =>
    connectionId === 'pc_gateway' ? 'Main gateway' : null;

  it('says an inherited Run follows the session and names its route and model', () => {
    expect(
      resolveExecutionRunSelectionLabel(
        {
          source: 'inherited',
          modelSelection: {
            agentTargetKey: 'agent:codex',
            providerConnectionId: 'pc_gateway',
            modelId: 'fable-5.1',
          },
        },
        label,
      ),
    ).toBe(
      `${t('runPage.menu.selectionInherited')} · Main gateway · fable-5.1`,
    );
  });

  it('keeps an explicit choice visible and never names a connection the Account no longer has', () => {
    expect(
      resolveExecutionRunSelectionLabel(
        {
          source: 'explicit',
          modelSelection: {
            agentTargetKey: 'agent:codex',
            providerConnectionId: 'pc_deleted',
            modelId: 'gpt-6.1-luna',
          },
        },
        label,
      ),
    ).toBe(`${t('runPage.menu.selectionExplicit')} · gpt-6.1-luna`);
    expect(resolveExecutionRunSelectionLabel(undefined, label)).toBeNull();
  });

  it.each([
    { selection: 'group' as const, groupId: 'pool-work' },
    { selection: 'profile' as const, profileId: 'account-work' },
  ])('names the admitted native account or pool without guessing its current member', binding => {
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited', modelId: 'sonnet',
      connectedServices: { v: 2, bindingsByServiceId: {
        'happier.connected-service.claude/claude-subscription': { source: 'connected', ...binding },
      } },
    }, label, 'Claude · Work')).toBe(`${t('runPage.menu.selectionInherited')} · Claude · Work · sonnet`);
  });

  it('names a Team resource from its recipient-safe identity', () => {
    expect(resolveExecutionRunSelectionLabel({
      source: 'inherited', teamCredentialModel: {
        kind: 'team_credential_provider_model', teamId: 'team-work', resourceId: 'resource-work',
        expectedResourceRevision: 2, deliveryMode: 'brokered', agentTargetKey: 'agent:codex', modelId: 'sonnet',
      },
    }, label, 'Work Team · Shared Claude')).toBe(`${t('runPage.menu.selectionInherited')} · Work Team · Shared Claude · sonnet`);
  });
});
