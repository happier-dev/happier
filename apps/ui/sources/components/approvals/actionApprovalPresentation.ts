import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readContributedActionReviewV1 } from '@happier-dev/protocol/actions/contributedActionReviewV1';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { ActionIdSchema, REGISTRY_SOURCE_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { PROVIDER_CONNECTION_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/providers/providerActionIdsV1';
import { buildApprovalPreviewSummary, readTeamCredentialApprovalSources } from '@happier-dev/protocol/actions/actionExecutor';
import { describeApprovalActionFields, readTeamMemberApprovalPresentation, type ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveActionConfirmVerb, resolveActionSummary, resolveActionTitle, resolveBotDraftActionTitle } from '@/text/actionTitles';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text/i18n';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WidgetLayoutFragmentActionIdV1Schema, readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentLocalServiceControlApproval, readLocalServiceControlSubject } from './localServiceControlApprovalPresentation';
import type { ApprovalRequest, StoredApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DiscussionPostInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { isDiscussionPostActionIdV1, type DiscussionExternalSourceV1 } from '@happier-dev/protocol/discussions';
import { SettingsDeclarationActionInputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getNewSessionDraftActionIdentity } from '@/components/sessions/new/hooks/useNewSessionDraftPresentation';

export type ActionApprovalPresentationInput = Readonly<{
    actionId: string;
    /** Immediate product consent names the operation; retained requests keep their approval verb. */
    kind?: 'confirmation';
    actionArgs?: unknown;
    status?: ApprovalRequest['status'];
    preview?: unknown;
    authoredTitle?: string | null;
    authoredSummary?: string | null;
    subject?: string | null;
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1'];
    incomingDiscussionNames?: IncomingDiscussionApprovalNames;
    role?: RoleCatalogEntry | null;
    /** The target Machine's readable path form (home-relative), when the presenting app knows its home. */
    formatPath?: ((path: string) => string) | null;
}>;

/** Public presentation facts for the integration named by this incoming message. */
export type IncomingDiscussionApprovalNames = Readonly<{
    providerPluginId: string;
    providerName: string | null;
    ownerName: string | null;
}>;

/** Readable imported provenance exists before publication; private routing is never a label. */
export function readIncomingDiscussionApprovalSource(input: Readonly<{ actionId?: string | null; actionArgs?: unknown }>): DiscussionExternalSourceV1 | null {
    if (!isDiscussionPostActionIdV1(input.actionId ?? '')) return null;
    const parsed = DiscussionPostInputV1Schema.safeParse(input.actionArgs);
    return parsed.success && 'externalSource' in parsed.data.content ? parsed.data.content.externalSource ?? null : null;
}

export type ApprovalSummaryInput = Readonly<{ actionId: string; actionArgs: unknown;
    executionOriginV1?: StoredApprovalRequestV2['executionOriginV1'] }>;

/** A supplied request summary reads through its domain owner; absent previews remain absent. */
export function readApprovalPreviewSummary(preview: unknown, request?: ApprovalSummaryInput, subject?: string | null): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const storedSummary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    if (!storedSummary) return null;
    const actionId = request ? ActionIdSchema.safeParse(request.actionId) : null;
    if (actionId?.success) {
        // The library owner captured this name before the mutation. Raw delete
        // operands contain only an id and cannot re-derive that description.
        if (WidgetLayoutFragmentActionIdV1Schema.safeParse(actionId.data).success
            && 'widgetLibraryName' in preview && typeof preview.widgetLibraryName === 'string' && preview.widgetLibraryName.trim()) return storedSummary;
        const spec = getActionSpec(actionId.data);
        if (readWidgetApprovalPresentationV1(preview) || readTeamCredentialApprovalSources(preview).length) return presentActionApproval({ actionId: actionId.data,
            actionArgs: request?.actionArgs, preview }).summary;
        const summary = spec.approvalPresentation && (spec.inputSchema.safeParse(request?.actionArgs).success
            || spec.approvalPresentation.inputSchema?.safeParse(request?.actionArgs).success)
            ? spec.approvalPresentation?.summary?.(request?.actionArgs) ?? null : null;
        return presentActionApproval({ actionId: actionId.data, actionArgs: request?.actionArgs,
            authoredSummary: summary || storedSummary, subject }).summary;
    }
    return storedSummary;
}

/** Only the Account override Actions name an Account catalog Role. */
export function readActionApprovalRoleId(input: ActionApprovalPresentationInput): string | null {
    if (input.actionId !== 'roles.override.set' && input.actionId !== 'roles.override.reset') return null;
    const parsed = RoleActionInputSchemasV1[input.actionId].safeParse(input.actionArgs);
    return parsed.success ? parsed.data.roleId : null;
}

/** The existing Protocol reference projection owns subject identity, never a caller's id guess. */
export function readActionApprovalSubject(input: ActionApprovalPresentationInput): ApprovalActionReference | undefined {
    // The captured admission already names both operands; do not issue a second principal lookup.
    if (input.actionId === 'teams.members.add' && readTeamMemberApprovalPresentation(input.preview, input.actionArgs)) return undefined;
    const serviceControl = readLocalServiceControlSubject(input);
    if (serviceControl) return serviceControl;
    const references = describeApprovalActionFields({ ...input, actionArgs: input.actionArgs }).rows.flatMap(row => row.kind === 'value'
        ? [...(row.reference ? [row.reference] : []), ...(row.entries?.flatMap(entry => entry.reference ? [entry.reference] : []) ?? [])]
        : []);
    // A workspace-sync request is titled by its Action; its controller machine and linked folders read in Details.
    if (input.actionId.startsWith('workspace.sync.')) return undefined;
    if (input.actionId === 'scm.diffSummary.result.clear' && input.executionOriginV1?.machineId) {
        return { kind: 'machine', id: input.executionOriginV1.machineId };
    }
    // The Home only routes the request: the thing acted on (a Machine, a Session, a person) is the subject when there
    // is one, before the Group and then the Team it happens in.
    const rank = (reference: ApprovalActionReference) => reference.kind === 'home' ? 3
        : reference.kind === 'team' ? 2 : reference.kind === 'group' ? 1 : 0;
    return references.reduce<ApprovalActionReference | undefined>(
        (best, reference) => best === undefined || rank(reference) < rank(best) ? reference : best, undefined);
}

/** Shared by immediate confirmation and retained decisions without rebuilding the consequence body. */
export function readActionApprovalConfirmLabel(actionId: string): string | null {
    const parsed = ActionIdSchema.safeParse(actionId);
    if (!parsed.success) return null;
    if (parsed.data === 'scm.diffSummary.result.clear') return t('walkthroughSettings.clear');
    if (parsed.data === REGISTRY_SOURCE_DELETE_ACTION_ID_V1) return t('capabilities.registries.detail.remove');
    if (parsed.data === PROVIDER_CONNECTION_DELETE_ACTION_ID_V1) return t('common.remove');
    const verb = getActionSpec(parsed.data).confirmVerb;
    return verb === undefined ? null : resolveActionConfirmVerb(verb);
}

/** The draft a New Session draft Action targets (by `draftId`, or a `newSession` composer ref), read through its identity owner. */
function readNewSessionDraftActionIdentity(actionId: string, actionArgs: unknown) {
    if (resolveBotDraftActionTitle(actionId) === null || !actionArgs || typeof actionArgs !== 'object') return null;
    const args = actionArgs as { draftId?: unknown; ref?: { kind?: unknown; draftId?: unknown } };
    const draftId = typeof args.draftId === 'string' ? args.draftId
        : args.ref?.kind === 'newSession' && typeof args.ref.draftId === 'string' ? args.ref.draftId : null;
    return draftId ? getNewSessionDraftActionIdentity(getActiveServerAccountScope(), draftId, actionId === 'session.draft.delete') : null;
}

/** One UI copy boundary for confirmation, Inbox, page and preview; authored plugin copy stays authored. */
export function presentActionApproval(input: ActionApprovalPresentationInput): Readonly<{ title: string | null; summary: string | null; confirmLabel: string | null; destructive?: boolean }> {
    const serviceControl = presentLocalServiceControlApproval({ actionId: input.actionId, actionArgs: input.actionArgs, subject: input.subject });
    const parsed = ActionIdSchema.safeParse(input.actionId);
    if (!parsed.success) {
        const title = input.authoredTitle?.trim() || input.actionId.trim() || null;
        return { title, summary: input.authoredSummary?.trim() || null, confirmLabel: input.kind === 'confirmation' ? title : null };
    }
    const spec = getActionSpec(parsed.data);
    // A pressed contribution is named by its own declaration (title, verb), never the generic host Action.
    const contributed = spec.id === 'action.invoke' ? readContributedActionReviewV1(input.preview) : null;
    if (contributed) {
        const verb = contributed.confirmVerb === undefined ? '' : resolvePluginLocalizedStringV2Text(contributed.confirmVerb).trim();
        return { title: contributed.title, summary: contributed.description ?? null,
            confirmLabel: verb || (input.kind === 'confirmation' ? contributed.title : resolveActionConfirmVerb(undefined)) };
    }
    if (spec.id === 'settings.invoke') {
        const operation = SettingsDeclarationActionInputSchemasV1['settings.invoke'].safeParse(input.actionArgs);
        const credential = operation.success ? operation.data.input : null;
        if (credential?.kind === 'voice_saved_secret'
            && (credential.operation === 'bind' || credential.operation === 'remove')) {
            const removing = credential.operation === 'remove';
            const title = t(removing ? 'settingsVoice.local.voiceCredential.deleteTitle'
                : 'settingsVoice.local.voiceCredential.useSavedSecretTitle');
            return { title, summary: null, confirmLabel: input.kind === 'confirmation'
                ? removing ? t('common.remove') : title : t('approvals.approve') };
        }
    }
    // Create names a new machine, not its routing Home. The review owner projects the same name for pending and retained asks.
    const createdMachineName = spec.id === 'machines.managed.acquire'
        ? describeApprovalActionFields({ actionId: spec.id, actionArgs: input.actionArgs, status: input.status }).rows
            .find(row => row.kind === 'value' && row.path === 'name') : undefined;
    const teamMember = spec.id === 'teams.members.add'
        ? readTeamMemberApprovalPresentation(input.preview, input.actionArgs) : null;
    const subject = teamMember ? `${teamMember.accountName} · ${teamMember.teamName}`
        : createdMachineName?.kind === 'value' ? createdMachineName.value : input.subject;
    const confirmLabel = readActionApprovalConfirmLabel(spec.id)
        ?? (input.kind === 'confirmation' ? resolveActionTitle(spec.id, spec) : resolveActionConfirmVerb(undefined));
    const incoming = readIncomingDiscussionApprovalSource(input);
    if (incoming) {
        const names = input.incomingDiscussionNames?.providerPluginId === incoming.providerPluginId ? input.incomingDiscussionNames : null;
        return { title: [t('session.collaboration.discussion.controls.incomingMessage'), names?.providerName,
            incoming.conversationDisplayName, names?.ownerName].filter(Boolean).join(' · '),
            summary: null, confirmLabel };
    }
    if (spec.id === REGISTRY_SOURCE_DELETE_ACTION_ID_V1) {
        return {
            title: t('actionPresentation.title', { actionId: spec.id,
                source: t('capabilities.registries.detail.remove'), subject }),
            summary: t('capabilities.registries.detail.removeConfirm'),
            confirmLabel,
        };
    }
    // Removing someone from a Group asks about that person and says what they lose; Details name the Group.
    if (spec.id === 'teams.groups.members.remove') {
        return {
            title: input.kind === 'confirmation'
                ? input.subject?.trim() ? t('teams.groups.removeMemberTitle', { name: input.subject.trim() }) : t('teams.groups.removeNative')
                : t('actionPresentation.title', { actionId: spec.id, source: t('teams.groups.removeNative'), subject }),
            summary: t('teams.groups.removeMemberBody'),
            confirmLabel,
            destructive: true,
        };
    }
    // Removing a provider says one verb everywhere: its menu row ("Remove provider"), this title and its button.
    if (spec.id === PROVIDER_CONNECTION_DELETE_ACTION_ID_V1) {
        return {
            title: t('actionPresentation.title', { actionId: spec.id, source: t('settingsProviders.detail.deleteTitle'), subject }),
            summary: t('settingsProviders.detail.deleteDescription'),
            confirmLabel,
            destructive: true,
        };
    }
    if (spec.id === 'scm.diffSummary.result.clear' && spec.inputSchema.safeParse(input.actionArgs).success) {
        return {
            title: t('walkthroughSettings.clearTitle'),
            summary: t('walkthroughSettings.clearDescription', { machine: input.subject?.trim() || t('machine.thisMachineInSentence') }),
            confirmLabel,
            ...(spec.irreversible ? { destructive: true } : {}),
        };
    }
    if (serviceControl) return { ...serviceControl, confirmLabel, destructive: spec.irreversible === true };
    const role = input.role?.roleId === readActionApprovalRoleId(input) ? input.role : null;
    const roleKind = role ? role.source === 'built_in' ? t('roles.settings.sourceBuiltIn')
        : role.source === 'user' ? t('roles.settings.sourceYours')
        : role.source === 'shared' ? t('roles.settings.sourceShared') : t('roles.settings.groupPlugins') : null;
    const roleIdentity = role && roleKind ? { name: role.role.name, kind: roleKind } : undefined;
    const english = getPreferredLanguage() === 'en';
    // A draft Action names its draft by the draft's own identity: a Bot draft reads as one, a named draft by its
    // name (QA-RERUN-1113 F5; COPY-NOUN-HUNT-1113 open, folder and model).
    const draft = readNewSessionDraftActionIdentity(spec.id, input.actionArgs);
    const draftSubject = draft?.subject;
    const botDraftTitle = draft?.isBot ? resolveBotDraftActionTitle(spec.id) : null;
    const titleSource = botDraftTitle ?? (roleIdentity || !english ? resolveActionTitle(spec.id, spec) : spec.title);
    const widgetPresentation = readWidgetApprovalPresentationV1(input.preview);
    let canonicalCopySummary: string | null = null;
    const summarySource = buildApprovalPreviewSummary(spec, input.actionArgs, {
        ...(input.formatPath ? { formatPath: input.formatPath } : {}), ...(widgetPresentation ? { widgetPresentation } : {}),
        teamCredentialSources: readTeamCredentialApprovalSources(input.preview),
        ...(teamMember ? { teamMemberPresentation: teamMember } : {}),
        formatSessionVisualCopySummary: summary => {
            canonicalCopySummary = summary.source;
            return t('actionPresentation.sessionVisualCopySummary', summary);
        },
    });
    const authoredSummary = input.authoredSummary?.trim();
    // An Action's declared description tells an agent how to call it; it is never the person's review copy,
    // even when a receiver carries it as its summary. The person reads `approvalPresentation.summary` and facts.
    const agentInstructions = authoredSummary === spec.description?.trim() || authoredSummary === spec.inputHints?.description?.trim();
    const distinctAuthoredSummary = authoredSummary && !agentInstructions && authoredSummary !== summarySource
        && authoredSummary !== canonicalCopySummary ? authoredSummary : null;
    const summary = distinctAuthoredSummary ? distinctAuthoredSummary
        : t('actionPresentation.summary', { actionId: spec.id,
            source: summarySource === `${spec.title}.` ? `${titleSource}.`
                : english ? summarySource : resolveActionSummary(spec.id, summarySource), subject, role: roleIdentity });
    const visibleSummary = teamMember && !distinctAuthoredSummary ? null
        : !distinctAuthoredSummary && summarySource === `${spec.title}.`
        && (summary === titleSource || summary === `${titleSource}.`) ? null : summary;
    // Backup authority follows the Action into both confirmation and Inbox, including authored previews.
    const disclosure = spec.id === 'relay.runtime.personal_home.backup' ? t('personalHome.settings.backupDisclosureBody') : null;
    const title = t('actionPresentation.title', { actionId: spec.id, source: titleSource,
        subject: roleIdentity ? `${roleIdentity.name} · ${roleIdentity.kind}` : subject ?? draftSubject ?? null });
    return {
        confirmLabel,
        title,
        summary: disclosure ? [visibleSummary, disclosure].filter(Boolean).join('\n\n') : visibleSummary,
        ...(spec.irreversible ? { destructive: true } : {}),
    };
}
