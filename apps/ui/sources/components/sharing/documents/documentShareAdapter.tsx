import { useShareGrantRowPresentation } from '@/components/sharing/sharePresentationHost';
import type { ArtifactAccessGrantRowV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { classifyArtifactBrowserKind } from '@/components/artifacts/artifactBrowserModel';
import { Text } from '@/components/ui/text/Text';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { ShareAccessLevel, ShareLevelPresentation, ShareSheetAdapter, ShareUiError, ShareUiReason } from '../shareSheetTypes';
import { ShareRowAction } from '@happier-dev/plugin-ui/components';
import { sharePrincipalKey } from '../sharePrincipalPresentation';
import type { DocumentLinkedWorkflowOffer } from './useLinkedWorkflowShareOffer';

const styles = StyleSheet.create((theme) => ({
    versionReports: { color: theme.colors.text.secondary },
}));

/**
 * The header kind of the ordinary Account Artifact being shared (`null` for an untyped document).
 * Every ordinary kind shares through this one adapter; the Artifacts browser model names the kind.
 */
export type DocumentShareKind = string | null;

/** Sanitized review text and repairs admitted by the existing widget input owner. */
export type DocumentPrivateChoice = Readonly<{
    id: string;
    widget: string;
    service?: string;
    removeChoice?: () => void;
    letViewersPick?: () => void;
    loading?: boolean;
    issue?: ShareUiError;
}>;

function documentUseHelp(artifactId: string, kind: DocumentShareKind): string {
    switch (kind) {
        case 'widget-area-layout.v1': return t('shareSheet.documents.help.dashboardUse');
        case 'workflow-definition.v1': return t('shareSheet.documents.help.workflowUse');
        case 'role.v1': return t('shareSheet.documents.help.roleUse');
        case 'launch-profile.v1': return t('shareSheet.documents.help.profileUse');
    }
    switch (classifyArtifactBrowserKind({ id: artifactId, header: kind === null ? null : { title: null, kind } })) {
        case 'prompt': return t('shareSheet.documents.help.promptUse');
        case 'board': return t('shareSheet.documents.help.boardUse');
        default: return t('shareSheet.documents.help.documentUse');
    }
}

/** A document or board is read; everything that runs or is used in a session keeps "Can use". */
function documentViewLabel(artifactId: string, kind: DocumentShareKind): string {
    if (kind === 'bot_template.v1') return t('botTemplates.canCopy');
    if (kind === 'widget-area-layout.v1') return t('shareSheet.documents.levels.canRead');
    const browserKind = classifyArtifactBrowserKind({ id: artifactId, header: kind === null ? null : { title: null, kind } });
    return browserKind === 'document' || browserKind === 'memory' || browserKind === 'board'
        ? t('shareSheet.documents.levels.canRead')
        : t('shareSheet.documents.levels.canUse');
}

/** One recipient-level vocabulary for the sheet and compact document summaries. */
export function documentShareAccessLabel(artifactId: string, kind: DocumentShareKind, access: ShareAccessLevel): string {
    return access === 'view' ? documentViewLabel(artifactId, kind)
        : access === 'edit' ? t('shareSheet.documents.levels.canEdit') : t('shareSheet.documents.levels.admin');
}

/**
 * The kind's sharing rules. A workflow shared with a Team shows that Team every run; anyone else's
 * runs and triggers stay their own. A profile never carries a secret value.
 */
function documentShareNotes(kind: DocumentShareKind, grants: readonly ArtifactAccessGrantRowV1[]): readonly string[] {
    switch (kind) {
        case 'widget-area-layout.v1': return [t('shareSheet.documents.notes.dashboardAccess')];
        case 'workflow-definition.v1': {
            const team = grants.some((row) => row.principal.kind === 'team');
            const personal = grants.length === 0 || grants.some((row) => row.principal.kind !== 'team');
            return [
                ...(personal ? [t('shareSheet.documents.notes.personalRuns')] : []),
                ...(team ? [t('shareSheet.documents.notes.teamRuns')] : []),
            ];
        }
        case 'role.v1': return [t('shareSheet.documents.notes.roleLive')];
        case 'launch-profile.v1': return [t('shareSheet.documents.notes.profileSecrets')];
        default: return [];
    }
}

/**
 * The documents meaning of the one share sheet, over the Artifact grants of every ordinary kind:
 * "Can read" (documents, boards) or "Can use" (everything that runs) / "Can edit" / "Admin", the
 * kind's own help and rules, Copy link and Send a copy instead when the host supplies them.
 */
export function createDocumentShareAdapter(input: Readonly<{
    artifactId: string;
    kind: DocumentShareKind;
    description?: string;
    grants: readonly ArtifactAccessGrantRowV1[];
    privateChoices?: readonly DocumentPrivateChoice[];
    /** A shared profile's own linked Workflows, offered to its newly added recipients. */
    linkedWorkflows?: DocumentLinkedWorkflowOffer;
    linkPath?: string;
    sendCopy?: () => void;
    loading: boolean;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    readOnly: boolean;
    retryContent(): void;
}>): ShareSheetAdapter & Readonly<{ levels: Readonly<Record<ShareAccessLevel, ShareLevelPresentation>> }> {
    const versionReports = input.kind === 'bot_template.v1'
        ? new Map(input.grants.map(grant => [sharePrincipalKey(grant.principal), grant.acceptedVersions === undefined
            ? [t('botTemplates.versionReportsUnavailable')]
            : grant.acceptedVersions.length === 0 ? [t('botTemplates.noVersionReported')]
                : grant.acceptedVersions.map(report => t('botTemplates.acceptedVersionReport', report))]))
        : null;
    return {
        namespace: 'document-share',
        title: t('shareSheet.documents.title'),
        description: input.description,
        levels: {
            view: { label: documentShareAccessLabel(input.artifactId, input.kind, 'view'), help: documentUseHelp(input.artifactId, input.kind) },
            edit: { label: documentShareAccessLabel(input.artifactId, input.kind, 'edit'), help: t('shareSheet.documents.help.editForEveryone') },
            admin: { label: documentShareAccessLabel(input.artifactId, input.kind, 'admin'), help: t('shareSheet.documents.help.adminOwnerShares') },
        },
        notes: documentShareNotes(input.kind, input.grants),
        ...(versionReports ? {
            principalTags: (principal, row) => row ? versionReports.get(principal.key) ?? [] : [],
            renderGrantDetails: (row, context) => <Text variant="meta" style={styles.versionReports}
                testID={`${context.idPrefix}document-share-version-reports:${row.principal.key}`}>
                {versionReports.get(row.principal.key)?.join('\n')}
            </Text>,
        } satisfies Partial<ShareSheetAdapter> : {}),
        ...(input.linkPath && input.kind !== 'widget-area-layout.v1' ? { linkPath: input.linkPath } : {}),
        ...(input.sendCopy ? { sendCopy: input.sendCopy } : {}),
        sections: (context) => {
            const linked = input.linkedWorkflows;
            const linkedSection = linked ? [{ kind: 'static' as const, id: 'linked-workflows',
                title: t('shareSheet.documents.linkedWorkflows.title', { audience: linked.audienceLabel }),
                rightAccessory: <ShareRowAction useHost={useShareGrantRowPresentation} label={t('shareSheet.documents.linkedWorkflows.notNow')}
                    testID={`${context.idPrefix}document-share-linked-workflows-dismiss`} endsRow onPress={linked.dismiss} />,
                options: [
                    ...linked.choices.map((choice): SelectionListOption => ({ id: `linked-workflow:${choice.ref}`,
                        testID: `${context.idPrefix}document-share-linked-workflow:${choice.ref}`, label: choice.title,
                        ...(choice.issue ? { subtitle: choice.issue.message } : {}),
                        ...(choice.sharing ? { loading: true } : {}),
                        ...(choice.share ? { onSelect: choice.share } : {}),
                        rightAccessoryOutsidePressable: true,
                        rightAccessory: () => choice.shared
                            ? <Text variant="meta" style={styles.versionReports}>{t('shareSheet.documents.linkedWorkflows.shared')}</Text>
                            : <ShareRowAction useHost={useShareGrantRowPresentation} label={t(choice.issue ? 'common.retry' : 'common.share')}
                                testID={`${context.idPrefix}document-share-linked-workflow-share:${choice.ref}`} endsRow
                                disabled={!choice.share} onPress={() => choice.share?.()} /> })),
                    ...(linked.failed ? [{ id: 'linked-workflows-failed', label: t('shareSheet.documents.linkedWorkflows.loadFailed'),
                        rightAccessoryOutsidePressable: true, rightAccessory: () => <ShareRowAction useHost={useShareGrantRowPresentation}
                            label={t('common.retry')} testID={`${context.idPrefix}document-share-linked-workflows-retry`} endsRow
                            onPress={linked.retry} /> }] : []),
                    ...(linked.loadMore ? [{ id: 'linked-workflows-more', testID: `${context.idPrefix}document-share-linked-workflows-more`,
                        label: t('common.more'), onSelect: linked.loadMore }] : []),
                ] }] : [];
            const choices = input.privateChoices ?? [];
            const leading = [...linkedSection, ...(choices.length ? [{ kind: 'static' as const, id: 'private-choices',
                title: t('shareSheet.documents.privateChoices.title'), options: choices.map((choice): SelectionListOption => {
                    const label = choice.service
                        ? t('shareSheet.documents.privateChoices.account', { widget: choice.widget, service: choice.service })
                        : t('shareSheet.documents.privateChoices.authoredInput', { widget: choice.widget });
                    const hasRepairs = choice.letViewersPick !== undefined || choice.removeChoice !== undefined;
                    return { id: choice.id, testID: `${context.idPrefix}document-share-private-choice-${choice.id}`, label,
                        disabled: !context.editable || input.readOnly || choice.loading || !hasRepairs,
                        ...(choice.loading ? { loading: true } : {}),
                        ...(choice.issue ? { subtitle: choice.issue.message }
                            : choice.service && !hasRepairs ? { subtitle: t('shareSheet.documents.privateChoices.authoredInput', { widget: choice.widget }) } : {}),
                        ...(hasRepairs ? { onSelect: () => context.onExpand(choice.id), expandedContentInset: 'text' as const, expandedContent: () => <View>
                            {choice.letViewersPick ? <ShareRowAction useHost={useShareGrantRowPresentation} label={t('shareSheet.documents.privateChoices.letViewersPick')}
                                testID={`${context.idPrefix}document-share-private-viewer:${choice.id}`}
                                onPress={choice.letViewersPick} disabled={!context.editable || input.readOnly || choice.loading} /> : null}
                            {choice.removeChoice ? <ShareRowAction useHost={useShareGrantRowPresentation} label={t('shareSheet.documents.privateChoices.removeChoice')}
                                testID={`${context.idPrefix}document-share-private-remove:${choice.id}`}
                                onPress={choice.removeChoice} disabled={!context.editable || input.readOnly || choice.loading} /> : null}
                        </View> } : {}) };
                }) }] : [])];
            const notices: SelectionListOption[] = [];
            if (input.loading) notices.push({ id: 'loading', label: t('common.loading'), loading: true, disabled: true });
            const issue = input.issue;
            if (issue) notices.push({ id: 'issue', label: issue.message, onSelect: issue.retryable ? input.retryContent : undefined,
                ...(issue.retryable ? { subtitle: t('common.retry') } : {}) });
            if (input.notice) notices.push({ id: 'notice', label: input.notice.message, disabled: true });
            if (input.readOnly) notices.push({ id: 'read-only', label: t('shareSheet.documents.errors.ownerOnly'), disabled: true });
            return { ...(leading.length ? { leading } : {}),
                ...(notices.length ? { trailing: [{ kind: 'static' as const, id: 'status', options: notices }] } : {}) };
        },
    };
}
