import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { t } from '@/text';
import type {
    PluginChangePendingReviewResult,
    PluginInstallationReview,
} from '@happier-dev/protocol/marketplace/internal';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveHappierFocusRingVisible } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

type AuthorityExpansion = Extract<PluginChangePendingReviewResult, Readonly<{
    kind: 'reviewRequired';
    reviewKind: 'installation';
}>>['authorityExpansion'];

export type PluginInstallationReviewResolution =
    | Readonly<{
        approved: true;
        optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
    }>
    | Readonly<{
        approved: false;
        optionalSelections: readonly [];
    }>;

type PluginInstallationReviewDialogProps = CustomModalInjectedProps & Readonly<{
    review: PluginInstallationReview;
    reason?: 'firstInstall' | 'authorityExpansion';
    currentVersion?: string | null;
    authorityExpansion?: AuthorityExpansion;
    /**
     * The exact machine and server this install-and-trust decision lands on.
     *
     * Trust is granted on ONE machine reached through ONE server. A review that
     * names only the package describes a decision the user cannot locate, and
     * the identical wording against a different selected target is a different,
     * irreversible grant.
     */
    target: Readonly<{ machine: string; server: string }>;
    onResolve: (resolution: PluginInstallationReviewResolution) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flexGrow: 1,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 20,
        gap: 16,
    },
    reviewBody: {
        ...Typography.default(),
        color: theme.colors.text.primary,
    },
    section: {
        gap: 6,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    sectionBody: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    reviewTarget: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    optionalList: {
        gap: 8,
    },
    optionalRow: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    optionalCopy: {
        flex: 1,
        gap: 2,
    },
    optionalTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    optionalReason: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    switch: {
        minWidth: 44,
        minHeight: 44,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 8,
    },
    action: {
        minHeight: 44,
        flexShrink: 1,
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderRadius: 12,
    },
    cancelAction: {
        backgroundColor: theme.colors.surface.inset,
    },
    confirmAction: {
        backgroundColor: theme.colors.button.primary.background,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    confirmText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.primary.tint,
    },
}));

function valueOrNone(values: readonly string[]): string {
    return values.length > 0 ? values.join('\n') : t('settingsPlugins.installReviewSections.none');
}

const SCOPE_NESTING_INDENT = '  ';

function formatScopeValueLines(value: unknown, depth: number): readonly string[] {
    const indent = SCOPE_NESTING_INDENT.repeat(depth);
    if (value === null || typeof value !== 'object') {
        return [`${indent}${String(value)}`];
    }
    if (Array.isArray(value)) {
        return value.every((entry) => entry === null || typeof entry !== 'object')
            ? [`${indent}${value.map((entry) => String(entry)).join(', ')}`]
            : value.flatMap((entry) => formatScopeValueLines(entry, depth));
    }
    return Object.entries(value).flatMap(([key, entry]) => (
        entry !== null && typeof entry === 'object'
            ? [`${indent}${key}:`, ...formatScopeValueLines(entry, depth + 1)]
            : [`${indent}${key}: ${String(entry)}`]
    ));
}

/**
 * Normalized host scope is a bounded plain-data record, so it reads as
 * `key: value` lines instead of a serialized JSON blob. Nesting renders as
 * indentation; the review schema bounds depth and cardinality.
 */
function formatNormalizedScope(scope: Readonly<Record<string, unknown>>): string {
    return formatScopeValueLines(scope, 0).join('\n');
}

function sourceKindLabel(kind: PluginInstallationReview['source']['kind']): string {
    if (kind === 'path') return t('settingsPlugins.installReviewSections.sourceKind.path');
    if (kind === 'archive') return t('settingsPlugins.installReviewSections.sourceKind.archive');
    return t('settingsPlugins.installReviewSections.sourceKind.npm');
}

function marketplaceSourceKindLabel(kind: NonNullable<Extract<PluginInstallationReview['updateChannel'], { kind: 'npm' }>['marketplaceSource']>['kind']): string {
    if (kind === 'curated') return t('settingsPlugins.installReviewSections.marketplaceSourceKind.curated');
    if (kind === 'community-npm') return t('settingsPlugins.installReviewSections.marketplaceSourceKind.community-npm');
    return t('settingsPlugins.installReviewSections.marketplaceSourceKind.user');
}

function executableRealmLabel(realm: PluginInstallationReview['executableRealms'][number]): string {
    if (realm === 'daemon') return t('settingsPlugins.installReviewSections.executableRealm.daemon');
    if (realm === 'hostedWeb') return t('settingsPlugins.installReviewSections.executableRealm.hostedWeb');
    return t('settingsPlugins.installReviewSections.executableRealm.reactNative');
}

