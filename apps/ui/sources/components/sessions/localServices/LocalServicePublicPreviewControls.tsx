import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type {
    LocalServiceLaunchTargetV1,
    LocalServicePublicExposureModeV1,
    LocalServicePublicExposureV1,
} from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import {
    DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS,
    type LocalServicePublicPreviewActions,
    type LocalServicePublicPreviewCreateOptions,
} from '@/components/sessions/localServices/publicPreviewActions';
import {
    selectLocalServicePublicExposureExpiry,
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The lifetimes offered at create time, narrowed by the server's `maxTtlMs`. */
const PUBLIC_PREVIEW_TTL_CHOICES_MS: readonly number[] = [
    10 * MINUTE_MS,
    HOUR_MS,
    8 * HOUR_MS,
    24 * HOUR_MS,
];

const PUBLIC_PREVIEW_MODE_LABEL_KEYS = {
    secret_link: 'localServices.publicPreview.secretLinkMode',
    authenticated: 'localServices.publicPreview.authenticatedMode',
    public: 'localServices.publicPreview.publicMode',
} as const satisfies Record<LocalServicePublicExposureModeV1, string>;

function modeLabel(mode: LocalServicePublicExposureModeV1): string {
    return t(PUBLIC_PREVIEW_MODE_LABEL_KEYS[mode]);
}

function ttlChoiceLabel(ttlMs: number): string {
    if (ttlMs >= DAY_MS) return t('localServices.publicPreview.ttlOptionDays', { count: Math.round(ttlMs / DAY_MS) });
    if (ttlMs >= HOUR_MS) return t('localServices.publicPreview.ttlOptionHours', { count: Math.round(ttlMs / HOUR_MS) });
    return t('localServices.publicPreview.ttlOptionMinutes', { count: Math.round(ttlMs / MINUTE_MS) });
}

/**
 * Remaining lifetime as plain text (G15).
 *
 * Deliberately not a ticking countdown: lane F0 owns the live, second-granular treatment. This is
 * the honest data — recomputed on every render the daemon watch triggers — so the link stops
 * claiming to be usable after its deadline even before F0's motion lands.
 */
function expiresInLabel(remainingMs: number): string {
    if (remainingMs >= DAY_MS) {
        return t('localServices.publicPreview.expiresInDays', { count: Math.floor(remainingMs / DAY_MS) });
    }
    if (remainingMs >= HOUR_MS) {
        return t('localServices.publicPreview.expiresInHours', { count: Math.floor(remainingMs / HOUR_MS) });
    }
    return t('localServices.publicPreview.expiresInMinutes', { count: Math.floor(remainingMs / MINUTE_MS) });
}

function resolveTtlChoices(maxTtlMs: number | undefined): readonly number[] {
    const withinPolicy = typeof maxTtlMs === 'number'
        ? PUBLIC_PREVIEW_TTL_CHOICES_MS.filter((choice) => choice <= maxTtlMs)
        : PUBLIC_PREVIEW_TTL_CHOICES_MS;
    // A policy tighter than the shortest offer still gets one honest option: its own ceiling.
    if (withinPolicy.length > 0) return withinPolicy;
    return [typeof maxTtlMs === 'number' && maxTtlMs > 0 ? maxTtlMs : DEFAULT_LOCAL_SERVICE_PUBLIC_PREVIEW_TTL_MS];
}

/**
 * One bounded choice through the canonical modal owner. Resolves to the picked value, or `null`
 * when the user backs out — cancelling anywhere in the flow creates nothing.
 */
async function pickOne<TValue>(input: Readonly<{
    title: string;
    message?: string;
    choices: readonly Readonly<{ value: TValue; label: string }>[];
}>): Promise<TValue | null> {
    return await new Promise<TValue | null>((resolve) => {
        let picked: TValue | null = null;
        void Modal.alertAsync(
            input.title,
            input.message,
            [
                ...input.choices.map((choice) => ({
                    text: choice.label,
                    onPress: () => {
                        picked = choice.value;
                    },
                })),
                { text: t('common.cancel'), style: 'cancel' as const },
            ],
        ).then(() => resolve(picked));
    });
}

function ExposureActions(props: Readonly<{
    exposure: LocalServicePublicExposureV1;
    expired: boolean;
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
                // Copying a link that has already expired hands someone a dead URL.
                disabled={props.expired}
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

    const allowedModes = state.policy?.allowedModes ?? [];
    const ttlChoices = resolveTtlChoices(state.policy?.maxTtlMs);
    const nowMs = Date.now();

    // UX-5: creating a public exposure makes the local service reachable on the internet, so it must
    // pass an explicit human confirmation before the (already daemon-enforced) create action fires.
    // UB-4: the shape of that exposure is now the user's choice within the server policy instead of
    // one hard-coded `secret_link` + 10 minutes, so the link's lifetime is something they picked and
    // can therefore expect to end.
    const confirmAndCreate = async (target: PublicPreviewTarget): Promise<void> => {
        const confirmed = await Modal.confirm(
            t('localServices.publicPreview.confirmTitle'),
            t('localServices.publicPreview.confirmMessage', { service: target.title }),
            { confirmText: t('localServices.publicPreview.confirmCta'), destructive: true },
        );
        if (!confirmed) {
            return;
        }
        // Only ask about the mode when the server actually allows more than one; a single-mode
        // policy must not grow a decision the user cannot make.
        const mode = allowedModes.length > 1
            ? await pickOne<LocalServicePublicExposureModeV1>({
                title: t('localServices.publicPreview.modePromptTitle'),
                choices: allowedModes.map((allowed) => ({ value: allowed, label: modeLabel(allowed) })),
            })
            : allowedModes[0] ?? 'secret_link';
        if (!mode) {
            return;
        }
        const ttlMs = ttlChoices.length > 1
            ? await pickOne<number>({
                title: t('localServices.publicPreview.ttlPromptTitle'),
                message: t('localServices.publicPreview.ttlPromptMessage', { service: target.title }),
                choices: ttlChoices.map((choice) => ({ value: choice, label: ttlChoiceLabel(choice) })),
            })
            : ttlChoices[0];
        if (!ttlMs) {
            return;
        }
        const options: LocalServicePublicPreviewCreateOptions = { mode, ttlMs };
        await actions.create(target.target, options);
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
