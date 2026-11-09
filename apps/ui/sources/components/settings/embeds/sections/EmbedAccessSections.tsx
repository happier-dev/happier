import * as React from 'react';
import type { ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { deriveEmbedAccessFromGrantV1 } from '@happier-dev/protocol/embed';

import {
    ApiTokenGrantApproveRow,
    ApiTokenGrantWebsitesSection,
} from '@/components/settings/apiTokens/grant/ApiTokenGrantEditor';
import { useApiTokenGrantNames } from '@/components/settings/apiTokens/grant/useApiTokenGrantCatalogs';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { buildEmbedGrant, type EmbedDraft } from '../embedDraft';
import { EMBED_SETTINGS } from '../embedsSettings';

export type EmbedDraftSectionProps = Readonly<{
    draft: EmbedDraft;
    onChange: (next: EmbedDraft) => void;
    disabled?: boolean;
}>;

/**
 * The grant editor's parts edit a whole grant; an embed's enforced options are the projection of its
 * one parent grant, so the parts read the built grant and every change is projected back
 * (`deriveEmbedAccessFromGrantV1` is the exact inverse of `buildEmbedParentGrantV1`).
 */
export function useEmbedGrantPart(props: EmbedDraftSectionProps) {
    const { draft, onChange } = props;
    // "Only these models" starts with none chosen: the parts see that list, the grant waits for one.
    const value = React.useMemo(() => {
        const models = draft.access.models;
        return models !== null && models.length === 0
            ? { ...buildEmbedGrant({ ...draft, access: { ...draft.access, models: null } }), models }
            : buildEmbedGrant(draft);
    }, [draft]);
    const change = React.useCallback((next: ApiTokenGrantV1) => {
        const choosing = next.models !== null && next.models.length === 0;
        const access = deriveEmbedAccessFromGrantV1(choosing ? { ...next, models: null } : next);
        onChange({ ...draft, access: choosing ? { ...access, models: [] } : access });
    }, [draft, onChange]);
    return { value, onChange: change, disabled: props.disabled };
}

/** Where it can appear: the allowed sites (`grant.origins`), through the grant editor's websites part. */
export const EmbedSitesSection = React.memo(function EmbedSitesSection(props: EmbedDraftSectionProps) {
    const part = useEmbedGrantPart(props);
    return (
        <SettingAnchor setting={EMBED_SETTINGS.settings.sites}>
            <ApiTokenGrantWebsitesSection
                {...part}
                title={t('settingsEmbeds.sites.title')}
                description={t('settingsEmbeds.sites.description')}
            />
        </SettingAnchor>
    );
});

/** What people can do: every row is enforced by the grant (plan 04 §4.2). */
export const EmbedCapabilitiesSection = React.memo(function EmbedCapabilitiesSection(props: EmbedDraftSectionProps & Readonly<{
    onOpenPermissionModes: () => void;
    permissionModesSummary: string;
}>) {
    const part = useEmbedGrantPart(props);
    const { draft, onChange, disabled } = props;
    const setAccess = (patch: Partial<EmbedDraft['access']>) => onChange({ ...draft, access: { ...draft.access, ...patch } });
    return (
        <ItemGroup title={t('settingsEmbeds.capabilities.title')}>
            <Item
                testID="settings-embed-view"
                title={t('settingsEmbeds.capabilities.view')}
                detail={t('settingsEmbeds.capabilities.always')}
                showChevron={false}
                mode="info"
            />
            <SettingRow
                setting={EMBED_SETTINGS.settings.send}
                testID="settings-embed-send"
                showChevron={false}
                rightElement={(
                    <Switch
                        testID="settings-embed-send-switch"
                        accessibilityLabel={t('settingsEmbeds.capabilities.send')}
                        value={draft.access.send}
                        disabled={disabled}
                        onValueChange={(send) => setAccess({ send })}
                    />
                )}
            />
            <SettingAnchor setting={EMBED_SETTINGS.settings.approve}>
                <ApiTokenGrantApproveRow {...part} onDescription={t('settingsEmbeds.capabilities.approveOn')} />
            </SettingAnchor>
            <SettingRow
                setting={EMBED_SETTINGS.settings.changeModel}
                testID="settings-embed-change-model"
                showChevron={false}
                rightElement={(
                    <Switch
                        testID="settings-embed-change-model-switch"
                        accessibilityLabel={t('settingsEmbeds.capabilities.changeModel')}
                        value={draft.access.changeModel}
                        disabled={disabled}
                        onValueChange={(changeModel) => setAccess({ changeModel })}
                    />
                )}
            />
            <SettingRow
                setting={EMBED_SETTINGS.settings.permissionModes}
                testID="settings-embed-permission-modes"
                detail={props.permissionModesSummary}
                disabled={disabled}
                onPress={props.onOpenPermissionModes}
            />
        </ItemGroup>
    );
});

/** Models: "Any model" or the allowed set; other models are refused by the grant, not just hidden. */
export const EmbedModelsSection = React.memo(function EmbedModelsSection(props: EmbedDraftSectionProps & Readonly<{
    onOpenModels: () => void;
}>) {
    const names = useApiTokenGrantNames();
    const models = props.draft.access.models;
    const summary = models === null
        ? t('settingsEmbeds.models.any')
        : models.length === 1
            ? names.modelName(models[0]!) ?? models[0]!.modelId
            : t('settingsEmbeds.summary.models', { count: models.length });
    return (
        <ItemGroup title={t('settingsEmbeds.models.title')} description={t('settingsEmbeds.models.description')}>
            <SettingRow
                setting={EMBED_SETTINGS.settings.allowedModels}
                testID="settings-embed-models"
                detail={summary}
                disabled={props.disabled}
                onPress={props.onOpenModels}
            />
        </ItemGroup>
    );
});

/** Composer: presentation only; on shows the attach button, off hides it while uploads stay governed by Send. */
export const EmbedComposerSection = React.memo(function EmbedComposerSection(props: EmbedDraftSectionProps) {
    const { draft, onChange } = props;
    return (
        <ItemGroup title={t('settingsEmbeds.composer.title')}>
            <SettingRow
                setting={EMBED_SETTINGS.settings.attachments}
                testID="settings-embed-attachments"
                subtitleLines={0}
                showChevron={false}
                rightElement={(
                    <Switch
                        testID="settings-embed-attachments-switch"
                        accessibilityLabel={t('settingsEmbeds.composer.attachments')}
                        value={draft.config.ui.attachments}
                        disabled={props.disabled}
                        onValueChange={(attachments) => onChange({ ...draft, config: { ...draft.config, ui: { ...draft.config.ui, attachments } } })}
                    />
                )}
            />
        </ItemGroup>
    );
});