function uiArtifactStatusLabel(status: PluginInstallationReview['uiArtifacts']['status']): string {
    if (status === 'verified') return t('settingsPlugins.installReviewSections.uiArtifactStatus.verified');
    if (status === 'unavailable') return t('settingsPlugins.installReviewSections.uiArtifactStatus.unavailable');
    return t('settingsPlugins.installReviewSections.uiArtifactStatus.none');
}

function authorizationClassLabel(authorizationClass: PluginInstallationReview['requiredHostAccess'][number]['authorizationClass']): string {
    if (authorizationClass === 'cooperativeDisclosure') {
        return t('settingsPlugins.installReviewSections.authorizationClass.cooperativeDisclosure');
    }
    if (authorizationClass === 'presentIntentOrOs') {
        return t('settingsPlugins.installReviewSections.authorizationClass.presentIntentOrOs');
    }
    return t('settingsPlugins.installReviewSections.authorizationClass.hostResourceSelection');
}

function credentialRealmLabel(realm: PluginInstallationReview['rawCredentialAccess'][number]['realm']): string {
    if (realm === 'web') return t('settingsPlugins.installReviewSections.realm.web');
    if (realm === 'ios') return t('settingsPlugins.installReviewSections.realm.ios');
    if (realm === 'android') return t('settingsPlugins.installReviewSections.realm.android');
    return t('settingsPlugins.installReviewSections.realm.daemon');
}

function credentialPhaseLabel(phase: PluginInstallationReview['rawCredentialAccess'][number]['phase']): string {
    if (phase === 'settings') return t('settingsPlugins.installReviewSections.phase.settings');
    if (phase === 'prepare') return t('settingsPlugins.installReviewSections.phase.prepare');
    if (phase === 'speech') return t('settingsPlugins.installReviewSections.phase.speech');
    return t('settingsPlugins.installReviewSections.phase.connection');
}

function sourceEvidence(review: PluginInstallationReview): readonly string[] {
    const integrity = review.source.kind === 'path'
        ? t('common.none')
        : review.source.integrityBasis === 'expected'
            ? t('settingsPlugins.installReviewSections.integrityBasis.expected', { integrity: review.source.integrity })
            : t('settingsPlugins.installReviewSections.integrityBasis.observed', { integrity: review.source.integrity });
    const signature = review.signature.status === 'notProvided'
        ? t('common.notProvided')
        : review.signature.status === 'verified'
            ? t('settingsPlugins.installReviewSections.signatureStatus.verified', { keyId: review.signature.keyId })
            : t('settingsPlugins.installReviewSections.signatureStatus.unsupported', { keyId: review.signature.keyId });
    const provenance = review.provenance.status === 'notProvided'
        ? t('common.notProvided')
        : review.provenance.status === 'declaredUnverified'
            ? t('settingsPlugins.installReviewSections.provenanceDeclaredUnverified', {
                predicateType: review.provenance.predicateType,
            })
            : review.provenance.status === 'retrievedUnverified'
                ? t('settingsPlugins.installReviewSections.provenanceRetrievedUnverified', {
                    predicateTypes: review.provenance.predicateTypes.join(', '),
                })
                : t('settingsPlugins.installReviewSections.provenanceUnavailable', {
                    code: review.provenance.code,
                });
    const curation = review.curation.status === 'notApplicable'
        ? t('common.notProvided')
        : review.curation.status === 'unreviewed'
            ? t('settingsPlugins.installReviewSections.curationUnreviewed', {
                sourceId: review.curation.sourceId,
            })
            : t('settingsPlugins.installReviewSections.curationApproved', {
                sourceId: review.curation.sourceId,
                reviewedAt: review.curation.reviewedAt,
                reason: review.curation.reason ? ` · ${review.curation.reason}` : '',
            });
    return [integrity, signature, provenance, curation];
}

function updateChannel(review: PluginInstallationReview): string {
    if (review.updateChannel.kind === 'path') {
        return review.updateChannel.development
            ? t('settingsPlugins.installReviewSections.developmentPath', { locator: review.updateChannel.locator })
            : review.updateChannel.locator;
    }
    if (review.updateChannel.kind === 'archive') return review.updateChannel.locator;
    const source = review.updateChannel.marketplaceSource;
    return [
        `${review.updateChannel.packageName} · ${review.updateChannel.registryOrigin}`,
        review.updateChannel.registryProfileId,
        source ? t('settingsPlugins.installReviewSections.marketplaceSource', {
            kind: marketplaceSourceKindLabel(source.kind),
            source: `${source.id} · ${source.sourceUrl}`,
        }) : null,
    ].filter((entry): entry is string => Boolean(entry)).join('\n');
}

