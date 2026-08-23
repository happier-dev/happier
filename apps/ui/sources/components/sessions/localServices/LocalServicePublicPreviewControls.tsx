import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type {
    LocalServiceLaunchTargetV1,
    LocalServicePublicExposureV1,
} from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { LocalServicePublicPreviewActions } from '@/components/sessions/localServices/publicPreviewActions';
import {
    selectLocalServicePublicPreviewRows,
    selectLocalServicePublicPreviewRowsForPreview,
    type LocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';
import {
    resolveLocalServicePreviewUnavailableSubtitle,
    resolveLocalServicePublicPreviewCreateDisabledSubtitle,
} from '@/sync/domains/local/services/publicPreview/presentation';
import { useLocalServiceCapabilityDisabledReasons } from '@/hooks/server/useLocalServiceCapabilityDisabledReasons';
import { t } from '@/text';

type PublicPreviewTarget = Readonly<{
    target: LocalServiceLaunchTargetV1;
    previewId: string | null;
    targetKey: string;
    title: string;
}>;

type PublicPreviewCreatableTarget = PublicPreviewTarget & Readonly<{
    previewId: string;
}>;

type PublicPreviewDisabledTarget = PublicPreviewTarget & Readonly<{
    subtitle: string;
}>;

const stylesheet = StyleSheet.create(() => ({
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));

function readTargetPreviewId(target: LocalServiceLaunchTargetV1): string | null {
    const browserTarget = target.browserTarget;
    return browserTarget?.kind === 'localServicePreview' && browserTarget.targetId.trim().length > 0
        ? browserTarget.targetId.trim()
        : null;
}

function publicPreviewTargets(targets: readonly LocalServiceLaunchTargetV1[]): readonly PublicPreviewTarget[] {
    return targets
        .map((target): PublicPreviewTarget | null => {
            const previewId = readTargetPreviewId(target);
            const supportsDisabledStatus = target.source === 'inventory_entry'
                && target.browserTarget?.kind === 'externalUrl';
            if (!previewId && !supportsDisabledStatus) {
                return null;
            }
            return {
                target,
                previewId,
                targetKey: previewId ?? target.id,
                title: target.title,
            };
        })
        .filter((target): target is PublicPreviewTarget => Boolean(target));
}

function hasPreviewId(target: PublicPreviewTarget): target is PublicPreviewCreatableTarget {
    return typeof target.previewId === 'string' && target.previewId.length > 0;
}

function activeExposuresForPreview(
    state: LocalServicePublicPreviewState,
    previewId: string,
): readonly LocalServicePublicExposureV1[] {
    return selectLocalServicePublicPreviewRowsForPreview(state, previewId)
        .filter((exposure) => exposure.state === 'active');
}

function activeExposuresForTarget(
    state: LocalServicePublicPreviewState,
    target: PublicPreviewTarget,
): readonly LocalServicePublicExposureV1[] {
    return hasPreviewId(target) ? activeExposuresForPreview(state, target.previewId) : [];
}

function ExposureActions(props: Readonly<{
    exposure: LocalServicePublicExposureV1;
    actions: LocalServicePublicPreviewActions;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const confirmAndRevoke = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('localServices.publicPreview.revokeConfirmTitle'),
            t('localServices.publicPreview.revokeConfirmMessage', { url: props.exposure.publicUrl }),
            { confirmText: t('localServices.publicPreview.revokeConfirmCta'), destructive: true },
        );
        if (confirmed) {
            await props.actions.revoke(props.exposure);
        }
    }, [props.actions, props.exposure]);
    return (
        <View style={styles.actionRow}>
            <IconButton
                testID={`${props.testID}-copy`}
                iconName="copy"
                accessibilityLabel={t('common.copy')}
                onPress={() => props.actions.copyUrl(props.exposure)}
            />
            <IconButton
                testID={`${props.testID}-revoke`}
                iconName="x-circle"
                accessibilityLabel={t('localServices.publicPreview.revokeActionA11y')}
                tone="danger"
                onPress={confirmAndRevoke}
            />
        </View>
    );
}

