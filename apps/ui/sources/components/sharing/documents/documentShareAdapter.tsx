import type { ArtifactAccessGrantRowV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { classifyArtifactBrowserKind } from '@/components/artifacts/artifactBrowserModel';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { ShareAccessLevel, ShareLevelPresentation, ShareSheetAdapter, ShareUiError, ShareUiReason } from '../shareSheetTypes';
import { ShareRowAction } from '../ShareGrantRow';

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
    if (kind === 'widget-area-layout.v1') return t('shareSheet.documents.levels.canRead');
    const browserKind = classifyArtifactBrowserKind({ id: artifactId, header: kind === null ? null : { title: null, kind } });
    return browserKind === 'document' || browserKind === 'board'
        ? t('shareSheet.documents.levels.canRead')
        : t('shareSheet.documents.levels.canUse');
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
    grants: readonly ArtifactAccessGrantRowV1[];
    privateChoices?: readonly DocumentPrivateChoice[];
    linkPath?: string;
    sendCopy?: () => void;
    loading: boolean;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    readOnly: boolean;
    retryContent(): void;
}>): ShareSheetAdapter & Readonly<{ levels: Readonly<Record<ShareAccessLevel, ShareLevelPresentation>> }> {
    return {
        namespace: 'document-share',
        title: t('shareSheet.documents.title'),
        levels: {
            view: { label: documentViewLabel(input.artifactId, input.kind), help: documentUseHelp(input.artifactId, input.kind) },
            edit: { label: t('shareSheet.documents.levels.canEdit'), help: t('shareSheet.documents.help.editForEveryone') },
            admin: { label: t('shareSheet.documents.levels.admin'), help: t('shareSheet.documents.help.adminOwnerShares') },
        },
        notes: documentShareNotes(input.kind, input.grants),
        ...(input.linkPath && input.kind !== 'widget-area-layout.v1' ? { linkPath: input.linkPath } : {}),
        ...(input.sendCopy ? { sendCopy: input.sendCopy } : {}),
        sections: (context) => {
            const choices = input.privateChoices ?? [];
            const leading = choices.length ? [{ kind: 'static' as const, id: 'private-choices',
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
                        ...(hasRepairs ? { onSelect: () => context.onExpand(choice.id), expandedContent: () => <View>
                            {choice.letViewersPick ? <ShareRowAction label={t('shareSheet.documents.privateChoices.letViewersPick')}
                                testID={`${context.idPrefix}document-share-private-viewer:${choice.id}`}
                                onPress={choice.letViewersPick} disabled={!context.editable || input.readOnly || choice.loading} /> : null}
                            {choice.removeChoice ? <ShareRowAction label={t('shareSheet.documents.privateChoices.removeChoice')}
                                testID={`${context.idPrefix}document-share-private-remove:${choice.id}`}
                                onPress={choice.removeChoice} disabled={!context.editable || input.readOnly || choice.loading} /> : null}
                        </View> } : {}) };
                }) }] : undefined;
            const notices: SelectionListOption[] = [];
            if (input.loading) notices.push({ id: 'loading', label: t('common.loading'), loading: true, disabled: true });
            const issue = input.issue;
            if (issue) notices.push({ id: 'issue', label: issue.message, onSelect: issue.retryable ? input.retryContent : undefined,
                ...(issue.retryable ? { subtitle: t('common.retry') } : {}) });
            if (input.notice) notices.push({ id: 'notice', label: input.notice.message, disabled: true });
            if (input.readOnly) notices.push({ id: 'read-only', label: t('shareSheet.documents.errors.ownerOnly'), disabled: true });
            return { ...(leading ? { leading } : {}),
                ...(notices.length ? { trailing: [{ kind: 'static' as const, id: 'status', options: notices }] } : {}) };
        },
    };
}