function credentialRequestLine(request: PluginInstallationReview['rawCredentialAccess'][number]['request']): string {
    if (request.kind === 'httpHeaders') {
        return t('settingsPlugins.installReviewSections.credentialRequestHeaders', {
            origin: request.origin,
            headers: request.headerNames.join(', '),
        });
    }
    if (request.kind === 'environment') {
        return t('settingsPlugins.installReviewSections.credentialRequestEnvironment', {
            keys: request.keys.join(', '),
        });
    }
    return t('settingsPlugins.installReviewSections.credentialRequestFiles', {
        files: request.fileIds.join(', '),
    });
}

function credentialSourceLines(entry: PluginInstallationReview['rawCredentialAccess'][number]): readonly string[] {
    const sourceLines = entry.sourceClass.kind === 'savedSecret'
        ? [
            t('settingsPlugins.installReviewSections.savedSecret'),
            t('settingsPlugins.installReviewSections.secretKinds', {
                kinds: entry.sourceClass.secretKinds.join(', '),
            }),
        ]
        : [
            t('settingsPlugins.installReviewSections.connectedAccount'),
            t('settingsPlugins.installReviewSections.connectedAccountService', {
                service: `${entry.sourceClass.service.pluginId}/${entry.sourceClass.service.localId}`,
            }),
        ];
    return [
        `${entry.contribution.pluginId}/${entry.contribution.localId} · ${entry.credentialSlot.title}`,
        ...sourceLines,
        t('settingsPlugins.installReviewSections.credentialPurpose', { purpose: entry.credentialSlot.purpose }),
        t('settingsPlugins.installReviewSections.credentialUse', {
            realm: credentialRealmLabel(entry.realm),
            phase: credentialPhaseLabel(entry.phase),
        }),
        t('settingsPlugins.installReviewSections.credentialAccess', { access: credentialRequestLine(entry.request) }),
    ];
}

function ReviewSection(props: Readonly<{
    testID: string;
    title: string;
    lines: readonly string[];
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.section}>
            <Text style={stylesheet.sectionTitle} accessibilityRole="header">{props.title}</Text>
            <Text style={stylesheet.sectionBody}>{valueOrNone(props.lines)}</Text>
        </View>
    );
}

