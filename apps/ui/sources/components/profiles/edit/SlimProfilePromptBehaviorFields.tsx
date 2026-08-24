import * as React from 'react';
import {
    resolveCodingPromptBehaviorV1,
    type CodingPromptBehaviorOverridesV1,
    type CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

const INHERIT = '__account__';

function titleModeLabel(mode: CodingPromptSessionTitleUpdatesModeV1): string {
    if (mode === 'disabled') return t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverTitle');
    if (mode === 'initial') return t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialTitle');
    return t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingTitle');
}

export function SlimProfilePromptBehaviorFields(props: Readonly<{
    value: CodingPromptBehaviorOverridesV1 | undefined;
    onChange: (value: CodingPromptBehaviorOverridesV1 | undefined) => void;
}>) {
    const accountBehavior = resolveCodingPromptBehaviorV1({
        codingPromptBehaviorV1: useSetting('codingPromptBehaviorV1'),
    });
    const [openMenu, setOpenMenu] = React.useState<'title' | 'responses' | null>(null);

    const update = React.useCallback((patch: Partial<CodingPromptBehaviorOverridesV1>) => {
        const next = { ...props.value, ...patch };
        const compact = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
        props.onChange(Object.keys(compact).length > 0 ? compact as CodingPromptBehaviorOverridesV1 : undefined);
    }, [props]);

    const titleOverride = props.value?.sessionTitleUpdates;
    const responseOverride = props.value?.responseOptions;

    return <ItemGroup
        title={t('settingsSession.promptPersonalization.title')}
        footer={t('settingsSession.promptPersonalization.footer')}
    >
        <DropdownMenu
            open={openMenu === 'title'}
            onOpenChange={(open) => setOpenMenu(open ? 'title' : null)}
            variant="selectable"
            search={false}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            rowKind="item"
            selectedId={titleOverride ?? INHERIT}
            itemTrigger={{
                title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle'),
                subtitle: titleOverride
                    ? titleModeLabel(titleOverride)
                    : t('profiles.defaultPermissions.accountDefaultSubtitle', {
                        label: titleModeLabel(accountBehavior.sessionTitleUpdates),
                    }),
                showSelectedSubtitle: false,
                itemProps: { testID: 'profile-prompt-title-updates-trigger' },
            }}
            items={[
                {
                    id: INHERIT,
                    title: t('profiles.defaultPermissions.useAccountDefault'),
                    subtitle: t('profiles.defaultPermissions.currently', {
                        label: titleModeLabel(accountBehavior.sessionTitleUpdates),
                    }),
                },
                {
                    id: 'disabled',
                    title: titleModeLabel('disabled'),
                    subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverSubtitle'),
                },
                {
                    id: 'initial',
                    title: titleModeLabel('initial'),
                    subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSubtitle'),
                },
                {
                    id: 'ongoing',
                    title: titleModeLabel('ongoing'),
                    subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSubtitle'),
                },
            ]}
            onSelect={(id) => {
                update({ sessionTitleUpdates: id === INHERIT ? undefined : id as CodingPromptSessionTitleUpdatesModeV1 });
                setOpenMenu(null);
            }}
        />
        <DropdownMenu
            open={openMenu === 'responses'}
            onOpenChange={(open) => setOpenMenu(open ? 'responses' : null)}
            variant="selectable"
            search={false}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            rowKind="item"
            selectedId={responseOverride ?? INHERIT}
            itemTrigger={{
                title: t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle'),
                subtitle: responseOverride
                    ? t(responseOverride === 'agent'
                        ? 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle'
                        : 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle')
                    : t('profiles.defaultPermissions.accountDefaultSubtitle', {
                        label: t(accountBehavior.responseOptions === 'agent' ? 'common.enabled' : 'common.disabled'),
                    }),
                showSelectedSubtitle: false,
                itemProps: { testID: 'profile-prompt-response-options-trigger' },
            }}
            items={[
                {
                    id: INHERIT,
                    title: t('profiles.defaultPermissions.useAccountDefault'),
                    subtitle: t('profiles.defaultPermissions.currently', {
                        label: t(accountBehavior.responseOptions === 'agent' ? 'common.enabled' : 'common.disabled'),
                    }),
                },
                {
                    id: 'agent',
                    title: t('common.enabled'),
                    subtitle: t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle'),
                },
                {
                    id: 'disabled',
                    title: t('common.disabled'),
                    subtitle: t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle'),
                },
            ]}
            onSelect={(id) => {
                update({ responseOptions: id === INHERIT ? undefined : id as 'agent' | 'disabled' });
                setOpenMenu(null);
            }}
        />
    </ItemGroup>;
}