export function LocalServicePublicPreviewControls(props: Readonly<{
    launchTargets: readonly LocalServiceLaunchTargetV1[];
    state: LocalServicePublicPreviewState | null | undefined;
    actions?: LocalServicePublicPreviewActions;
    testID?: string;
}>): React.ReactElement | null {
    // The server names the exact unmet prerequisite; without it every disabled row says the same
    // generic sentence and an operator cannot tell which variable is wrong (audit P1-3).
    const capabilityDisabledReasons = useLocalServiceCapabilityDisabledReasons();
    const state = props.state;
    const actions = props.actions;
    if (!state || !actions) {
        return null;
    }

    const targets = publicPreviewTargets(props.launchTargets);
    const activeExposures = targets.flatMap((target) => (
        activeExposuresForTarget(state, target)
    ));
    const activeExposureCount = selectLocalServicePublicPreviewRows(state)
        .filter((exposure) => exposure.state === 'active')
        .length;
    const targetRows = targets.map((target) => ({
        target,
        activeExposures: activeExposuresForTarget(state, target),
        createDisabledSubtitle: resolveLocalServicePublicPreviewCreateDisabledSubtitle({
            state,
            activeExposureCount,
            previewId: target.previewId,
            capabilityDisabledReasons: capabilityDisabledReasons.publicPreview,
        }),
    }));
    const creatableTargets: readonly PublicPreviewCreatableTarget[] = targetRows
        .filter((row) => !row.createDisabledSubtitle)
        .map((row) => row.target)
        .filter(hasPreviewId);
    const disabledTargets: readonly PublicPreviewDisabledTarget[] = targetRows
        .filter((row) => row.activeExposures.length === 0)
        .map((row): PublicPreviewDisabledTarget | null => {
            const subtitle = hasPreviewId(row.target)
                ? row.createDisabledSubtitle
                : (row.createDisabledSubtitle ?? resolveLocalServicePreviewUnavailableSubtitle({
                    capabilityDisabledReasons: capabilityDisabledReasons.preview,
                }));
            return subtitle ? { ...row.target, subtitle } : null;
        })
        .filter((target): target is PublicPreviewDisabledTarget => Boolean(target));
    if (activeExposures.length === 0 && creatableTargets.length === 0 && disabledTargets.length === 0) {
        return null;
    }

    const testID = props.testID ?? 'local-service-public-preview-controls';

    // UX-5: creating a public exposure makes the local service reachable on the internet, so it must
    // pass an explicit human confirmation before the (already daemon-enforced) create action fires.
    const confirmAndCreate = async (target: PublicPreviewTarget): Promise<void> => {
        const confirmed = await Modal.confirm(
            t('localServices.publicPreview.confirmTitle'),
            t('localServices.publicPreview.confirmMessage', { service: target.title }),
            { confirmText: t('localServices.publicPreview.confirmCta'), destructive: true },
        );
        if (confirmed) {
            await actions.create(target.target);
        }
    };

    return (
        <View testID={testID}>
            <ItemGroup
                title={t('localServices.publicPreview.title')}
                selectableItemCountOverride={activeExposures.length + creatableTargets.length + disabledTargets.length}
            >
                {creatableTargets.map((target) => (
                    <Item
                        key={`create:${target.previewId}`}
                        testID={`${testID}-target:${target.previewId}`}
                        title={target.title}
                        subtitle={t('localServices.publicPreview.createSubtitle')}
                        detail={t('localServices.publicPreview.secretLinkMode')}
                        detailTestID={`${testID}-target:${target.previewId}-mode`}
                        mode="info"
                        showChevron={false}
                        rightElement={(
                            <IconButton
                                testID={`${testID}-target:${target.previewId}-create`}
                                iconName="link"
                                accessibilityLabel={t('localServices.publicPreview.createActionA11y')}
                                onPress={() => confirmAndCreate(target)}
                            />
                        )}
                    />
                ))}
                {disabledTargets.map((target) => (
                    <Item
                        key={`disabled:${target.targetKey}`}
                        testID={`${testID}-target:${target.targetKey}-disabled`}
                        title={target.title}
                        subtitle={target.subtitle}
                        detail={t('localServices.publicPreview.secretLinkMode')}
                        detailTestID={`${testID}-target:${target.targetKey}-disabled-mode`}
                        mode="info"
                        showChevron={false}
                    />
                ))}
                {activeExposures.map((exposure) => (
                    <Item
                        key={`exposure:${exposure.exposureId}`}
                        testID={`${testID}-exposure:${exposure.exposureId}`}
                        title={exposure.publicUrl}
                        subtitle={t('localServices.publicPreview.activeSubtitle')}
                        detail={t('localServices.publicPreview.secretLinkMode')}
                        detailTestID={`${testID}-exposure:${exposure.exposureId}-mode`}
                        mode="info"
                        showChevron={false}
                        rightElement={(
                            <ExposureActions
                                exposure={exposure}
                                actions={actions}
                                testID={`${testID}-exposure:${exposure.exposureId}`}
                            />
                        )}
                    />
                ))}
            </ItemGroup>
        </View>
    );
}