export function PluginInstallationReviewDialog(props: PluginInstallationReviewDialogProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const [selectedByAccessId, setSelectedByAccessId] = React.useState<Readonly<Record<string, boolean>>>({});
    const [evidenceExpanded, setEvidenceExpanded] = React.useState(false);
    const isAuthorityExpansion = props.reason === 'authorityExpansion';
    const authorityExpansion = new Set(props.authorityExpansion ?? []);
    // Code changes of already-trusted plugins never reopen review, so a
    // delta-only decision shows only the widened access.
    const showsExecutableCode = !isAuthorityExpansion;
    const showsRequiredAccess = !isAuthorityExpansion
        || authorityExpansion.has('requiredHostAccess')
        || authorityExpansion.has('connectedAccountPurpose');
    const showsOptionalAccess = !isAuthorityExpansion
        || authorityExpansion.has('selectedOptionalHostAccess');
    const showsRequestInterceptors = !isAuthorityExpansion
        || authorityExpansion.has('requestInterceptor');
    const showsRawCredentials = !isAuthorityExpansion
        || authorityExpansion.has('rawCredentialAccess');

    const resolve = React.useCallback((resolution: PluginInstallationReviewResolution) => {
        props.onResolve(resolution);
        props.onClose();
    }, [props]);

    const approve = React.useCallback(() => {
        const optionalSelections = isAuthorityExpansion
            ? Object.entries(selectedByAccessId).map(([accessId, selected]) => ({ accessId, selected }))
            : props.review.optionalHostAccess.map((entry) => ({
                accessId: entry.id,
                selected: selectedByAccessId[entry.id] === true,
            }));
        resolve({
            approved: true,
            optionalSelections: showsOptionalAccess ? optionalSelections : [],
        });
    }, [isAuthorityExpansion, props.review.optionalHostAccess, resolve, selectedByAccessId, showsOptionalAccess]);

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
        >
            <ReviewSection
                testID="settings.plugins.installReview.identity"
                title={t('settingsPlugins.installReviewSections.identity')}
                lines={[
                    `${props.review.displayName} · ${props.review.version}`,
                    ...(isAuthorityExpansion && props.currentVersion
                        ? [`${props.currentVersion} → ${props.review.version}`]
                        : []),
                    t('settingsPlugins.installReviewSections.source', {
                        kind: sourceKindLabel(props.review.source.kind),
                        locator: props.review.source.locator,
                    }),
                    updateChannel(props.review),
                    props.review.publisherIdentity.status === 'unavailable'
                        ? t('common.unavailable')
                        : t('settingsPlugins.installReviewSections.publisherUnverified', {
                            displayName: props.review.publisherIdentity.displayName,
                            id: props.review.publisherIdentity.id,
                        }),
                ]}
            />
            <Text
                testID="settings.plugins.installReview.target"
                style={styles.reviewTarget}
            >
                {t('settingsPlugins.pluginChangeConfirmTarget', {
                    machine: props.target.machine,
                    server: props.target.server,
                })}
            </Text>
            {props.review.source.kind === 'archive' && /^https?:\/\//u.test(props.review.source.locator) ? (
                <Text testID="settings.plugins.installReview.archiveUrlRetention" style={styles.reviewBody}>
                    {t('settingsPlugins.installReviewSections.archiveUrlRetention')}
                </Text>
            ) : null}
            {!isAuthorityExpansion ? <ReviewSection
                testID="settings.plugins.installReview.trustedCode"
                title={t('settingsPlugins.installReviewSections.trustedCodeTitle')}
                lines={[t('settingsPlugins.installReviewSections.trustedCodeDisclosure')]}
            /> : null}
            {showsExecutableCode ? <ReviewSection
                testID="settings.plugins.installReview.executableCode"
                title={t('settingsPlugins.installReviewSections.executableCode')}
                lines={[
                    ...props.review.executableRealms.map(executableRealmLabel),
                    ...props.review.contributions.map((entry) => `${entry.family} · ${entry.count}`),
                    ...(props.review.uiArtifacts.contributionIds.length > 0
                        ? [t('settingsPlugins.installReviewSections.uiArtifacts', {
                            status: uiArtifactStatusLabel(props.review.uiArtifacts.status),
                            ids: props.review.uiArtifacts.contributionIds.join(', '),
                        })]
                        : [uiArtifactStatusLabel(props.review.uiArtifacts.status)]),
                ]}
            /> : null}
            {showsRequiredAccess ? <ReviewSection
                testID="settings.plugins.installReview.requiredAccess"
                title={t('settingsPlugins.installReviewSections.requiredAccess')}
                lines={props.review.requiredHostAccess.map((entry) => (
                    `${entry.capability} · ${authorizationClassLabel(entry.authorizationClass)}\n${entry.reason}\n${t('settingsPlugins.installReviewSections.scope', {
                        scope: formatNormalizedScope(entry.normalizedScope),
                    })}`
                ))}
            /> : null}
            {showsOptionalAccess && props.review.optionalHostAccess.length > 0 ? (
                <View testID="settings.plugins.installReview.optionalAccess" style={styles.optionalList}>
                    <Text style={styles.sectionTitle} accessibilityRole="header">{t('settingsPlugins.installReviewSections.optionalAccess')}</Text>
                    {props.review.optionalHostAccess.map((entry) => {
                        const selected = selectedByAccessId[entry.id] === true;
                        const accessibilityLabel = `${entry.capability}: ${entry.reason}`;
                        return (
                            <View key={entry.id} style={styles.optionalRow}>
                                <View style={styles.optionalCopy}>
                                    <Text style={styles.optionalTitle}>{entry.capability}</Text>
                                    <Text style={styles.optionalReason}>{entry.reason}</Text>
                                    <Text style={styles.optionalReason}>
                                        {t('settingsPlugins.installReviewSections.scope', {
                                            scope: formatNormalizedScope(entry.normalizedScope),
                                        })}
                                    </Text>
                                </View>
                                <Switch
                                    testID={`settings.plugins.installReview.optional.${entry.id}`}
                                    accessibilityRole="switch"
                                    accessibilityLabel={accessibilityLabel}
                                    accessibilityState={{ checked: selected }}
                                    style={[styles.switch, { minWidth: minimumInteractiveTargetSize, minHeight: minimumInteractiveTargetSize }]}
                                    value={selected}
                                    onValueChange={(next) => {
                                        setSelectedByAccessId((current) => ({
                                            ...current,
                                            [entry.id]: next,
                                        }));
                                    }}
                                />
                            </View>
                        );
                    })}
                </View>
            ) : null}
            {showsRequestInterceptors ? <ReviewSection
                testID="settings.plugins.installReview.requestInterceptors"
                title={t('settingsPlugins.installReviewSections.requestInterceptors')}
                lines={props.review.requestInterceptors.map((entry) => (
                    `${entry.id}\n${entry.origins.join(', ')}\n${entry.methods?.join(', ') ?? t('common.all')} · ${t('settingsPlugins.installReviewSections.priority', { priority: entry.priority })}`
                ))}
            /> : null}
            {showsRawCredentials ? <ReviewSection
                testID="settings.plugins.installReview.rawCredentials"
                title={t('settingsPlugins.installReviewSections.rawCredentials')}
                lines={props.review.rawCredentialAccess.flatMap(credentialSourceLines)}
            /> : null}
            <ExpandableItem
                expanded={evidenceExpanded}
                onExpandedChange={setEvidenceExpanded}
                showDivider={false}
                header={({ expanded, headerProps }) => (
                    <Item
                        {...headerProps}
                        testID="settings.plugins.installReview.evidenceToggle"
                        title={t('settingsPlugins.installReviewSections.evidence')}
                        accessibilityExpanded={expanded}
                        showChevron={false}
                        rightElement={<Icon name={expanded ? 'caret-up' : 'caret-down'} size={20} color={theme.colors.text.secondary} />}
                    />
                )}
            >
                <View testID="settings.plugins.installReview.evidence" style={styles.section}>
                    <Text style={styles.sectionBody}>{valueOrNone([
                        ...sourceEvidence(props.review),
                        props.review.compatibility.happier ?? t('common.notProvided'),
                        t('settingsPlugins.installReviewSections.runtimeApi', {
                            version: props.review.compatibility.runtimeApiVersion,
                        }),
                        ...(props.review.compatibility.blockedNewerVersions ?? []).map((entry) => (
                            `${entry.version}: ${entry.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`
                        )),
                    ])}</Text>
                </View>
            </ExpandableItem>
            <View style={styles.actions}>
                <Pressable
                    testID="settings.plugins.installReview.cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={() => resolve({ approved: false, optionalSelections: [] })}
                    style={(interactionState) => {
                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                        return [
                            styles.action,
                            { minHeight: minimumInteractiveTargetSize },
                            styles.cancelAction,
                            { opacity: interactionState.pressed ? motionTokens.press.opacity : 1 },
                            focusRingStyle({ focused: resolveHappierFocusRingVisible(webState.focused), color: theme.colors.border.focus }),
                        ];
                    }}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    testID="settings.plugins.installReview.confirm"
                    accessibilityRole="button"
                    accessibilityLabel={isAuthorityExpansion ? t('common.update') : t('settingsPlugins.installAndTrust')}
                    onPress={approve}
                    style={(interactionState) => {
                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                        return [
                            styles.action,
                            { minHeight: minimumInteractiveTargetSize },
                            styles.confirmAction,
                            { opacity: interactionState.pressed ? motionTokens.press.opacitySubtle : 1 },
                            focusRingStyle({ focused: resolveHappierFocusRingVisible(webState.focused), color: theme.colors.border.focus }),
                        ];
                    }}
                >
                    <Text style={styles.confirmText}>{isAuthorityExpansion ? t('common.update') : t('settingsPlugins.installAndTrust')}</Text>
                </Pressable>
            </View>
        </ScrollView>
    );
}

export async function showPluginInstallationReviewDialog(params: Readonly<{
    title: string;
    review: PluginInstallationReview;
    reason?: 'firstInstall' | 'authorityExpansion';
    currentVersion?: string | null;
    authorityExpansion?: AuthorityExpansion;
    target: Readonly<{ machine: string; server: string }>;
}>): Promise<PluginInstallationReviewResolution> {
    const deferred = createDeferredOnce<PluginInstallationReviewResolution>();
    Modal.show({
        component: PluginInstallationReviewDialog,
        props: {
            review: params.review,
            reason: params.reason,
            currentVersion: params.currentVersion,
            authorityExpansion: params.authorityExpansion,
            target: params.target,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ approved: false, optionalSelections: [] }),
        onHostUnmount: () => deferred.resolve({ approved: false, optionalSelections: [] }),
        chrome: {
            kind: 'card',
            title: params.title,
            testID: 'settings.plugins.installReview',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 640, maxHeightRatio: 0.9, size: 'lg' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
