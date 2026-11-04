import * as React from 'react';
import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

type ClaudePoolSettingsProps = Parameters<NonNullable<NonNullable<AgentUiBehavior['connectedServices']>['renderPoolSettings']>>[0];

export function ClaudePoolSettings({ serviceId, policy, disabled, onPatchPolicy }: ClaudePoolSettingsProps) {
    if (serviceId !== 'claude-subscription' && serviceId !== 'anthropic') return null;
    const title = t('connectedServices.detail.groupDetail.claudeCodeAutoContinueAtUsageLimitTitle');
    return (
        <Item
            testID="connected-services-pool-detail:claude-auto-continue"
            title={title}
            subtitle={t('connectedServices.detail.groupDetail.claudeCodeAutoContinueAtUsageLimitSubtitle')}
            disabled={disabled}
            rightElement={(
                <Switch
                    testID="connected-services-pool-detail:claude-auto-continue:toggle"
                    value={policy.claudeCodeAutoContinueAtUsageLimit === true}
                    onValueChange={disabled ? undefined : (next) => { void onPatchPolicy({ claudeCodeAutoContinueAtUsageLimit: next }); }}
                    disabled={disabled}
                    accessibilityLabel={title}
                    compact
                />
            )}
            showChevron={false}
        />
    );
}
